/**
 * NuMcpPool — Map-backed registry of `nu --mcp` child processes, keyed by
 * REPL bucket name. Each bucket is one NuMcpChild. The pool enforces a
 * configurable cap (`MAX_REPLS`, default 10, overridable per-instance or via
 * `NUSHELL_MCP_MAX_REPLS`) and is the only authority that creates / destroys
 * REPL children. Key validation via `sanitizeKey` is enforced at `spawn()`
 * only — other methods (`has` / `get` / `call` / `kill` / `clear` / `status`
 * / `lastResponse` / `envelope`) treat the key as a plain Map lookup. Non-
 * conforming keys can never reach an existing bucket because spawn rejects
 * them at registration; lookup-only methods therefore see "bucket does not
 * exist" / `has → false` for invalid input, which is the correct treatment
 * for "this is not a registered bucket".
 *
 * Plan B Cycle 3.
 */
import { Mutex } from "./mutex.js"
import { sanitizeKey } from "./nu.js"
import { NuMcpChild, type NuMcpToolResponse } from "./nuMcpClient.js"

export interface NuMcpPoolOptions {
  /** Hard cap on simultaneous buckets. Overrides env. Default: env or 10. */
  maxRepls?: number
}

const DEFAULT_MAX_REPLS = 10
const RING_BUFFER_SIZE = 5

function resolveMaxRepls(opt: NuMcpPoolOptions | undefined): number {
  if (opt?.maxRepls !== undefined) return opt.maxRepls
  const fromEnv = process.env.NUSHELL_MCP_MAX_REPLS
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_MAX_REPLS
}

/**
 * Envelope fields the `evaluate` tool returns alongside `output`. Modeled as
 * a discriminated union so callers must narrow on `kind` before reading
 * payload fields — the prior all-optional shape collapsed "never evaluated",
 * "parse failed", and "valid" into one shape that callers could not tell
 * apart. `cwd` is required on the `ok` variant because it is the anchor
 * field: `parseEvaluateEnvelope` returns `{kind: "empty"}` when cwd is
 * absent (parse failed or non-envelope text), and `{kind: "ok", cwd, ...}`
 * otherwise.
 */
export type EvaluateEnvelope =
  | { kind: "empty" }
  | { kind: "ok"; cwd: string; historyIndex?: number; timestamp?: string }

/**
 * Return type of `NuMcpPool.status()`. Bifurcates independently from
 * `EvaluateEnvelope`: status reports whether the side-channel probe of
 * `$env | columns` succeeded (`ok`) or failed (`probe-error`). On
 * probe-error the cached envelope from before the failed probe is carried
 * explicitly as `cachedEnvelope` so callers do not have to remember to look
 * for stale fields on a "mostly-empty" object.
 */
export type BucketStatus =
  | {
      kind: "ok"
      cwd?: string
      historyIndex?: number
      timestamp?: string
      envKeys: string[]
    }
  | {
      kind: "probe-error"
      probeError: string
      cachedEnvelope: EvaluateEnvelope
    }

/**
 * Pure: extract envelope fields from an `evaluate` response's text. Tolerant
 * of field reordering, missing fields, and non-envelope inputs — returns
 * `{kind: "empty"}` when no `cwd` is present (e.g. plain-text from
 * `list_commands`), or `{kind: "ok", cwd, ...}` when it is.
 *
 * The `timestamp` string is preserved verbatim — nanosecond precision
 * (`+00:00` with 9 fractional digits) does not round-trip through `Date`.
 */
export function parseEvaluateEnvelope(text: string): EvaluateEnvelope {
  // Match field preceded by start-of-string, `{`, or `,` (with optional
  // surrounding whitespace). Value terminates at the next `,` or `}`.
  // Whitespace around the value is trimmed so cwd paths with internal
  // spaces (e.g. `/home/user/My Documents`) are captured in full.
  // NOTE: commas cannot appear in cwd values — the wire format would break.
  const parseNuonField = (field: string): string | undefined => {
    const m = new RegExp(
      `(?:^|[,{])\\s*${field}:\\s*([^,}]+?)\\s*(?=[,}])`,
    ).exec(text)
    return m?.[1]
  }

  const cwd = parseNuonField("cwd")
  if (!cwd) return { kind: "empty" }
  const env: EvaluateEnvelope = { kind: "ok", cwd }
  const hist = parseNuonField("history_index")
  if (hist) {
    const n = Number.parseInt(hist, 10)
    if (Number.isFinite(n)) env.historyIndex = n
  }
  const ts = parseNuonField("timestamp")
  if (ts) env.timestamp = ts
  return env
}

interface BucketEntry {
  child: NuMcpChild
  mutex: Mutex
  /** Head-first ring of recent responses; index 0 = most recent. */
  buffer: NuMcpToolResponse[]
  /** Last-known envelope state from `evaluate` responses. */
  envelope: EvaluateEnvelope
}

