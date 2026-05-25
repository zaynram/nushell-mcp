# Plan A — Singleton `nu --mcp` doc backend + `nu_doc_command` → `nu_doc_help` rename

**Status:** drafted, awaiting execution sign-off
**Branch base:** `fix/persist-env-leaks` (or successor after merge)
**Scope:** doc tools only; persistence model untouched (Plan B owns that)

---

## 1. Goal

Replace per-call `nu` subprocess spawns for doc queries with a singleton `nu --mcp --mcp-transport stdio` child reached via JSON-RPC. Rename `nu_doc_command` → `nu_doc_help` to align with upstream's `command_help` tool name. Search scope expands from "nu-native only" to "everything visible to nu --mcp" (native + plugins + aliases + custom defs).

## 2. Non-goals

- No changes to `persistEnv` / `persistCwd` / `bashEnv` (Plan B atomically swaps that path).
- No changes to `nu_run`, `nu_kill`, `nu_persist_clear` tool surfaces.
- No new tools introduced.
- `nu_run` keeps its one-shot subprocess-per-call model.

## 3. Tool surface changes

| Before | After | Input/Output |
|---|---|---|
| `nu_doc_search(query, category?, limit?)` | `nu_doc_search(query?, limit?)` | `category` removed; `nushellVersion` removed from response. Behavior depends on `query`: omitted → returns a usage help string; `"*"` → returns all commands routed via `list_commands({})`, sliced by `limit`; any other string → routed via `list_commands({find: query})`, sliced by `limit`. `limit` defaults to **50**. Response shape: `{commands: [{name, signature, description}]}` for matches; `{help: string}` for the no-query path. |
| `nu_doc_command(name)` | `nu_doc_help(name)` | **Renamed AND response shape changes** [LOCKED — see §8 for reasoning]. Current `{nushellVersion, found, help, info, suggestions}` → new `{found, help, suggestions?}`. Drops `info` (structured command metadata from `scope commands`) and `nushellVersion`. `suggestions` reimplemented client-side via `list_commands({find: <name>})` + the existing `suggestCommands` fuzzy-scorer adapted to plaintext line input. `found` derived from upstream's `isError` flag on the `command_help` response. |

**Breaking changes:** `nu_doc_command` is renamed; `nu_doc_search` drops `category`. Acceptable given the project's pre-1.0 surface and the lack of documented external consumers.

## 4. Architecture

### 4.1 New module: `src/nuMcpClient.ts`

Owns the singleton `nu --mcp` child and JSON-RPC protocol.

```ts
export type NuMcpToolResponse = { text: string; isError: boolean }

export type NuMcpClient = {
    callTool(name: string, args: object): Promise<NuMcpToolResponse>
    kill(): void          // graceful term + force-kill after grace; idempotent
    isAlive(): boolean    // reflects current child state
}

export function getNuMcpClient(): NuMcpClient    // process-wide lazy singleton
```

**Internal contract**

- **Lazy spawn**: first `callTool()` spawns child + runs `initialize` handshake before sending the user request. Subsequent calls reuse.
- **Restart on death**: child-exit listener flips internal state. Next `callTool()` re-spawns transparently.
- **Request correlation**: monotonic `id` counter; pending map `{id → (resolve, reject)}`; line-reader dispatches incoming responses to the registered handler.
- **No per-child serialization at this scope**: `list_commands` and `command_help` are read-only against engine state. Concurrent JSON-RPC requests are safe. (Plan B introduces per-bucket serialization where `evaluate` is involved.)
- **Spawn args**: `[nuBin(), "--mcp", "--mcp-transport", "stdio"]` where `nuBin()` reuses the existing `NUSHELL_MCP_NU_PATH` resolution.
- **Stderr**: piped to a sink (logged on demand; not propagated). The singleton's stderr is not part of any tool response.

### 4.2 `src/nu.ts` changes

- `searchDocs(query?, opts?)` → branches on `query`:
  - `undefined` / `null` / `""` → returns the usage help string (no JSON-RPC call). Help text names the tool, lists the two accepted `query` forms (a substring or `"*"` for all), and notes the default `limit=50`.
  - `"*"` → calls `getNuMcpClient().callTool("list_commands", {})` (no `find` arg).
  - any other string → calls `getNuMcpClient().callTool("list_commands", {find: opts.query})`.
  In the two non-help branches: parses plaintext lines via a new `parseListCommandsOutput()` helper, slices to `opts.limit ?? 50`, returns structured records. Existing embedded `help commands | where ...` script is **deleted**.
