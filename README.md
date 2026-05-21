# nushell-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Nushell](https://www.nushell.sh). It gives an AI model two things:

- **(a) Queryable documentation** — search and read help for any installed `nu` command.
- **(b) An execution environment** — run `nu` pipelines and get *structured* data back, not just text.

It is the spiritual successor to `terminal-mcp` (lineage: `winterm-mcp`) and
lives in the same repository, renamed. Where that server exposed a generic
"run a command in a Windows shell" surface, this one is scoped to Nushell
specifically and trades raw shell access for structure-aware execution plus a
documentation lookup the model can consult before it runs anything.

## Tools

| Tool | Purpose |
|------|---------|
| `nu_run` | Evaluate a Nushell pipeline; returns rendered output, the final value as **NUON**, and its type. Accepts an `input` dataset piped in as `$in`. |
| `nu_kill` | Terminate every `nu` process the server currently has in flight. |
| `nu_doc_search` | Search installed commands by name, description, and search terms. |
| `nu_doc_command` | Full help for one command — text *and* structured metadata; suggests near matches on a miss. |

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [Nushell](https://www.nushell.sh) on `PATH`. The server **detects and reports
  the installed version at runtime** — no Nushell version is hardcoded
  anywhere (see [Versioning](#versioning)). Developed and tested against
  `nu` 0.111.

## Install

```bash
git clone https://github.com/zaynram/nushell-mcp.git
cd nushell-mcp
bun install
```

Run it directly with `bun run start`, or wire it into an MCP client.

## Client configuration

Add to your client's MCP server config — for Claude Desktop, that is
`%APPDATA%/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nushell-mcp": {
      "command": "bun",
      "args": ["C:\\Users\\ramda\\mcp-data\\nushell-mcp\\src\\index.ts"]
    }
  }
}
```

Adjust the path if the project lives elsewhere. The server speaks MCP over
**stdio**.

### Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `NUSHELL_MCP_NU_PATH` | first `nu` on `PATH` | Absolute path to the `nu` executable. |
| `NUSHELL_MCP_TIMEOUT_MS` | `30000` | Default per-call timeout; `nu_run`'s `timeoutMs` argument overrides it per call. |

## Design decisions

### Documentation source: the in-shell `help` system

`nu_doc_search` and `nu_doc_command` source their content from Nushell's
built-in `help commands` / `scope commands` system, **not** the online docs
corpus at `nushell.sh`. Rationale:

- **Version-accurate.** The help text always matches the *installed* `nu`, so
  the model never reads flags or examples that don't exist locally.
- **Offline and low-latency.** Every query is a local subprocess — no network
  fetch, no corpus to cache or keep fresh.
- **Already structured.** `help commands` returns a table; `scope commands`
  carries signatures and examples as structured data — which maps cleanly onto
  MCP structured output with no scraping.

The trade-off is that conceptual prose (the topical *guides* on the website)
is not covered — only per-command reference. For an agent that consults docs
to drive `nu_run`, per-command reference is the higher-value half, and it is
the half that must stay version-accurate.

`nu_doc_search` tokenizes the query on whitespace and scores each command by
how many tokens hit its name/description/search-terms (OR semantics, ranked).
This keeps recall high for natural multi-word queries like `parse json`. When
`nu_doc_command` misses, it returns `suggestions` — separator-insensitive near
matches, so a jammed-together guess like `strjoin` still surfaces `str join`.

### Versioning

Nothing in this server hardcodes a Nushell version. The installed version is
detected once at startup (`version | get version`), logged, and returned as
`nushellVersion` on every `nu_doc_*` response — so documentation results are
always self-describing and always reflect the `nu` actually on the machine.

### Session model: one-shot

`nu_run` runs each call in a **fresh, one-shot `nu` process** — there is no
persistent shell session. Rationale:

- A persistent session would have to serialize concurrent tool calls and risks
  deadlocking on state that never resets; one-shot calls are independent and
  cannot interfere.
- Nushell's value proposition is the self-contained *pipeline*. State that
  needs to survive (a directory, an env var, a dataset) is better passed
  explicitly per call than implied by hidden session state.

Consequences, and how they are handled:

- **Working directory** — pass `cwd` per call (defaults to the server's CWD).
- **Environment** — pass `env` per call; it extends the server's environment
  unless `cleanEnv: true` replaces it.
- **Carrying data between calls** — pass `input` (see below) instead of relying
  on session state.
- **Timeout / cancellation** — each call is killed after `timeoutMs`
  (default 30 s); `nu_kill` terminates anything still running. A killed call
  reports `timedOut: true`.

### Structured output: NUON, not JSON

A plain shell MCP collapses everything to text. `nu_run` instead wraps the
pipeline so a single `nu` invocation yields three things:

- `stdout` — the value rendered as Nushell's familiar table (human-readable).
- `nuon` — the same final value serialized with **`to nuon --serialize`**.
- `resultType` — the value's `describe` type, e.g. `table<a: int, b: int>`.

[NUON](https://www.nushell.sh/book/loading_data.html#nuon) (Nushell Object
Notation) is used in preference to JSON because it is **more concise** —
`[[a, b]; [1, 2], [3, 4]]` instead of `[{"a":1,"b":2},{"a":3,"b":4}]` — and
because it **preserves Nushell-native types** that JSON would flatten:
filesizes, durations, datetimes, and (with `--serialize`) even closures
survive the round trip. Set `structured: false` to skip the wrapper and run
raw `nu -c` instead.

### Feeding data in: the `input` parameter

`nu_run` accepts an optional `input` — NUON or JSON text (`from nuon` parses
both) — which is piped into the pipeline as `$in`. This lets the model
transform a dataset it already holds without embedding it as a code literal:

```
input:    [{"name": "a", "size": 5}, {"name": "b", "size": 9}]
pipeline: where size > 6 | get name
→ nuon:   [b]
```

## Capability (c): the `explore` integration

The original brief floated a third capability: wrapping Nushell's built-in
`explore` command together with its in-TUI `:try` command-runner to work with
data "in natural language while still having a UI for readability."

**The literal `explore` integration is deferred — by design.** `explore` is a
full-screen **TUI table pager** (it is `less` for structured data). It requires
an interactive terminal — raw-mode keyboard input, an alternate screen buffer,
a TTY. An MCP server communicates over stdio with line-delimited JSON-RPC;
there is no terminal to render into and no channel for interactive keystrokes.
Driving `explore` across the MCP boundary is not possible.

**Its spirit, however, is delivered — by `nu_run`.** `explore`'s value is two
things, and `nu_run` now provides both:

- The **`:try` command-runner** — "feed in a dataset, apply a transform, see
  the result, iterate" — is exactly `nu_run` with the `input` parameter. The
  model supplies data, applies a pipeline, reads back the transformed value,
  and refines. That *is* the `:try` loop, minus the full-screen UI.
- The **readable UI** is covered because every `nu_run` call returns both a
  rendered table (`stdout`) and a precise machine form (`nuon` + `resultType`)
  — readable for a human reviewing the transcript, exact for the model.

So capability (c) is not a missing feature: the interaction model it described
is reimagined as `input` + structured output on capability (b). A literal
TUI is the only part left out, and that part is genuinely infeasible here.

## Development

```bash
bun test          # smoke tests for capabilities (a) and (b) + MCP wiring
bun run build     # bundle to build/index.js
bunx tsc --noEmit # type-check
```

`test/smoke.test.ts` exercises version detection, the documentation queries,
and the execution environment directly, and boots the server over stdio to
confirm all four tools register.

## License

MIT — see [LICENSE](LICENSE).
