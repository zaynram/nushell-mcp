/**
 * NuMcpPool — Map-backed registry of `nu --mcp` child processes, keyed by
 * REPL bucket name. Each bucket is one NuMcpChild. The pool enforces a
 * configurable cap (`MAX_REPLS`, default 10, overridable per-instance or via
 * `NUSHELL_MCP_MAX_REPLS`), validates keys through the shared `sanitizeKey`
 * regex, and is the only authority that creates / destroys REPL children.
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
 * Envelope fields the `evaluate` tool returns alongside `output`. Each field
 * is optional because parser callers may receive non-envelope responses
 * (e.g. plain-text from `list_commands`) and must not crash.
 */
export interface EvaluateEnvelope {
  cwd?: string
  historyIndex?: number
  timestamp?: string
}

/**
 * Return type of `NuMcpPool.status()`. Combines the cached envelope with a
 * freshly-probed env key list. `probeError` is set when the side-channel
 * `$env | columns` probe fails (e.g. the child has died); callers that
 * need to surface the error can inspect it instead of getting an exception.
 */
export interface BucketStatus extends EvaluateEnvelope {
  envKeys: string[]
  probeError?: string
}

/**
 * Pure: extract envelope fields from an `evaluate` response's text. Tolerant
 * of field reordering, missing fields, and non-envelope inputs (returns `{}`
 * rather than throwing).
 *
 * The `timestamp` string is preserved verbatim — nanosecond precision
 * (`+00:00` with 9 fractional digits) does not round-trip through `Date`.
 */
export function parseEvaluateEnvelope(text: string): EvaluateEnvelope {
  const parseNuonField = (field: string): string | undefined =>
    new RegExp(`(?:^|[,{\\s])${field}:\\s*([^,}\\s]+)`).exec(text)?.at(1)

  const cwd = parseNuonField("cwd")
  if (!cwd) return {}
  const env: EvaluateEnvelope = { cwd: cwd.trim() }
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
      envelope: {},
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
   */
  async call(
    key: string,
    toolName: string,
    args: object,
  ): Promise<NuMcpToolResponse> {
    const entry = this.buckets.get(key)
    if (!entry) throw new Error(`bucket "${key}" does not exist`)
    const release = await entry.mutex.acquire()
    try {
      const response = await entry.child.callTool(toolName, args)
      // Push to ring buffer head; evict the tail past RING_BUFFER_SIZE.
      entry.buffer.unshift(response)
      if (entry.buffer.length > RING_BUFFER_SIZE) {
        entry.buffer.length = RING_BUFFER_SIZE
      }
      // Update envelope cache only when fields are present (e.g. `evaluate`).
      if (toolName === "evaluate" && !response.isError) {
        const parsed = parseEvaluateEnvelope(response.text)
        entry.envelope = { ...entry.envelope, ...parsed }
      }
      return response
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
    return { ...entry.envelope }
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
    let envKeys: string[] = []
    let probeError: string | undefined
    try {
      const probe = await this.call(key, "evaluate", {
        input: "$env | columns",
      })
      // `$env | columns` returns a list rendered as `output:"[KEY1,KEY2,...]"`.
      const match = probe.text.match(/output:"\[([^\]]*)\]"/)
      if (match?.[1]) {
        envKeys = match[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      }
    } catch (err) {
      // Side-channel probe failed — surface as probeError rather than throwing.
      probeError = err instanceof Error ? err.message : String(err)
    }
    // Return the post-probe envelope; the probe both increments
    // history_index and is the freshest snapshot of cwd / timestamp.
    const after = this.buckets.get(key)?.envelope ?? {}
    return { ...after, envKeys, ...(probeError !== undefined && { probeError }) }
  }

  /**
   * Kill and unregister a bucket. Returns true if it existed, false otherwise
   * (idempotent — safe to call on a missing key).
   */
  kill(key: string): boolean {
    const entry = this.buckets.get(key)
    if (!entry) return false
    entry.child.kill()
    this.buckets.delete(key)
    return true
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
