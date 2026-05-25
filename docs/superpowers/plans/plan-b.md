# Plan B — REPL pool atomically replacing file-backed `persistEnv`

**Status:** drafted, awaiting execution sign-off
**Prerequisite:** Plan A merged (introduces `NuMcpChild` + JSON-RPC primitives this plan layers on)
**Scope:** persistence subsystem swap + 8 new tools + 1 rename + 1 removal

---

## 1. Goal

Replace the file-backed `persistEnv` / `persistCwd` model with a process-resident REPL pool: one `nu --mcp` child per bucket key, holding live engine state (env, cwd, lets, defs, consts). State persists across calls within a bucket via upstream's forked-state-then-commit semantics; doesn't cross buckets. Atomically removes `~/.nushell-mcp/persist/` from the design — single persistence mode, no file-vs-process duality.

## 2. Non-goals

- `nu_exec` (renamed from `nu_run`) keeps its existing **one-shot subprocess** model. The pool is REPL-only; one-shots stay subprocess-per-call for isolation.
- `bashEnv` is unchanged on `nu_exec`. Not exposed on REPL tools (REPL has its own state mechanism; bashEnv would muddy it).
- No persistence of REPL state to disk. Buckets die with the server. (Future: snapshot/restore via `nu_repl_save` / `nu_repl_load` — out of scope.)
- No changes to `nu_doc_search` or `nu_doc_help` (Plan A territory).

## 3. Tool surface — final state after both plans

12 tools total. **Bold** = new in this plan. *Italic* = renamed in this plan. ~~Strike~~ = removed in this plan. Unmarked = unchanged or Plan A territory.

| # | Tool | Purpose |
|---|---|---|
| 1 | *`nu_exec`* | One-shot nu code (was `nu_run`) |
| 2 | **`nu_exec_abort`** | Abort all in-flight one-shot `nu_exec` calls |
| 3 | **`nu_repl_spawn`** | Create a new REPL bucket by key |
| 4 | **`nu_repl_write`** | Send nu code to a bucket; returns response |
| 5 | **`nu_repl_read`** | Return the last response from a bucket |
| 6 | **`nu_repl_clear`** | Reset a bucket's state (mode-driven) |
| 7 | **`nu_repl_list`** | List active bucket keys |
| 8 | **`nu_repl_status`** | Inspect a bucket (cwd, history_index, env keys) |
| 9 | **`nu_repl_kill`** | Kill one bucket's child |
| 10 | **`nu_repl_nuke`** | Kill all bucket children |
| 11 | `nu_doc_search` | (Plan A) |
| 12 | `nu_doc_help` | (Plan A) |
| ~~`nu_kill`~~ | | Removed — split into `nu_exec_abort` + `nu_repl_kill` + `nu_repl_nuke` |
| ~~`nu_persist_clear`~~ | | Removed — file-backed persist gone; use `nu_repl_clear` |
| ~~`nu_run`~~ | | Renamed to `nu_exec` |

Breaking changes for any external caller: `nu_run` rename, `nu_kill` removal, `nu_persist_clear` removal, removal of `persistEnv`/`persistKey`/`persistCwd` args from `nu_exec`. Acceptable per the pre-1.0 surface policy stated in Plan A.

## 4. Architecture

### 4.1 New module: `src/nuMcpPool.ts`

Manages the `Map<key, NuMcpChild>` of REPL buckets with per-bucket serialization.

```ts
import { NuMcpChild } from "./nuMcpClient.ts"

export type ReplStatus = {
    key: string
    spawnedAt: string         // ISO timestamp
    lastCallAt: string | null
    historyIndex: number      // from upstream's NUON envelope
    cwd: string               // captured from latest call's envelope
}

export type NuMcpPool = {
    spawn(key: string): Promise<void>                                       // errors if key exists
    has(key: string): boolean
    list(): string[]
    call(key: string, tool: string, args: object): Promise<NuMcpToolResponse>  // serialized per key
    lastResponse(key: string): NuMcpToolResponse | null                     // wrapper-side ring buffer head
    clearBuffer(key: string): void                                          // empties ring buffer; doesn't touch child
    status(key: string): Promise<ReplStatus>                                // sends a known evaluate; updates envelope cache
    kill(key: string): void                                                 // graceful term + force-kill; removes from map
    nukeAll(): void
}

export function getReplPool(): NuMcpPool      // process-wide singleton
```

**Internal contract**