export class NuMcpPool {
  private readonly buckets = new Map<string, BucketEntry>()
  private readonly maxRepls: number

  constructor(opt?: NuMcpPoolOptions) {
    this.maxRepls = Math.max(resolveMaxRepls(opt), 1)
  }

  /**
   * Register a new bucket. Errors if the key is invalid, already taken, or
   * the pool is at capacity.
   */
  spawn(key: string): NuMcpChild {
    const safe = sanitizeKey(key)
    if (this.buckets.has(safe)) {
      throw new Error(`bucket "${safe}" already exists`)
    }

    if (this.buckets.size >= this.maxRepls)
      throw Error(`maximum active repls reached (limit: ${this.maxRepls})`)

    const child = new NuMcpChild("repl")
    const entry: BucketEntry = {
      child,
      mutex: new Mutex(),
      buffer: [],
      envelope: { kind: "empty" },
    }
    // Prune the bucket when its child dies (crash or external kill). Guard
    // against a spawn-with-same-key race: only delete if the current map
    // entry is still the one we registered.
    child.onExit(() => {
      if (this.buckets.get(safe) === entry) {
        this.buckets.delete(safe)
      }
    })
    this.buckets.set(safe, entry)
    return child
  }

  /** True if a bucket with this key is registered. */
  has(key: string): boolean {
    return this.buckets.has(key)
  }

  /** Get the child for a bucket, or undefined. */
  get(key: string): NuMcpChild | undefined {
    return this.buckets.get(key)?.child
  }

  /** Snapshot of registered bucket keys. */
  list(): string[] {
    return [...this.buckets.keys()]
  }

  /**
   * Invoke a tool on a bucket's child. Serialized per-bucket via the bucket's
   * Mutex — concurrent calls to the same key queue; concurrent calls to
   * different keys run in parallel.
   *
   * The mutex is released in `finally` so a thrown / rejected callTool can't
   * leak the lock and wedge the bucket.
   *
   * Returns both the raw `response` and a snapshot of the `envelope` taken
   * while still holding the mutex. Callers that need the post-call envelope
   * (e.g. `nu_repl_write`) must use this snapshot rather than calling
   * `pool.envelope(key)` separately — the bucket may have been pruned by the
   * time a separate `envelope()` call runs (a separate lookup would then
   * throw "bucket does not exist" even though the call itself succeeded).
   *
   * `opts.record` (default `true`) controls whether the response is pushed
   * into the bucket's ring buffer. Internal probe calls (e.g. `status()`'s
   * `$env | columns` probe) pass `false` so `nu_repl_read` keeps returning
   * the user's most-recent `nu_repl_write` response rather than the
   * server-injected probe (Copilot 3296946827). The envelope cache is
   * updated regardless — that's the whole point of the probe.
   */
  async call(
    key: string,
    toolName: string,
    args: object,
    opts?: { record?: boolean },
  ): Promise<{ response: NuMcpToolResponse; envelope: EvaluateEnvelope }> {
    const entry = this.buckets.get(key)
    if (!entry) throw new Error(`bucket "${key}" does not exist`)
    const release = await entry.mutex.acquire()
    try {
      // Re-check after acquiring the mutex: a concurrent clear("all") could
      // have replaced the bucket under the same key while we waited, and a
      // concurrent kill() could have pruned it entirely. In either case the
      // captured `entry.child` is now dead and callTool would fail with a
      // noisy stdio error; the explicit re-check produces a clean message
      // and preserves "kill/clear wins" semantics for queued callers
      // (Copilot 3295712482).
      if (this.buckets.get(key) !== entry) {
        throw new Error(`bucket "${key}" was replaced or killed while waiting`)
      }
      const response = await entry.child.callTool(toolName, args)
      const record = opts?.record !== false
      if (record) {
        // Push to ring buffer head; evict the tail past RING_BUFFER_SIZE.
        entry.buffer.unshift(response)
        if (entry.buffer.length > RING_BUFFER_SIZE) {
          entry.buffer.length = RING_BUFFER_SIZE
        }
      }
      // Update envelope cache only when fields are present (e.g. `evaluate`).
      // A `{kind: "empty"}` parse leaves the cache untouched (non-envelope
      // responses like `list_commands` should not erase prior state). A
      // `{kind: "ok"}` parse promotes the cache to `ok`, preserving prior
      // history_index / timestamp when the new parse omits them.
      if (toolName === "evaluate" && !response.isError) {
        const parsed = parseEvaluateEnvelope(response.text)
        if (parsed.kind === "ok") {
          const prior = entry.envelope.kind === "ok" ? entry.envelope : undefined
          entry.envelope = {
            kind: "ok",
            cwd: parsed.cwd,
            historyIndex: parsed.historyIndex ?? prior?.historyIndex,
            timestamp: parsed.timestamp ?? prior?.timestamp,
          }
        }
      }
      // Snapshot the envelope while still holding the mutex so the caller
      // gets an atomic {response, envelope} pair even if the child dies after
      // the mutex is released. Explicit per-variant copy preserves the
      // discriminator narrowing (vs. a bare spread, which is technically
      // sound under strict TS but obscures intent).
      const envelope: EvaluateEnvelope =
        entry.envelope.kind === "ok"
          ? {
              kind: "ok",
              cwd: entry.envelope.cwd,
              historyIndex: entry.envelope.historyIndex,
              timestamp: entry.envelope.timestamp,
            }
          : { kind: "empty" }
      return { response, envelope }
    } finally {
      release()
    }
  }

