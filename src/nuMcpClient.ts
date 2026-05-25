/**
 * `nu --mcp` JSON-RPC client (used both as a process-wide doc singleton and
 * per REPL bucket by `NuMcpPool`).
 *
 * This module owns the wire-level framing AND the child lifecycle for talking
 * to a `nu --mcp` child over its stdio transport (line-delimited JSON-RPC
 * 2.0). The framer primitives (`encodeRequest` / `decodeMessage`) are pure
 * and unit-tested in isolation; each `NuMcpChild` instance wires them to its
 * own child process with lazy spawn + initialize-handshake gating.
 *
 * Plan A, Cycles 1-2.
 */

/** JSON-RPC 2.0 id — numeric or string per the spec. */
export type JsonRpcId = number | string

/**
 * Outgoing request. `params` is omitted from the wire format when undefined to
 * match what JSON-stringification would produce for an object without the key,
 * keeping the wire byte-identical to the natural JSON shape.
 */
export interface JsonRpcRequest {
    jsonrpc: "2.0"
    id: JsonRpcId
    method: string
    params?: unknown
}

/**
 * Decoded inbound message. Either a *response* (correlated by `id` to one of
 * our requests) or a *notification* (server-initiated, no `id`).
 *
 * Responses carry `isError` so a caller doesn't have to inspect the payload
 * shape — `isError: true` means `payload` is `{code, message, data?}` per the
 * JSON-RPC error object; `isError: false` means `payload` is whatever the
 * server returned in `result`.
 */
export type DecodedMessage =
    | {
          kind: "response"
          id: JsonRpcId
          isError: false
          payload: unknown
      }
    | {
          kind: "response"
          id: JsonRpcId
          isError: true
          payload: { code: number; message: string; data?: unknown }
      }
    | {
          kind: "notification"
          method: string
          params: unknown
      }

/**
 * Encode an outgoing request as one line of JSON terminated by `\n`. The
 * trailing newline is what the line-delimited transport uses to frame
 * messages; callers should write the returned string verbatim to the child's
 * stdin without further wrapping.
 */
export function encodeRequest(
    id: JsonRpcId,
    method: string,
    params?: unknown,
): string {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method }
    if (params !== undefined) req.params = params
    return JSON.stringify(req) + "\n"
}

/**
 * Parse one line of input (trailing whitespace / CRLF tolerated) into a
 * `DecodedMessage`. Throws `Error` on any structural problem so the caller's
 * line-reader can surface the issue rather than silently mis-routing.
 *
 * Classification rules:
 *  - `jsonrpc` MUST equal `"2.0"`.
 *  - If `id` is present and non-null → response. Must carry exactly one of
 *    `result` (success) or `error` (failure).
 *  - Else if `method` is a string → notification.
 *  - Else → throw (unclassifiable).
 */
export function decodeMessage(line: string): DecodedMessage {
    const trimmed = line.trim()
    if (!trimmed) {
        throw new Error("decodeMessage: empty line")
    }
    let obj: unknown
    try {
        obj = JSON.parse(trimmed)
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`decodeMessage: invalid JSON: ${message}`)
    }
    if (typeof obj !== "object" || obj === null) {
        throw new Error("decodeMessage: top-level value must be an object")
    }
    const record = obj as Record<string, unknown>
    if (record.jsonrpc !== "2.0") {
        throw new Error(
            `decodeMessage: expected jsonrpc:"2.0", got ${JSON.stringify(record.jsonrpc)}`,
        )
    }
    const id = record.id
    const hasId =
        id !== undefined && id !== null &&
        (typeof id === "number" || typeof id === "string")
    if (hasId) {
        if ("error" in record) {
            return {
                kind: "response",
                id: id as JsonRpcId,
                isError: true,
                payload: record.error as {
                    code: number
                    message: string
                    data?: unknown
                },
            }
        }
        if ("result" in record) {
            return {
                kind: "response",
                id: id as JsonRpcId,
                isError: false,
                payload: record.result,
            }
        }
        throw new Error(
            "decodeMessage: response missing both result and error",
        )
    }
    if (typeof record.method === "string") {
        return {
            kind: "notification",
            method: record.method,
            params: record.params,
        }
    }
    throw new Error(
        "decodeMessage: message has neither id+result/error nor method",
    )
}