- `getCommandDoc(name)` → calls `getNuMcpClient().callTool("command_help", {name})`. `found` derived from response `isError` flag. On miss, calls `getNuMcpClient().callTool("list_commands", {find: name})` and runs the captured plaintext through the existing `suggestCommands` fuzzy-scorer (adapted to take a list of names extracted by `parseListCommandsOutput` rather than raw `help commands` JSON). Returns `{found, help, suggestions?}`. Existing embedded `help <name>` + `scope commands` script and the `info` field are **deleted**.
- `killAll()` → calls `getNuMcpClient().kill()` **before** iterating `active`. Singleton is not added to `active` (avoids double-kill paths; killAll owns both).
- `getNuVersion()` → unchanged. Still uses `Bun.spawn("nu", ["--version"])` once at startup. Keeps doc-version reporting independent of singleton liveness.

### 4.3 `src/index.ts` changes

- Rename tool registration `nu_doc_command` → `nu_doc_help`.
- `nu_doc_search` input schema: remove `category`. Keep `query` (optional) and `limit` (optional).

### 4.4 Output parser contract

`parseListCommandsOutput(text: string): {name, signature, description}[]`

Each line of `list_commands` output has the shape:

```
<name> [signature]?  - <description>
```

Parser rules:
- Split body on the first `  - ` (two spaces, dash, space) separator. Left = name+signature; right = description.
- On the left half: first whitespace-delimited token is the name; remainder is the signature (may be empty).
- Lines with no `  - ` separator: take the whole line as name+signature, description is `null`.
- Empty lines and trailing whitespace ignored.

Parser must be pure (no I/O) so it can be unit-tested without a `nu` process.

## 5. TDD cycles

Each cycle is one Red → Green (→ Refactor) loop; sized to be model-tractable in a single executor invocation. Cycles run sequentially; later cycles assume earlier ones landed.

**Cycle 1 — JSON-RPC line framing primitive (pure)**
- Red: tests for a `JsonRpcFramer` that emits `{jsonrpc, id, method, params}` as `JSON + "\n"`, and parses incoming lines into responses, ignoring trailing whitespace.
- Green: minimal framer; no subprocess involved.
- Refactor: extract types into a `.d.ts` block or top of file.

**Cycle 2 — Lazy spawn + initialize handshake**
- Red: integration test — calling `getNuMcpClient().callTool("list_commands", {})` spawns a child, sends `initialize`, waits for response, then sends `tools/call`, returns the result.
- Green: spawn-on-first-call; gate user requests behind the handshake promise.
- Refactor: extract `ensureReady()`.

**Cycle 3 — Concurrent request correlation**
- Red: test that two concurrent `callTool()` invocations don't cross-contaminate responses (id correlation).
- Green: implement pending-id map.
- Refactor: error path — reject pending requests if child exits while requests are in flight.

**Cycle 4 — Restart on death**
- Red: test that after `kill()`, the next `callTool()` re-spawns transparently and succeeds.
- Green: detect `proc.exited`; flip state; respawn on next call.
- Refactor: ensure no double-spawn race if two calls race past the dead check.

**Cycle 5 — killAll integration**
- Red: test that `nu.ts:killAll()` terminates the singleton's child (`isAlive() === false` after).
- Green: prepend `getNuMcpClient().kill()` to `killAll()`.

**Cycle 6 — `parseListCommandsOutput` parser**
- Red: unit tests against captured `list_commands` fixtures — verifies `name`, `signature`, `description` extraction, handles description-less lines, ignores blanks.
- Green: implement parser per §4.4 rules.

**Cycle 7 — `searchDocs` swap**
- Red: three integration tests —
  1. `searchDocs({})` (no query) returns `{help, nushellVersion}` without making a JSON-RPC call (mock or spy on the client).
  2. `searchDocs({query: "where", limit: 3})` returns ≤3 structured records routed through `list_commands({find: "where"})`.
  3. `searchDocs({query: "*", limit: 5})` returns ≤5 records routed through `list_commands({})` (no `find` arg).