  /**
   * Most recent response for a bucket, or `null` if the bucket exists but has
   * never been called. Throws if the bucket does not exist.
   */
  lastResponse(key: string): NuMcpToolResponse | null {
    const entry = this.buckets.get(key)
    if (!entry) throw new Error(`bucket "${key}" does not exist`)
    return entry.buffer[0] ?? null
  }

  /** Empty the ring buffer for a bucket without touching the child. */
  clearBuffer(key: string): void {
    const entry = this.buckets.get(key)
    if (!entry) throw new Error(`bucket "${key}" does not exist`)
    entry.buffer.length = 0
  }

  /** Snapshot of the envelope cache for a bucket. */
  envelope(key: string): EvaluateEnvelope {
    const entry = this.buckets.get(key)
    if (!entry) throw new Error(`bucket "${key}" does not exist`)
    return entry.envelope.kind === "ok"
      ? {
          kind: "ok",
          cwd: entry.envelope.cwd,
          historyIndex: entry.envelope.historyIndex,
          timestamp: entry.envelope.timestamp,
        }
      : { kind: "empty" }
  }

  /** Test-only: inspect the full ring buffer contents (head-first). */
  _inspectBuffer(key: string): NuMcpToolResponse[] {
    const entry = this.buckets.get(key)
    if (!entry) throw new Error(`bucket "${key}" does not exist`)
    return [...entry.buffer]
  }

  /**
   * Reset a bucket. `mode: "buffer"` empties the ring buffer only; the
   * child and its session state survive. `mode: "all"` kills the child
   * and respawns it under the same key — wipes session state entirely.
   */
  async clear(key: string, mode: "all" | "buffer"): Promise<void> {
    const entry = this.buckets.get(key)
    if (!entry) throw new Error(`bucket "${key}" does not exist`)
    const release = await entry.mutex.acquire()
    try {
      // Re-check that this entry is still the current one. A concurrent
      // clear("all") on the same key could have already killed this entry
      // and spawned a replacement while we waited for the mutex.
      if (this.buckets.get(key) !== entry) {
        // Work already satisfied by the concurrent caller — nothing to do.
        return
      }
      if (mode === "buffer") {
        entry.buffer.length = 0
        return
      }
      // mode === "all": kill + spawn while holding the bucket mutex so no
      // concurrent call() can interleave with child replacement.
      entry.child.kill()
      // After kill(), the map entry is gone. spawn() re-creates everything.
      this.spawn(key)
    } finally {
      release()
    }
  }