- **Per-bucket Mutex**: `Map<key, Mutex>` parallel to the child map. `call(key, ...)` acquires the bucket's Mutex, performs JSON-RPC, releases. Cross-bucket calls run free.
- **Ring buffer**: per-bucket array of last N responses (default N=5; only the head is exposed by `lastResponse()` in v1; buffer is sized for future `back?: number` expansion).
- **Envelope cache**: each `evaluate` response is a NUON record with `cwd` / `history_index` / `timestamp`. `call()` extracts these on success and stashes them per bucket for `status()` to read without a roundtrip when possible.
- **Capacity limit**: `MAX_REPLS` (env `NUSHELL_MCP_MAX_REPLS`, default **10**). `spawn()` errors if exceeded.
- **Crash policy**: child exit between calls → bucket removed from map. Next access to that key errors with "bucket died". Caller must re-spawn. (No silent respawn — state loss must be visible.)
- **Key sanitization**: reuses `sanitizeKey()` — currently private in `nu.ts`. Prep Cycle 0 exports it so this module can import it.

### 4.2 `src/nuMcpClient.ts` — minor refactor

Plan A introduces `NuMcpChild` (lifecycle + JSON-RPC for one child) and `getNuMcpClient()` (singleton wrapper). Plan B reuses `NuMcpChild` directly for pool members; the Plan A singleton remains untouched and is still used by `nu_doc_search` / `nu_doc_help`.

If Plan A's implementation kept everything as a flat closure, refactor here to extract `NuMcpChild` as an exported class/factory before `nuMcpPool.ts` can compose it. This is the only place where Plan B has to touch Plan A's code.

### 4.3 `src/nu.ts` — deletions and refactors

Persistence cleanup (names verified against actual `src/nu.ts`):

- Delete the **inline persist branches** in `buildScript` — steps 2 and 5 of the generated script (the `try open $__nu_mcp_load_path | from json` load + `for entry in ... { load-env }` loop, and the `$env | reject | items | into record | to json | save` save block).
- Delete the `persist` field from `ScriptOptions`; simplify the `do --env`/`do` switch to always `do`.
- Delete from `nu.ts`: `clearPersistedEnv`, `readPersistedPwd`, `ensurePersistDir`, `persistPath`, `defaultPersistDir`, `PersistOptions` interface, `ClearPersistedEnvResult` interface, `PERSIST_KEY_RE` constant.
- Move `sanitizeKey` to `nuMcpPool.ts` (renamed `sanitizeBucketKey` if you want it self-documenting in its new home; keep the regex identical).
- Delete constants from `nu.ts`: `PERSIST_DIR`, `NU_AUTO_LOAD_BLOCKED`, `NU_SAVE_BLOCKED`, the `NU_MCP_PERSIST_LOAD` / `NU_MCP_PERSIST_SAVE` entries from save-blocked list, and the `defaultPersistDir()` helper.
- Delete `persistEnv` / `persistKey` / `persistCwd` fields from `PipelineOptions` (drop `PersistOptions` from the composition entirely).
- Drop `PERSIST_DIR` and `clearPersistedEnv` imports from `index.ts`.

`~/.nushell-mcp/persist/` directory handling: stop reading/writing. The directory and any existing user data are left on disk untouched (no destructive cleanup); future server runs ignore it.

Other changes:

- `killAll()`: prepend `getReplPool().nukeAll()` (in addition to Plan A's `getNuMcpClient().kill()`).
- Add `abortExec(): number` that returns the count of killed exec subprocesses; filters `active` by `role === "exec"` (see §4.10 for the role-tagging refactor that enables this).
- `runPipeline` simplifies to: build script (no persistence wrapping), spawn one-shot subprocess, optional bashEnv merge, capture NUON, return. Roughly halves the function's size.

### 4.4 `src/index.ts` — tool registry rewrite

Final registrations (post both plans):

```ts
// One-shot
"nu_exec"           → nu.runPipeline
"nu_exec_abort"     → nu.abortExec

// REPL pool
"nu_repl_spawn"     → pool.spawn
"nu_repl_write"     → pool.call(key, "evaluate", {input})
"nu_repl_read"      → pool.lastResponse
"nu_repl_clear"     → mode dispatch (see §4.5)
"nu_repl_list"      → pool.list
"nu_repl_status"    → pool.status
"nu_repl_kill"      → pool.kill
"nu_repl_nuke"      → pool.nukeAll

// Docs (Plan A)
"nu_doc_search"     → nu.searchDocs
"nu_doc_help"       → nu.getCommandDoc
```

### 4.5 `nu_repl_clear` modes

```ts
nu_repl_clear(key: string, mode?: "all" | "buffer")  // mode defaults to "all"
```

- `"all"` — kill the bucket's child, spawn a fresh one under the same key. Full state reset (env, cwd, lets, defs, consts, ring buffer). Equivalent to `kill + spawn` but atomic for the caller.
- `"buffer"` — clear the wrapper-side ring buffer only. Child state untouched.

No more granular modes (`env`-only, `cwd`-only, etc.). Respawning is cheap; finer modes invite scope creep.

### 4.6 `nu_repl_write` semantics

Thin wrapper around `pool.call(key, "evaluate", {input: <user code>})`. Response text (NUON envelope from upstream) is returned verbatim and pushed onto the bucket's ring buffer. Long-running calls auto-promote to background per upstream's `NU_MCP_PROMOTE_AFTER` (default 120s) — the promotion error is surfaced to the caller; they can issue follow-up `nu_repl_write("job recv <id>")` to collect.

### 4.7 `nu_repl_read` semantics

```ts
nu_repl_read(key: string)  // v1: no args; returns ring-buffer head
```

Returns `{response: NuMcpToolResponse}` or `{response: null}` if no writes have occurred. **Does not call into the child** — purely wrapper-side. This decouples us from upstream's `$history.0 = []` bug.

V2 extension path: `back?: number` arg to read N entries back into the ring buffer (buffer is already sized for this).

### 4.8 `nu_repl_status` semantics

Sends a fixed `evaluate("{cwd: $env.PWD, history_index: 0, env_keys: ($env | columns)}")` (history_index gets filled by upstream's envelope, ignoring our literal). Returns parsed result + wrapper-tracked `spawnedAt` / `lastCallAt`.

### 4.9 `nu_exec_abort` semantics

```ts
nu_exec_abort()  // no args; aborts all in-flight nu_exec subprocesses
```

Sends SIGTERM (then SIGKILL after grace) to all members of `active` that carry `role === "exec"`. Returns `{aborted: <count>}`. REPL pool children, doc singleton, and bashEnv bridge subprocesses are unaffected — this is precisely why §4.10's role tagging is load-bearing.

### 4.10 `active` set role-tagging (load-bearing architecture)

The current `active` set in `nu.ts` is undifferentiated: `dumpEnv` (bashEnv bridge subprocess) adds bash children alongside nu exec children. After Plan B, the set will also accumulate REPL pool children and Plan A's doc singleton (via the `killAll` integration). Without role differentiation, `nu_exec_abort` cannot precisely target "in-flight exec calls only" — it would unavoidably kill bash bridges, REPL children, and the doc singleton.

Refactor: replace `Set<Bun.Subprocess>` with `Set<{proc: Bun.Subprocess, role: "exec" | "bash" | "repl" | "doc"}>` (or a parallel `WeakMap<Bun.Subprocess, role>` if you prefer to avoid wrapping). Each spawn site tags its role at insertion:

| Spawn site | Role |
|---|---|
| `spawnNu` (one-shot exec) | `"exec"` |
| `dumpEnv` (bashEnv bridge) | `"bash"` |
| `NuMcpChild` for pool member | `"repl"` |
| `NuMcpChild` for doc singleton | `"doc"` |

`abortExec()` filters by `role === "exec"`. `killAll()` iterates all roles unchanged. This refactor lands in **Prep Cycle 0** before any pool/exec changes, so all subsequent cycles can rely on the tagged set.

## 5. TDD cycles

Cycles run sequentially. Plan A must be merged first.

**Cycle 0 — Prep refactors in `nu.ts`** (no behavior change)
- Red: tests assert (1) `sanitizeKey` is exported and importable from `nu.ts`; (2) `active` set entries carry a `role` field; spawning a nu exec registers `role: "exec"`; spawning a bash bridge process registers `role: "bash"`; (3) `killAll()` still terminates all roles (regression guard).
- Green: export `sanitizeKey`; refactor `active` from `Set<Bun.Subprocess>` to `Set<{proc, role}>` (or parallel `WeakMap<Bun.Subprocess, role>`); tag at each spawn site per §4.10's table.
- Refactor: no API changes to `runPipeline` / `runRaw` / `killAll` surface.

**Cycle 1 — async Mutex primitive (pure)**
- Red: tests for `Mutex` — `acquire()` returns release fn; sequential acquire/release works; concurrent acquires queue and resolve in FIFO order; release after throw doesn't leak.
- Green: minimal implementation (promise chain or async-await queue).
- Refactor: types.

**Cycle 2 — `NuMcpChild` extraction (refactor of Plan A)**
- Red: tests assert `NuMcpChild` can be instantiated independently of the singleton, with the same lifecycle behavior (spawn, callTool, kill, restart-on-death).
- Green: extract from `getNuMcpClient` closure into an exported class/factory; rewire singleton to use it.
- Refactor: no public API change to Plan A's `getNuMcpClient()`.

**Cycle 3 — `NuMcpPool`: spawn / has / list / kill / nukeAll**
- Red: integration tests — `pool.spawn("k1")` then `pool.has("k1") === true`; spawning same key errors; `pool.list()` returns `["k1"]`; `pool.kill("k1")` removes it; `pool.nukeAll()` empties; spawn past `MAX_REPLS` errors.
- Green: Map-backed pool with capacity check.

**Cycle 4 — Per-bucket serialization in `pool.call`**
- Red: two concurrent `pool.call("k1", ...)` calls serialize (second waits for first); two concurrent calls to different keys parallelize (measurable by start-time ordering).
- Green: wrap each child with a per-bucket Mutex from Cycle 1.
- Refactor: ensure Mutex is released on rejection paths.

**Cycle 5 — Ring buffer + envelope cache**
- Red: `pool.call("k", "evaluate", {input: "1 + 1"})` pushes response onto ring buffer; `pool.lastResponse("k")` returns it; second call pushes head; `pool.clearBuffer("k")` empties; envelope cache updates `cwd` after `cd /tmp` call.
- Green: array-backed ring buffer (size 5); envelope parser extracts `cwd` / `history_index` / `timestamp` from NUON.
- Refactor: extract envelope parser into a pure helper.

**Cycle 6 — `killAll` and crash policy integration**
- Red: `nu.ts:killAll()` empties the pool; killing a bucket's child directly causes next `pool.call(key, ...)` to error with "bucket died"; bucket is removed from map.
- Green: wire `killAll` to call `getReplPool().nukeAll()`; subscribe to `child.exited` per bucket to remove from map on death.

**Cycle 7 — `nu_repl_spawn` / `nu_repl_list` / `nu_repl_kill` / `nu_repl_nuke` tools**
- Red: integration tests through MCP for each tool — success paths and error paths (spawn-existing, kill-missing).
- Green: register tools in `index.ts`; route to pool.

**Cycle 8 — `nu_repl_write` tool**
- Red: spawn bucket; write `let x = 42`; write `$x`; second response text contains `42`; ring buffer head matches second response.
- Green: register; route to `pool.call(key, "evaluate", {input})`.

**Cycle 9 — `nu_repl_read` tool**
- Red: read on fresh bucket returns `{response: null}`; read after write returns last response; read on missing bucket errors.
- Green: register; route to `pool.lastResponse(key)`.

**Cycle 10 — `nu_repl_clear` tool**
- Red: spawn `k`, `let y = 99` in it, `nu_repl_clear(k, "all")`, then `$y` errors (state cleared); `nu_repl_clear(k, "buffer")` after a write empties the ring buffer but `$y` still works.
- Green: register; dispatch on mode (`"all"` → kill+spawn; `"buffer"` → `clearBuffer`).

**Cycle 11 — `nu_repl_status` tool**
- Red: spawn bucket; `cd /tmp`; `nu_repl_status` returns `cwd: "/tmp"` + nonzero `history_index` + non-empty `env_keys`.
- Green: register; route to `pool.status(key)`.

**Cycle 12 — `nu_exec_abort` tool**
- Red: spawn a long-running `nu_exec("sleep 30sec")` concurrently with `nu_exec_abort()`; exec returns aborted error; `aborted >= 1` in abort response.
- Green: register; implement `abortExec()` in `nu.ts` filtering `active` for non-REPL children.

**Cycle 13 — `nu_run` → `nu_exec` rename + `nu_kill` / `nu_persist_clear` removal**
- Red: assert registered tool list is exactly the 12 tools in §3; `nu_run`, `nu_kill`, `nu_persist_clear` no longer registered; `nu_exec` accepts no `persistEnv`/`persistKey`/`persistCwd` args.
- Green: rename `nu_run` → `nu_exec`; remove the three deprecated registrations; strip persist args from `nu_exec` schema.

**Cycle 14 — Strip file-backed persist code from `nu.ts`**
- Red: assert (a) `clearPersistedEnv`, `readPersistedPwd`, `ensurePersistDir`, `persistPath`, `defaultPersistDir`, `PERSIST_DIR`, `PersistOptions`, `NU_AUTO_LOAD_BLOCKED`, `NU_SAVE_BLOCKED` no longer exported from `nu.ts`; (b) `runPipeline`'s options type no longer accepts `persistEnv` / `persistKey` / `persistCwd`; (c) `buildScript` no longer accepts a `persist` field and always emits `do { }` (never `do --env { }`); (d) `index.ts` no longer imports `PERSIST_DIR` or `clearPersistedEnv`.
- Green: delete the functions/constants/interfaces above; simplify `buildScript` (drop steps 2 and 5 of the generated script); simplify `runPipeline` (drop the persistence setup block and the persist env var injection).
- Refactor: tighten `runPipeline` — it should now be ~half the size. Verify the `nuMcpPool.ts` import of `sanitizeKey` is wired (it was moved in Cycle 0).

**Cycle 15 — Smoke integration (12-tool world)**
- Red: end-to-end MCP test — list registered tools (assert exactly 12); multi-bucket workflow (`spawn k1`, `spawn k2`, `write k1 "let a=1"`, `write k2 "let a=2"`, `write k1 "$a"` → 1, `write k2 "$a"` → 2 — proves isolation); cross-bucket parallelism (two concurrent writes to different buckets overlap in time).
- Green: should pass without further production changes if 1–14 landed correctly.

## 6. Test plan

- All tests use a real `nu --mcp` binary (project convention).
- Cycles 1, 2 are unit-test-friendly; pure or single-child.
- Cycles 3–6, 8–12, 15 spawn pool children; each test file `afterAll`s `getReplPool().nukeAll()` + `getNuMcpClient().kill()` to avoid leaks across files.
- Cycle 12's "long-running exec" uses `sleep 30sec` capped at 5s before the test forcibly times out — verifies abort works even if test logic itself wedges.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Per-bucket Mutex deadlock if a response is never delivered (child died mid-call) | `pool.call` registers an `exit` handler that rejects the pending request and removes the bucket; Mutex is released in the rejection path |
| `nu_exec_abort` accidentally kills REPL/bash/doc children | Promoted from risk → architecture (see §4.10): `active` set is tagged by role in Prep Cycle 0; `abortExec` filters by `role === "exec"` |
| Buckets accumulate unbounded if caller forgets to kill | `MAX_REPLS` capacity (default 10) errors on `spawn`; forces caller to think about lifecycle |
| Long-running operation auto-promotes to background — caller surprised | Surface upstream's promotion error verbatim; document in `nu_repl_write` description and link to `$env.NU_MCP_PROMOTE_AFTER` |
| `nu_repl_clear "all"` race: write arrives between `kill` and `spawn` | Acquire bucket Mutex for the whole kill+spawn sequence; cross-bucket calls unaffected |
| File-backed persist removal breaks users with existing `~/.nushell-mcp/persist/` data | One-shot release note in CHANGELOG; the directory is left on disk untouched (no destructive cleanup); future server reads ignore it |
| nu 0.112.3 quirks (`$nu.is-mcp`, `$history.0`) | `$nu.is-mcp` is informational only — not used by pool; `$history.0` is bypassed entirely (we use wrapper-side ring buffer per §4.7) |

## 8. Open questions

All resolved [LOCKED per my recommendations pending user override].

- ~~Implicit spawn on `nu_repl_write`?~~ **Resolved.** Explicit only — `nu_repl_write(key, ...)` against a missing key errors. Rationale: typo'd keys would otherwise create ghost buckets the caller never reaps; an explicit error is the right teacher.
- ~~`nu_repl_clear` default mode?~~ **Resolved.** Defaults to `"all"`. Full reset is the common intent of "clear"; `"buffer"` is a niche debugging mode but available via explicit `mode: "buffer"`.
- ~~`MAX_REPLS` default?~~ **Resolved.** `10`, configurable via `NUSHELL_MCP_MAX_REPLS`. Each child is ~30MB resident; 10 → ~300MB cap, generous for an LLM session but not catastrophic.
- ~~`nu_exec_abort` granularity?~~ **Resolved.** No id in v1 — aborts ALL in-flight exec calls. Until there's a use case where two concurrent execs need independent abort, the all-abort path covers the common "model wedged on a long call, kill it" need. Selective abort listed under §9.
- ~~Ring buffer size for `nu_repl_read`?~~ **Resolved.** 5 internal entries, expose only head in v1. Allows v2 `back?: number` without a schema migration.
- ~~`bashEnv` retained on `nu_exec`?~~ **Resolved.** Yes. Orthogonal to persistence. Listed under §9 as a possible later removal if usage data shows it's dead code.

## 9. Out-of-scope follow-ups

- `nu_repl_save` / `nu_repl_load` — snapshot a bucket's state to disk and reload later (requires upstream to expose env/let serialization).
- Idle-timeout reaper (kill buckets unused for N minutes) — premature; measure usage first.
- `nu_exec` with `id` for tracked one-shots (enables per-id abort).
- `bashEnv` exposure on `nu_repl_write` — questionable layering; revisit if asked.
- Drop `bashEnv` entirely if usage proves nil.