- Green: rewrite `searchDocs` per §4.2 branching logic.
- Refactor: delete the dead `help commands` script constant.

**Cycle 8 — `getCommandDoc` swap**
- Red: three integration tests —
  1. `getCommandDoc("where")` returns `{found: true, help: <text>}` routed through `command_help`; `info` no longer present.
  2. `getCommandDoc("nonexistent-cmd-xyz")` returns `{found: false, help: <text>, suggestions: [...]}` where `suggestions` is sourced from a `list_commands({find: "nonexistent-cmd-xyz"})` call routed through the singleton + the adapted fuzzy scorer.
  3. `getCommandDoc("where")` (the hit case) does NOT call `list_commands` (no suggestions on hit).
- Green: rewrite `getCommandDoc` per §4.2; adapt `suggestCommands` to take an iterable of names (decoupled from the dead `help commands | get name` source).
- Refactor: delete the dead `help <name>` + `scope commands` script constant (`COMMAND_NU`); delete the `info` field from `CommandDoc`.

**Cycle 9 — Tool registration rename**
- Red: test that registered tool name is `nu_doc_help`, not `nu_doc_command`; `nu_doc_search` schema no longer accepts `category`.
- Green: rename in `src/index.ts`; remove `category` from input schema.

**Cycle 10 — Smoke integration**
- Red: end-to-end MCP test — list registered tools, exercise `nu_doc_search` and `nu_doc_help`, assert nonzero results and that singleton stays alive across calls.
- Green: should pass with no production changes if prior cycles landed correctly; surfaces wiring regressions.

## 6. Test plan

- All tests run against a real `nu` binary (project convention — `bun test` already requires this).
- Cycle 1, 6 are pure unit tests (no subprocess).
- Cycles 2–5, 7–10 spawn the singleton; each test file must call `getNuMcpClient().kill()` in an `afterAll` to avoid leaking children across files.
- Fixtures for cycle 6: capture two `list_commands` responses (one with `find`, one without) once, commit as `test/fixtures/list_commands_*.txt`.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| JSON-RPC read hangs forever if child dies mid-request | Reject all pending on `proc.exited`; surface as tool error |
| Singleton child stderr noise | Pipe stderr to discard sink; log only on demand |
| Tests leak `nu --mcp` children | `afterAll` calls `kill()`; CI run includes `pgrep nu` check after test phase (optional belt+braces) |
| Concurrent test files all spawn their own singleton (Bun test parallelism) | Acceptable — singleton is per-process; Bun runs test files in separate processes |
| nu 0.112.3 anomalies (`$nu.is-mcp`, `$history.0`) | Not touched by this plan — only `list_commands` and `command_help` are called, neither involves evaluate state |
| `list_commands` output format changes between nu versions | Parser is small, easy to update; cycle 6 fixtures pin behavior per nu version we test against |

## 8. Open questions

All resolved.

- ~~Plan filename~~: **Resolved.** `plan-a.md`.
- ~~Response shape for `nu_doc_search`~~: **Resolved.** `nushellVersion` field dropped from `nu_doc_search` response.
- ~~`nu_doc_search` with no query~~: **Resolved.** No query → return a usage help message. `query: "*"` is the explicit "list all" sentinel (routed via `list_commands({})`), sliced by `limit` (default 50).
- ~~Singleton crash logging~~: **Resolved.** Silent restart with a one-line stderr message naming the exit code; user-invisible unless they redirect server stderr.
- ~~`nu_doc_help` response shape (drift discovered post-draft)~~: **Resolved [LOCKED per my recommendation pending user override].** Drop `info` and `nushellVersion` from response. Reimplement `suggestions` client-side via `list_commands({find: name})` + adapted `suggestCommands`. Rationale: matches the search-backend choice (Option C) — be consistent with upstream's `command_help` semantics, accept the contract degradation, reimplement the niceties on top rather than maintain an embedded nu script just to preserve them. The asymmetry of "rich for search vs even-richer for help" no longer exists; both tools now own the same maintenance pattern.

## 9. Out-of-scope follow-ups (not this plan)

- Plan B: REPL pool (one `nu --mcp` child per persist key) replacing `persistEnv`.
- Plugin command filter (`scope: native|all`) — possible follow-up if Option C's expanded scope causes friction.
- Cache `list_commands` output between calls (perf) — premature; measure first.