  /**
   * Snapshot the bucket's last-known state. Combines the cached envelope
   * (cwd, historyIndex, timestamp) with a fresh side-channel probe of
   * `$env | columns` for env keys. The probe increments the bucket's
   * history_index — callers should treat env_keys as best-effort. Probe
   * failures surface as `probeError` rather than throwing, so the caller
   * always receives a result even when the child has died.
   */
  async status(key: string): Promise<BucketStatus> {
    const entry = this.buckets.get(key)
    if (!entry) throw new Error(`bucket "${key}" does not exist`)
    try {
      const { response: probe, envelope } = await this.call(
        key,
        "evaluate",
        { input: "$env | columns" },
        { record: false },
      )
      if (probe.isError) {
        // Probe call succeeded at the transport level but upstream tool
        // reported an error — surface as probe-error so callers see the
        // same shape as a thrown probe. The cached entry.envelope is the
        // safer "what was true" reference than the probe's own envelope
        // (which reflects post-error state). Pre-DU code matched against
        // probe.text here unconditionally — that was a latent bug:
        // accidental matches of `output:"[...]"` would have populated
        // envKeys from error text.
        const cached = entry.envelope
        const cachedEnvelope: EvaluateEnvelope =
          cached.kind === "ok"
            ? {
                kind: "ok",
                cwd: cached.cwd,
                historyIndex: cached.historyIndex,
                timestamp: cached.timestamp,
              }
            : { kind: "empty" }
        return { kind: "probe-error", probeError: probe.errorText, cachedEnvelope }
      }
      // `$env | columns` returns a list rendered as `output:"[KEY1,KEY2,...]"`.
      let envKeys: string[] = []
      const match = probe.text.match(/output:"\[([^\]]*)\]"/)
      if (match?.[1]) {
        envKeys = match[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      }
      // Return the post-probe envelope; the probe both increments
      // history_index and is the freshest snapshot of cwd / timestamp.
      if (envelope.kind === "ok") {
        return {
          kind: "ok",
          cwd: envelope.cwd,
          historyIndex: envelope.historyIndex,
          timestamp: envelope.timestamp,
          envKeys,
        }
      }
      return { kind: "ok", envKeys }
    } catch (err) {
      // Side-channel probe failed — surface as probe-error rather than
      // throwing. Carry the cached envelope from before the failed probe
      // explicitly so callers do not have to dig for stale fields. Read
      // the cache off the captured `entry` reference (not a fresh map
      // lookup) so a child death that pruned the bucket between probe
      // start and probe failure does not erase the cached envelope.
      const probeError = err instanceof Error ? err.message : String(err)
      const cached = entry.envelope
      const cachedEnvelope: EvaluateEnvelope =
        cached.kind === "ok"
          ? {
              kind: "ok",
              cwd: cached.cwd,
              historyIndex: cached.historyIndex,
              timestamp: cached.timestamp,
            }
          : { kind: "empty" }
      return { kind: "probe-error", probeError, cachedEnvelope }
    }
  }

  /**
   * Kill and unregister a bucket. Returns true if it existed, false otherwise
   * (idempotent — safe to call on a missing key).
   *
   * The child is killed BEFORE acquiring the mutex — this is the "panic
   * button" semantic that `nu_repl_kill` depends on. A long-running pipeline
   * (e.g. `sleep 1hr`, an infinite loop, a wedged HTTP request) inside the
   * bucket holds the per-bucket mutex via its in-flight `callTool`. Killing
   * the child triggers `NuMcpChild.kill()`'s own synchronous drain of its
   * `pending` request map — every in-flight handler rejects immediately
   * with "nu --mcp client killed" BEFORE fireExit fires. The in-flight
   * `callTool` promise rejects in the same tick, the awaiting `pool.call`
   * unwinds to its `finally`, the mutex releases. We then `await
   * mutex.acquire()` purely for ordering with concurrent `clear()` — the
   * actual map-delete bookkeeping runs in the critical section.
   *
   * (Note: `handleExit` is the OTHER rejection path, reached via
   * `proc.exited.then(...)` when the child dies on its own without an
   * explicit kill. On the explicit-kill path it's a no-op against an
   * already-empty `pending` map.)
   *
   * Note: `pool.clear(key, "all")` does NOT share this kill-first semantic —
   * it still waits for in-flight calls before resetting because its "respawn
   * vs. don't respawn" decision needs to be ordered against concurrent kills.
   * Callers needing both "stop now" and "fresh state" should `kill` then
   * `spawn` instead of calling `clear("all")` on a stuck bucket.
   */
  async kill(key: string): Promise<boolean> {
    const entry = this.buckets.get(key)
    if (!entry) return false
    // Sync: child.kill() drains pending handlers (each rejects with
    // "nu --mcp client killed") and fires onExit which prunes the map
    // entry. The in-flight callTool in pool.call rejects in the same tick,
    // releasing the mutex so our await below resolves promptly.
    entry.child.kill()
    // Drain the mutex for ordering with concurrent clear("all") — that
    // path's re-check (`this.buckets.get(key) !== entry`) sees the pruned
    // entry and skips its respawn, so kill wins over concurrent clear.
    const release = await entry.mutex.acquire()
    try {
      // onExit already deleted the entry; defensive no-op delete here in
      // case onExit fired without doing the delete for any reason.
      if (this.buckets.get(key) === entry) this.buckets.delete(key)
      return true
    } finally {
      release()
    }
  }

  /** Kill every bucket; returns the count killed. */
  nukeAll(): number {
    let n = 0
    for (const [key, entry] of this.buckets) {
      entry.child.kill()
      this.buckets.delete(key)
      n += 1
    }
    return n
  }
}

let singletonPool: NuMcpPool | null = null

/**
 * Process-wide singleton pool. `nu.ts:killAll()` and the REPL MCP tools
 * (`nu_repl_*`) all funnel through this. Tests that need an isolated pool
 * should construct `new NuMcpPool()` directly instead.
 */
export function getReplPool(): NuMcpPool {
  if (!singletonPool) singletonPool = new NuMcpPool()
  return singletonPool
}
