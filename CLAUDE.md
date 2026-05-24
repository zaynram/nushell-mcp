# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                       # install dependencies (Bun ≥ 1.3 required)
bun run start                     # run the MCP server over stdio
bun test                          # run the smoke test suite
bun test test/smoke.test.ts -t "<name pattern>"   # run a single test by name
bun run build                     # bundle to build/index.js (bun build, --target=bun)
bunx tsc --noEmit                 # type-check only (no emit; build/ is .gitignored)
```

`bun test` requires `nu` on `PATH` (built `--features mcp` for the REPL-pool tests) because nearly every test shells out to a real Nushell subprocess. The `bashEnv` tests in `test/smoke.test.ts` self-skip when no bash runtime is detected — they are not failures.

## Architecture

Six source files, split by concern:

- **`src/index.ts`** — MCP wiring only. Registers 12 tools against `@modelcontextprotocol/sdk`, connects a `StdioServerTransport`, and delegates every operation to `nu.ts` / the REPL pool. Do not put subprocess logic here. The tools:
  - `nu_exec`, `nu_exec_abort` — one-shot pipeline execution + cancellation.
  - `nu_doc_search`, `nu_doc_help` — documentation queries.
  - `nu_repl_spawn`, `nu_repl_list`, `nu_repl_kill`, `nu_repl_nuke` — REPL bucket lifecycle.
  - `nu_repl_write`, `nu_repl_read`, `nu_repl_clear`, `nu_repl_status` — interaction with a named REPL bucket.
- **`src/nu.ts`** — Nushell subprocess layer for one-shots and the bash bridge: spawn/timeout/cancellation, version detection, doc queries (`searchDocs`, `getCommandDoc`), pipeline execution (`runPipeline`, `runRaw`), `abortExec`, `killAll`. Tests import this module directly.
- **`src/nuMcpClient.ts`** — `NuMcpChild` wraps a long-lived `nu --mcp` child: line-delimited JSON-RPC over stdio, request id/response pairing, `onExit` listener fan-out, idempotent `kill`.
- **`src/nuMcpPool.ts`** — `NuMcpPool`, the Map-backed registry of REPL `NuMcpChild` buckets keyed by sanitized name. Owns the per-bucket `Mutex` (serializes calls to one bucket; parallel across buckets), the head-first ring buffer of recent responses, the cached `evaluate` envelope (cwd / history_index / timestamp), and the `clear("all")` kill-and-respawn path. Capped by `NUSHELL_MCP_MAX_REPLS` (default 10). The process-wide singleton is `getReplPool()`.
- **`src/active.ts`** — Owns the `active` Map of every spawned subprocess and the `ActiveRole` string union (`"doc" | "repl" | "exec" | "bash"`). `addActive` / `removeActive` are the only mutators. Filtering on role drives the "every spawned subprocess must be in `active`" invariant — `killAll` / `abortExec` / `nu_exec_abort` walk the map by role tag. Extracted into its own file to avoid an import cycle between `nu.ts` and `nuMcpClient.ts`.
- **`src/mutex.ts`** — `Mutex` with FIFO ordering via a single promise-chain handle. `acquire()` returns a release callback that's idempotent (double-release is a no-op). The "extend the chain before awaiting prev" pattern is what guarantees FIFO — see the inline comment. Used by `NuMcpPool` per-bucket; could be used anywhere serialization-without-a-real-lock is needed.

The split exists so the test suite can exercise capabilities without booting MCP, and so the MCP layer stays a thin translation of tool schemas → `nu.ts` / pool calls.

### Execution model: one-shot for `nu_exec`, persistent for `nu_repl_*`

`nu_exec` spawns a fresh `nu` process per call — no session state survives. Cross-call state lives in **named REPL buckets** owned by `NuMcpPool`: `nu_repl_spawn` starts a long-lived `nu --mcp` child, subsequent `nu_repl_write` calls reuse it, `cd` / `let` / env mutations persist within that bucket only, and `nu_repl_kill` (or `nu_repl_clear` with `mode: "all"`) tears it down. Different buckets are isolated; `nu_repl_nuke` kills every bucket at once.

The one-shot bash bridge still exists for `nu_exec`: a `bashEnv` snippet runs through a probed runtime (WSL → Git Bash → `bash`, override via `NUSHELL_MCP_BASH_PATH`), captures exported vars as a delta against baseline, and merges them into nu's env for that call only.

Preserve these contracts: `nu_exec` stays stateless; any new state-carrying feature must live in the REPL pool (or be opt-in via an explicit parameter on `nu_exec`).

### REPL pool invariants (`nuMcpPool.ts`)

- **Serialization**: `pool.call(key, ...)` acquires the bucket's `Mutex` and releases it in `finally`; concurrent calls to the same key queue, concurrent calls to different keys run in parallel. The `nu_repl_*` tools all flow through `pool.call`, so a thrown / rejected JSON-RPC response cannot leak the lock.
- **Crash policy**: `NuMcpChild.onExit` listeners fire whether the child died on its own or was killed via `kill()` (idempotent — `fireExit` clears listeners on first call). The pool subscribes in `spawn()` and prunes the bucket from the map when the child dies. `clear("all")` exploits this: synchronous `kill()` → `spawn()` on the same key is safe because JS is single-threaded and the same-tick continuation re-registers the new entry before any other caller can observe a missing key.
- **Envelope cache**: only updated on successful `evaluate` responses via `parseEvaluateEnvelope`. Field-by-field merge — non-envelope tool responses (`list_commands`, `command_help`) leave the cache untouched.
- **Side-channel probe**: `status(key)` invokes `evaluate` with `$env | columns` to read live env keys. That probe increments the bucket's `history_index`, so callers should treat `envKeys` as best-effort, not free.

### Structured output: NUON, not JSON

`runPipeline` wraps the user pipeline in a generated script (`buildScript` in `nu.ts`) that captures the final value as **NUON** (`to nuon --serialize`) plus its `describe` type, written to temp files and read back by the TS layer. NUON is preferred over JSON because it preserves Nushell-native types (filesizes, durations, datetimes, closures). `structured: false` / `noCapture: true` skips this wrap but still routes through `runPipeline` so `input` and `bashEnv` keep working — do not shortcut back to `runRaw` for those calls (regression covered by `test/smoke.test.ts`).

### Script construction invariants (`buildScript`)

The generated nu script reads paths from env vars and snapshots them into immutable `let` bindings at script entry, so the user pipeline cannot redirect server-controlled reads/writes by mutating `$env`. The user pipeline runs inside a plain `do { ... }` block (no `--env`) — `nu_exec` is stateless, so leaking env mutations out is neither needed nor wanted. If you edit `buildScript`, preserve the immutable-path-snapshot property.

### Documentation source

`nu_doc_search` / `nu_doc_help` query Nushell's in-shell command metadata via the `nu --mcp` singleton — not the website. The current implementation routes through `list_commands` / `command_help` rather than `help commands` / `scope commands`, so keep this guidance aligned with those tool paths if the plumbing changes again. Results are version-accurate to the installed `nu`, but `nu_doc_*` responses do not currently include a `nushellVersion` field.

### Versioning

Nothing hardcodes a Nushell version. `getNuVersion()` detects once at startup and memoizes, but that version is not currently attached to every `nu_doc_*` response.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NUSHELL_MCP_NU_PATH` | first `nu` on `PATH` | Path to the `nu` binary. |
| `NUSHELL_MCP_TIMEOUT_MS` | `30000` | Default per-call timeout (one-shot `nu_exec`). |
| `NUSHELL_MCP_MAX_REPLS` | `10` | Cap on simultaneous REPL buckets in `NuMcpPool`. |
| `NUSHELL_MCP_BASH_PATH` | (auto-probe) | Override the bash runner used by `bashEnv`. |

## Conventions

- 4-space indentation in `src/nu.ts`, `src/index.ts`, `src/nuMcpClient.ts`; 2-space indentation in `src/nuMcpPool.ts` and `src/mutex.ts`. No semicolons at statement ends, double-quoted strings. Match the existing style in the file you're editing.
- TS is strict (`tsconfig.json`); `"types": ["node", "bun-types"]` — Bun-specific APIs (`Bun.spawn`, `Bun.file`, `Bun.write`, `Bun.which`) are used throughout. Don't reach for `node:child_process` when a `Bun.*` equivalent exists.
- All REPL bucket-name inputs must pass through `sanitizeKey` (regex `^[A-Za-z0-9_-]+$`) — keys are used as plain identifiers, no filesystem coupling remains.
- Every spawned subprocess (one-shot or long-lived) must be added to the `active` set with its `ActiveRole` tag so `killAll` / `abortExec` / `nu_exec_abort` can reach it.
