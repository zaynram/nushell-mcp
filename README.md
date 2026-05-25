# nushell-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Nushell](https://www.nushell.sh). It gives an AI model three things:

- **(a) Queryable documentation** — search and read help for any installed `nu` command.
- **(b) An execution environment** — run one-shot `nu` pipelines and get *structured* data back, not just text.
- **(c) Persistent REPL sessions** — long-lived `nu` shells that retain `cd`, `let`, and env state across calls, addressable by name.

It is the spiritual successor to `terminal-mcp` (lineage: `winterm-mcp`) and
lives in the same repository, renamed. Where that server exposed a generic
"run a command in a Windows shell" surface, this one is scoped to Nushell
specifically and trades raw shell access for structure-aware execution, a
documentation lookup the model can consult before it runs anything, and a
named-REPL pool when stateful work is the right tool.

## Tools

Twelve tools, grouped by purpose.

### Execution (one-shot)

| Tool | Purpose |
|------|---------|
| `nu_exec` | Evaluate a Nushell pipeline in a fresh `nu` process; returns rendered output, the final value as **NUON**, and its type. Accepts an `input` dataset piped in as `$in`, and an optional `bashEnv` snippet whose exported vars are merged into nu's env for the call. |
| `nu_exec_abort` | Cancel every in-flight `nu_exec` call. Leaves REPL buckets and the doc singleton alone. |

### Documentation

| Tool | Purpose |
|------|---------|
| `nu_doc_search` | Search installed commands by name, description, and search terms. |
| `nu_doc_help` | Full help for one command; returns `found` plus `help`, and includes `suggestions` on a miss. |

### REPL buckets (persistent)

A bucket is a long-lived `nu --mcp` child addressed by a name (regex `[A-Za-z0-9_-]+`). State — `cd`, `let`, env mutations — persists within a bucket; buckets are isolated from each other.