// --- list_commands plaintext parser ----------------------------------------

/** Parsed entry from a single `list_commands` output line. */
export interface ListCommandEntry {
    /** Command name, possibly multi-word for subcommands (e.g. `polars arg-true`). */
    name: string
    /** Argument signature as nu prints it, or `null` if absent. */
    signature: string | null
    /** Human-readable description, or `null` if the line had no `  - ` separator. */
    description: string | null
}

// First-character set that indicates a token belongs to the signature, not
// the command name: `<param>` `(opt)` `{flags}` `[bracket]` `= alias-value`.
// `...rest` and `...(rest)` also start signatures — match the literal three-dot prefix.
const SIG_LEAD = /^[<({[=]|^\.\.\./

function parseListCommandsLine(line: string): ListCommandEntry {
    const sepIdx = line.indexOf("  - ")
    let body: string
    let description: string | null
    if (sepIdx >= 0) {
        body = line.slice(0, sepIdx)
        const after = line.slice(sepIdx + 4).replace(/\s+$/, "")
        description = after.length > 0 ? after : null
    } else {
        body = line
        description = null
    }
    const tokens = body.trim().split(/\s+/).filter((t) => t.length > 0)
    let sigStart = tokens.length
    for (let i = 0; i < tokens.length; i++) {
        if (SIG_LEAD.test(tokens[i])) {
            sigStart = i
            break
        }
    }
    const name = tokens.slice(0, sigStart).join(" ")
    const signature =
        sigStart < tokens.length ? tokens.slice(sigStart).join(" ") : null
    return { name, signature, description }
}

/**
 * Parse the plaintext output of `nu --mcp`'s `list_commands` tool. Empty
 * and whitespace-only lines are dropped. Each line yields one entry; line
 * order is preserved.
 */
export function parseListCommandsOutput(text: string): ListCommandEntry[] {
    return text
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.trim().length > 0)
        .map(parseListCommandsLine)
}

// --- Singleton client lifecycle --------------------------------------------

import { type ActiveRole, addActive, removeActive } from "./active.js"

/** Path to `nu`. Honors `NUSHELL_MCP_NU_PATH`; falls back to `nu` on PATH. */
const NU_PATH: string =
    process.env.NUSHELL_MCP_NU_PATH ?? Bun.which("nu") ?? "nu"

/**
 * Tool response in the shape the rest of the codebase expects: the text
 * payload concatenated from the MCP `content` blocks, flattened with the
 * upstream's `isError` flag.
 *
 * Discriminated on `isError` so callers cannot read the payload without
 * narrowing first. The success branch exposes `text`; the error branch
 * renames the field to `errorText` — that asymmetry is intentional. It
 * forces every callsite that propagates a response into user-visible
 * output to choose between "show as success" or "show as diagnostic"
 * explicitly, rather than silently rendering an error string into a
 * field a caller treats as trusted output.
 */
export type NuMcpToolResponse =
    | { isError: false; text: string }
    | { isError: true; errorText: string }

export interface NuMcpClient {
    /** Invoke a tool against the singleton's child. Lazy-spawns on first call. */
    callTool(name: string, args: object): Promise<NuMcpToolResponse>
    /** Terminate the child (if running) and reject all pending requests. */
    kill(): void
    /** True iff a child process is currently spawned and not yet exited. */
    isAlive(): boolean
}

/**
 * Handler stored against a pending request id. Receives the decoded response
 * variant; transforms internally before resolving the public Promise.
 */
type RpcHandler = {
    resolve: (msg: Extract<DecodedMessage, { kind: "response" }>) => void
    reject: (err: Error) => void
}

/**
 * One `nu --mcp` child process with its own JSON-RPC lifecycle. Used by the
 * Plan A doc singleton (one instance via `getNuMcpClient()`) and by the
 * Plan B REPL pool (one instance per bucket). Each instance manages a single
 * child with lazy spawn, initialize handshake, request correlation, restart
 * on death, and graceful kill.
 */
export class NuMcpChild {
    private proc: Bun.Subprocess | null = null
    private readyPromise: Promise<void> | null = null
    private nextId = 1
    private pending = new Map<JsonRpcId, RpcHandler>()
    private exitListeners: (() => void)[] = []
    private exited = false
    private readonly role: ActiveRole

    /**
     * Create a new `NuMcpChild` with the given active-set role.
     *
     * `role` flows to `addActive(proc, role)` inside `startup()`. The tag
     * distinguishes REPL-bucket children (`"repl"`) from the doc singleton
     * (`"doc"`): `abortExec()` filters on `role === "exec" || role === "bash"`
     * (so a hung bashEnv runner also dies on user-invoked abort), while
     * `killAll()` reaches every role. Callers must pass an explicit role —
     * there is no default, because silently choosing the wrong tag affects
     * `abortExec`/`killAll` filtering downstream.
     */
    constructor(role: ActiveRole) {
        this.role = role
    }

    isAlive(): boolean {
        return this.proc !== null && this.proc.exitCode === null
    }

    /**
     * Test-only accessor for the underlying `Bun.Subprocess`. Underscore
     * prefix flags this as not part of the stable surface — tests use it to
     * simulate raw subprocess crashes by calling `.kill()` directly,
     * bypassing `NuMcpChild.kill()` which would synchronously prune the
     * bucket from any owning pool. Production consumers should use the
     * lifecycle methods (`callTool`, `kill`, `onExit`) and treat `proc` as
     * private (which it is — TypeScript checks block access; this accessor
     * is the deliberate escape hatch, matching the `_getActiveRoles`
     * pattern in `active.ts`). Returns `null` before `startup()` runs.
     */
    _getProc(): Bun.Subprocess | null {
        return this.proc
    }

    /**
     * Subscribe to this child's terminal exit. The callback fires exactly once
     * — on the first of `kill()` or unexpected child death. If the child has
     * already exited when `onExit` is called, the callback fires on the next
     * microtask. Used by `NuMcpPool` to prune dead buckets from its map.
     */
    onExit(cb: () => void): void {
        if (this.exited) {
            queueMicrotask(cb)
            return
        }
        this.exitListeners.push(cb)
    }

    private fireExit(): void {
        if (this.exited) return
        this.exited = true
        const listeners = this.exitListeners
        this.exitListeners = []
        for (const cb of listeners) {
            try {
                cb()
            } catch {
                // Listener errors are isolated — one bad subscriber must not
                // block the rest from being notified.
            }
        }
    }

    /**
     * Ensure a live child is spawned and the initialize handshake is complete
     * before resolving. Concurrent callers share the same in-flight startup.
     */
    ensureReady(): Promise<void> {
        if (this.readyPromise) return this.readyPromise
        this.readyPromise = this.startup().catch((err) => {
            // Reset on startup rejection so subsequent ensureReady() calls
            // can retry instead of returning the same cached rejection
            // forever. handleExit also clears readyPromise, but only fires
            // if the child was spawned and later exited — a startup that
            // fails BEFORE the spawn (or after a write error that the
            // child outlives momentarily) would otherwise wedge the
            // instance permanently. Concurrent in-flight ensureReady()
            // callers all see the same rejection (correct); only callers
            // after the reset get a fresh attempt.
            this.readyPromise = null
            throw err
        })
        return this.readyPromise
    }

    private async startup(): Promise<void> {
        const proc = Bun.spawn(
            [NU_PATH, "--mcp", "--mcp-transport", "stdio"],
            { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
        )
        this.proc = proc
        addActive(proc, this.role)
        // A child instance may be reused after a previous death (singleton
        // restart-on-death). Re-arm the exit gate so the next death fires
        // any newly-attached listeners.
        this.exited = false
        // Start the line-reader; fire-and-forget — it terminates when the
        // child's stdout closes (child exit). Errors are handled inline.
        void this.runStdoutReader(proc)
        // Wire the exit handler so in-flight pending requests reject rather
        // than hang if the child dies on its own (not via `kill()`).
        void proc.exited.then(() => this.handleExit(proc))
        try {
            await this.handshake()
        } catch (err) {
            // Handshake failure leaves the spawned child + active entry
            // orphaned unless we clean up here. proc.exited may not have
            // fired yet (process could still be alive on a write error), so
            // we eagerly kill + remove. handleExit remains idempotent via
            // its `this.proc !== proc` guard if proc.exited fires later
            // (Copilot 3295712490).
            try {
                proc.kill()
            } catch {
                // Already gone — fine.
            }
            removeActive(proc)
            if (this.proc === proc) this.proc = null
            throw err
        }
    }

    /**
     * Called when a specific child process exits. Only acts if `proc` is
     * still the active child — protects against a stale exit notification
     * arriving after a deliberate `kill()` already cleaned up.
     */
    private handleExit(proc: Bun.Subprocess): void {
        if (this.proc !== proc) return
        removeActive(proc)
        for (const handler of this.pending.values()) {
            handler.reject(new Error("nu --mcp child exited"))
        }
        this.pending.clear()
        this.proc = null
        this.readyPromise = null
        this.fireExit()
    }

    private async runStdoutReader(proc: Bun.Subprocess): Promise<void> {
        const stdout = proc.stdout
        if (!stdout || typeof stdout === "number") return
        const reader = (stdout as ReadableStream<Uint8Array>).getReader()
        const decoder = new TextDecoder()
        let buf = ""
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buf += decoder.decode(value, { stream: true })
                let nl: number
                while ((nl = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, nl)
                    buf = buf.slice(nl + 1)
                    if (line.trim()) this.dispatchLine(proc, line)
                }
            }
        } catch (err) {
            // Non-exit reader error (backpressure, lock contention, decoder
            // failure, etc.). Kill the child so handleExit fires promptly and
            // rejects all pending requests with "nu --mcp child exited" rather
            // than leaving them to hang indefinitely. Without this kill(),
            // sendRpc callers have no REPL-side timeout to save them.
            const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
            process.stderr.write(
                `[nushell-mcp] runStdoutReader error (role=${this.role}): ${detail}\n`,
            )
            try {
                proc.kill()
            } catch {
                // Already gone — fine.
            }
        }
    }

    private dispatchLine(proc: Bun.Subprocess, line: string): void {
        let msg: DecodedMessage
        try {
            msg = decodeMessage(line)
        } catch (err) {
            // Malformed line from the child — discard and log. Without a
            // corresponding sendRpc reject, the caller has no REPL-side
            // timeout, so silence here means an indefinite hang.
            //
            // Default-path log carries ONLY operator-actionable metadata:
            // line length, role, and the error class name. We deliberately
            // do NOT emit `err.message` because Bun's `JSON.parse` embeds
            // offending identifiers from the malformed payload verbatim
            // (e.g. `Unexpected identifier "sk_live_abc123"`) — which would
            // re-leak secrets the line-content redaction was meant to block.
            // Full content (line + parser message) is available behind the
            // explicit debug env var below.
            const errorClass = err instanceof Error ? err.constructor.name : "non-Error"
            process.stderr.write(
                `[nushell-mcp] dispatchLine: malformed line treated as fatal (length=${line.length}, role=${this.role}, error=${errorClass})\n`,
            )
            if (process.env.NUSHELL_MCP_DEBUG_DISPATCH === "1") {
                const preview = line.slice(0, 200).replace(/[^\x20-\x7E]/g, ".")
                const detail = err instanceof Error ? err.message : String(err)
                process.stderr.write(`[nushell-mcp] dispatchLine debug: ${detail}\n`)
                process.stderr.write(`[nushell-mcp] dispatchLine preview: ${preview}\n`)
            }
            // The `nu --mcp` stdio channel is JSON-RPC only; any non-decodable
            // line is a protocol violation, and if the bad line was actually a
            // response, the caller's `sendRpc` would hang forever waiting for
            // it. Kill the child so handleExit rejects all pending requests
            // with "nu --mcp child exited" — mirrors the runStdoutReader catch
            // block above (Copilot 3295803635).
            //
            // Only kill if the bad line came from the CURRENTLY-active proc.
            // Restart-on-death means an old stdout reader can still be
            // draining a dead proc's buffered output while this.proc already
            // points at a newly-spawned replacement; without the identity
            // check, a malformed line from the dead proc would incorrectly
            // kill the healthy new one (Copilot 3296946856).
            if (this.proc === proc) {
                try {
                    proc.kill()
                } catch {
                    // Already gone — fine.
                }
            }
            return
        }
        if (msg.kind === "notification") return // server notifications ignored
        const handler = this.pending.get(msg.id)
        if (!handler) return // unknown id — discard
        this.pending.delete(msg.id)
        handler.resolve(msg)
    }

    /** Send a JSON-RPC request and await the matching response. */
    private sendRpc(method: string, params?: object): Promise<unknown> {
        if (!this.proc?.stdin) {
            return Promise.reject(new Error("nu --mcp child has no stdin"))
        }
        const id = this.nextId++
        const line = encodeRequest(id, method, params)
        return new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (msg) => {
                    if (msg.isError) {
                        const err = msg.payload
                        reject(
                            new Error(
                                `${err.message} (code ${err.code})`,
                            ),
                        )
                    } else {
                        resolve(msg.payload)
                    }
                },
                reject,
            })
            try {
                ;(this.proc!.stdin as unknown as { write(s: string): void }).write(
                    line,
                )
            } catch (err) {
                this.pending.delete(id)
                reject(err instanceof Error ? err : new Error(String(err)))
            }
        })
    }

    /** Run the MCP `initialize` handshake then send the `initialized` note. */
    private async handshake(): Promise<void> {
        await this.sendRpc("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "nushell-mcp-client", version: "0.2.0" },
        })
        const notif =
            JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
            }) + "\n"
        try {
            ;(this.proc!.stdin as unknown as { write(s: string): void }).write(
                notif,
            )
        } catch {
            // If stdin already closed mid-handshake, the next request will
            // throw at write time and the caller learns then. No-op here.
        }
    }

    async callTool(name: string, args: object): Promise<NuMcpToolResponse> {
        await this.ensureReady()
        const result = (await this.sendRpc("tools/call", {
            name,
            arguments: args,
        })) as {
            content?: Array<{ type: string; text: string }>
            isError?: boolean
        }
        const text =
            result.content
                ?.filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n") ?? ""
        if (result.isError === true) {
            return { isError: true, errorText: text }
        }
        return { isError: false, text }
    }

    kill(): void {
        if (this.proc) {
            removeActive(this.proc)
            try {
                this.proc.kill()
            } catch {
                // Already gone — fine.
            }
        }
        for (const handler of this.pending.values()) {
            handler.reject(new Error("nu --mcp client killed"))
        }
        this.pending.clear()
        this.proc = null
        this.readyPromise = null
        this.fireExit()
    }
}

let singletonChild: NuMcpChild | null = null

/**
 * Process-wide singleton client for the doc backend (`nu_doc_search` /
 * `nu_doc_help`). First `callTool()` lazily spawns the child and runs the
 * initialize handshake; subsequent calls reuse. After `kill()`, the next
 * `callTool()` respawns transparently.
 *
 * For non-singleton uses (Plan B's REPL pool), instantiate `NuMcpChild`
 * directly instead of going through this getter.
 */
export function getNuMcpClient(): NuMcpClient {
    if (!singletonChild) singletonChild = new NuMcpChild("doc")
    const child = singletonChild
    return {
        callTool: (name, args) => child.callTool(name, args),
        kill: () => child.kill(),
        isAlive: () => child.isAlive(),
    }
}