| Tool | Purpose |
|------|---------|
| `nu_repl_spawn` | Start a new REPL bucket under the given key. Errors if the key is taken or the pool is at capacity. |
| `nu_repl_list` | List active bucket keys. |
| `nu_repl_kill` | Kill one bucket and free its key. |
| `nu_repl_nuke` | Kill every active bucket. |
| `nu_repl_write` | Run a pipeline inside a bucket; the bucket's session state persists. |
| `nu_repl_read` | Read the bucket's most-recent response without re-running anything. |
| `nu_repl_clear` | `mode: "buffer"` empties the bucket's response ring; `mode: "all"` kills and respawns the bucket (wipes session state). |
| `nu_repl_status` | Best-effort snapshot: cwd, history index, last response timestamp, and live env keys. |

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [Nushell](https://www.nushell.sh) on `PATH`, **built with `--features mcp`** (Nushell ≥ 0.112). The REPL pool talks to `nu --mcp` over JSON-RPC; the feature is not in the default build yet. The server **detects and reports the installed version at runtime** — no Nushell version is hardcoded anywhere (see [Versioning](#versioning)).

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
| `NUSHELL_MCP_TIMEOUT_MS` | `30000` | Default per-call timeout for `nu_exec`; the tool's `timeoutMs` argument overrides it per call. |
| `NUSHELL_MCP_MAX_REPLS` | `10` | Cap on simultaneous REPL buckets. `nu_repl_spawn` errors past this. |
| `NUSHELL_MCP_BASH_PATH` | (auto-probe: WSL → Git Bash → `bash`) | Override the bash runner used by `nu_exec`'s `bashEnv`. |

## Design decisions

### Documentation source: the in-process `nu --mcp` singleton

`nu_doc_search` and `nu_doc_help` source their content from Nushell's
in-process command metadata via the `nu --mcp` singleton — specifically its
`list_commands` and `command_help` tools — **not** the online docs corpus at
`nushell.sh`. Rationale:

- **Version-accurate.** The help text always matches the *installed* `nu`, so
  the model never reads flags or examples that don't exist locally.
- **Offline and low-latency.** Every query routes through a process-wide
  `nu --mcp` singleton — no per-call spawn, no network fetch, no corpus to
  cache.
- **Already structured.** `list_commands` returns parseable plaintext entries;
  `command_help` carries signatures and examples — which maps cleanly onto MCP
  structured output with no scraping.

The trade-off is that conceptual prose (the topical *guides* on the website)
is not covered — only per-command reference. For an agent that consults docs
to drive `nu_exec`, per-command reference is the higher-value half, and it is
the half that must stay version-accurate.

`nu_doc_search` delegates matching to the installed `nu --mcp`'s
`list_commands --find <query>` and slices the result to `limit` (default 50).
Match semantics are whatever upstream `nu` does there — we do not tokenize
or re-rank on the TS side. When `nu_doc_help` misses, it returns
`suggestions` — separator-insensitive near matches, so a jammed-together
guess like `strjoin` still surfaces `str join`.

### Versioning

Nothing in this server hardcodes a Nushell version. The installed version is
detected once at startup (`version | get version`) and memoized, but is not
currently attached to every `nu_doc_*` response. Documentation results always
reflect the `nu` actually on the machine because they are sourced directly from
its in-process command metadata.

### Session model: one-shot by default, REPL buckets when state must survive

`nu_exec` runs each call in a **fresh, one-shot `nu` process** — no shell
state survives. Rationale:

- Concurrent one-shot calls are independent and cannot interfere.
- Nushell's value proposition is the self-contained *pipeline*. State that
  needs to survive (a directory, an env var, a dataset) is better passed
  explicitly per call than implied by hidden session state.

Consequences, and how they are handled for `nu_exec`:

- **Working directory** — pass `cwd` per call (defaults to the server's CWD).
- **Environment** — pass `env` per call; it extends the server's environment unless `cleanEnv: true` replaces it. For dynamic shell setup (`source ~/.profile`, `nvm use`, etc.) pass a `bashEnv` snippet — the server runs it through bash, diffs exported vars against baseline, and merges the delta into nu's env for that one call.
- **Carrying data between calls** — pass `input` (see below) instead of relying on session state.
- **Timeout / cancellation** — each call is killed after `timeoutMs`
  (default 30 s); `nu_exec_abort` terminates anything still running. A killed
  call reports `timedOut: true`.

**When one-shot is the wrong fit**, the REPL pool fills the gap. `nu_repl_spawn` starts a long-lived `nu --mcp` child under a named key; subsequent `nu_repl_write` calls reuse it. `cd foo` survives. `let x = 42` survives. Env mutations survive — within that bucket. Different buckets share nothing, and the pool caps simultaneous buckets at `NUSHELL_MCP_MAX_REPLS` (default 10). The pool serializes calls *within* a bucket (one bucket = one in-flight pipeline at a time) but runs *across* buckets in parallel — concurrent work on two buckets does not queue.

### Structured output: NUON, not JSON

A plain shell MCP collapses everything to text. `nu_exec` instead wraps the
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

`nu_exec` accepts an optional `input` — NUON or JSON text (`from nuon` parses
both) — which is piped into the pipeline as `$in`. This lets the model
transform a dataset it already holds without embedding it as a code literal:

```
input:    [{"name": "a", "size": 5}, {"name": "b", "size": 9}]
pipeline: where size > 6 | get name
→ nuon:   [b]
```

## On the deferred `explore` integration

The original brief floated a third capability: wrapping Nushell's built-in
`explore` command together with its in-TUI `:try` command-runner to work with
data "in natural language while still having a UI for readability."

**The literal `explore` integration is deferred — by design.** `explore` is a
full-screen **TUI table pager** (it is `less` for structured data). It requires
an interactive terminal — raw-mode keyboard input, an alternate screen buffer,
a TTY. An MCP server communicates over stdio with line-delimited JSON-RPC;
there is no terminal to render into and no channel for interactive keystrokes.
Driving `explore` across the MCP boundary is not possible.

**Its spirit, however, is delivered — by `nu_exec` plus the REPL pool.**
`explore`'s value is two things, both now covered:

- The **`:try` command-runner** — "feed in a dataset, apply a transform, see
  the result, iterate" — is exactly `nu_exec` with the `input` parameter, or
  for a multi-step session, a `nu_repl_*` bucket that holds the dataset in a
  `let` binding across iterations.
- The **readable UI** is covered because every execution call returns both a
  rendered table (`stdout`) and a precise machine form (`nuon` + `resultType`)
  — readable for a human reviewing the transcript, exact for the model.

The interaction model the brief described is reimagined as `input` + structured
output on capability (b), plus the REPL pool for the multi-turn case. A literal
TUI is the only part left out, and that part is genuinely infeasible here.

## Development

```bash
bun test          # smoke tests for capabilities (a), (b), (c) + MCP wiring
bun run build     # bundle to build/index.js
bunx tsc --noEmit # type-check
```

`test/smoke.test.ts` exercises version detection, the documentation queries,
one-shot execution, and the REPL bucket lifecycle directly, and boots the
server over stdio to confirm all twelve tools register. The REPL-pool tests
require `nu` built with `--features mcp`.

## License

MIT — see [LICENSE](LICENSE).
