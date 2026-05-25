#!/usr/bin/env bun
/**
 * nushell-mcp — a Model Context Protocol server for Nushell.
 *
 * Spiritual successor to terminal-mcp (lineage: winterm-mcp). Where that
 * server exposed "run a command in a Windows shell", this one is scoped to
 * Nushell specifically and adds queryable documentation.
 *
 * Tools (12, see Plan B §3):
 *   nu_exec          — one-shot Nushell pipeline (no cross-call state)
 *   nu_exec_abort    — cancel in-flight nu_exec calls
 *   nu_doc_search    — search installed commands
 *   nu_doc_help      — full help for one command
 *   nu_repl_spawn    — register a persistent REPL bucket
 *   nu_repl_write    — evaluate code inside a bucket; state persists
 *   nu_repl_read     — return the most recent bucket response
 *   nu_repl_clear    — reset a bucket (mode: all | buffer)
 *   nu_repl_status   — snapshot bucket cwd / history / env keys
 *   nu_repl_list     — list active buckets
 *   nu_repl_kill     — terminate one bucket
 *   nu_repl_nuke     — terminate every bucket
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
    DEFAULT_TIMEOUT_MS,
    NU_PATH,
    type PipelineResult,
    abortExec,
    getCommandDoc,
    getNuVersion,
    killAll,
    runPipeline,
    searchDocs,
} from "./nu.js"
import { type BucketStatus, getReplPool } from "./nuMcpPool.js"

/** Build the human-readable text block for a `nu_exec` result. */
function renderExec(result: PipelineResult, timeoutMs: number): string {
    const parts = [result.stdout.replace(/\s+$/, "") || "(no output)"]
    if (result.stderr.trim()) parts.push(`\n[stderr]\n${result.stderr.trim()}`)
    if (result.resultType && result.resultType !== "nothing") {
        parts.push(`\n[result type: ${result.resultType}]`)
    }
    if (result.bashRunner) {
        parts.push(`\n[bashEnv runner: ${result.bashRunner}]`)
    }
    if (result.timedOut) {
        parts.push(`\n[timed out after ${timeoutMs}ms — process killed]`)
    } else if (result.exitCode === null) {
        parts.push("\n[process aborted — terminated by signal]")
    } else if (result.exitCode !== 0) {
        parts.push(`\n[exit code ${result.exitCode}]`)
    }
    return parts.join("\n")
}

const server = new McpServer({ name: "nushell-mcp", version: "0.2.0" })

// --- nu_exec ---------------------------------------------------------------
server.registerTool(
    "nu_exec",
    {
        title: "Run a one-shot Nushell pipeline",
        description:
            "Evaluate Nushell code in a fresh, one-shot `nu` process on the " +
            "host running this server (a local OS process — paths and `sys` " +
            "calls reflect that host, not the caller's sandbox). Returns the " +
            "rendered output plus the final value as NUON — a concise " +
            "superset of JSON that preserves Nushell types (filesizes, " +
            "durations, datetimes) — and its `describe` type. Each call is " +
            "independent (no implicit session): pass `cwd`/`env` per call. " +
            "For cross-call session state (let, $env, cwd), use the " +
            "`nu_repl_*` family instead. Pass `input` to feed a dataset " +
            "into the pipeline as `$in`. Import a bash-style environment " +
            "with `bashEnv` (script runs via WSL/Git Bash/bash; exported " +
            "vars merge into nu's env for this call). For large results, " +
            "slice inside the pipeline (e.g. `... | first 50`).",
        inputSchema: {
            pipeline: z
                .string()
                .min(1)
                .describe(
                    "Nushell code to evaluate. A single pipeline or a multi-line " +
                        "script, e.g. `ls | where size > 1mb | sort-by modified`.",
                ),
            input: z
                .string()
                .optional()
                .describe(
                    "A value to pipe into the pipeline as `$in`, given as NUON " +
                        "or JSON text. Use to transform data you already hold. " +
                        "Honored in both structured and raw modes.",
                ),
            cwd: z
                .string()
                .optional()
                .describe(
                    "Working directory to run the pipeline in. Interpreted by " +
                        "the host OS this server is running on.",
                ),
            env: z
                .record(z.string())
                .optional()
                .describe(
                    "Extra environment variables for this call. Layered on top " +
                        "of any vars captured by `bashEnv`.",
                ),
            cleanEnv: z
                .boolean()
                .optional()
                .describe(
                    "Use only `env` instead of extending the server's environment.",
                ),
            timeoutMs: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                    `Kill the pipeline after this many ms (default ${DEFAULT_TIMEOUT_MS}).`,
                ),
            structured: z
                .boolean()
                .optional()
                .describe(
                    "Capture the final value as NUON (default true). Set false " +
                        "for raw `nu -c` execution when the wrapper would " +
                        "interfere; `input` is still honored.",
                ),
            bashEnv: z
                .string()
                .min(1)
                .optional()
                .describe(
                    "Bash script evaluated through WSL / Git Bash / `bash` before " +
                        "the user pipeline runs. Variables it exports (new or " +
                        "changed vs. baseline) are merged into nu's env for this " +
                        "call. Probe order: NUSHELL_MCP_BASH_PATH override, then " +
                        "WSL, then Git Bash, then `bash`. Errors out if none are " +
                        "available. Empty string is rejected — omit the field " +
                        "instead.",
                ),
        },
        outputSchema: {
            stdout: z.string(),
            stderr: z.string(),
            exitCode: z.number().nullable(),
            timedOut: z.boolean(),
            nuon: z
                .string()
                .nullable()
                .describe("Final value as NUON, or null if not captured."),
            resultType: z
                .string()
                .nullable()
                .describe('`describe` type, e.g. "table<a: int>".'),
            bashRunner: z
                .string()
                .optional()
                .describe(
                    'Label of the bash runner used for `bashEnv` (e.g. "wsl", ' +
                    '"git-bash", "bash", "bash (override)"). Absent when no ' +
                    '`bashEnv` was provided.',
                ),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async ({
        pipeline,
        input,
        cwd,
        env,
        cleanEnv,
        timeoutMs,
        structured,
        bashEnv,
    }) => {
        const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
        try {
            const result: PipelineResult = await runPipeline(pipeline, {
                input,
                cwd,
                env,
                cleanEnv,
                timeoutMs,
                bashEnv,
                noCapture: structured === false,
            })
            return {
                content: [
                    { type: "text", text: renderExec(result, effectiveTimeout) },
                ],
                structuredContent: {
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                    nuon: result.nuon,
                    resultType: result.resultType,
                    bashRunner: result.bashRunner,
                },
                isError: result.timedOut || result.exitCode !== 0,
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [{ type: "text", text: `Failed to run nu: ${message}` }],
                structuredContent: {
                    stdout: "",
                    stderr: message,
                    exitCode: null,
                    timedOut: false,
                    nuon: null,
                    resultType: null,
                },
                isError: true,
            }
        }
    },
)

// --- nu_doc_search ---------------------------------------------------------
server.registerTool(
    "nu_doc_search",
    {
        title: "Search Nushell documentation",
        description:
            "Search every command available in this `nu` (native + plugins + " +
            "aliases + custom defs) by substring against name/description/" +
            "search-terms. Omit `query` (or pass an empty string) to receive " +
            'usage help. Pass `"*"` to list everything (sliced by `limit`). ' +
            "Follow up with `nu_doc_help` for full help on a specific command.",
        inputSchema: {
            query: z
                .string()
                .optional()
                .describe(
                    "Substring to match. Omit or pass an empty string for " +
                        'usage help. Pass "*" for all commands. ' +
                        'e.g. "parse json", "split", "where".',
                ),
            limit: z
                .number()
                .int()
                .positive()
                .max(500)
                .optional()
                .describe("Maximum results to return (default 50)."),
        },
        outputSchema: {
            kind: z.union([z.literal("commands"), z.literal("help")]),
            commands: z
                .array(
                    z.object({
                        name: z.string(),
                        signature: z.string().nullable(),
                        description: z.string().nullable(),
                    }),
                )
                .optional(),
            help: z.string().optional(),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async ({ query, limit }) => {
        try {
            const result = await searchDocs(query, { limit })
            if (result.kind === "help") {
                return {
                    content: [{ type: "text", text: result.help }],
                    structuredContent: { kind: "help", help: result.help },
                }
            }
            const { commands } = result
            const lines = commands.map((c) => {
                const sig = c.signature ? ` ${c.signature}` : ""
                const desc = c.description ? ` — ${c.description}` : ""
                return `- ${c.name}${sig}${desc}`
            })
            const header =
                commands.length === 0
                    ? `No commands match "${query}".`
                    : `${commands.length} command(s) match "${query}":`
            return {
                content: [
                    { type: "text", text: [header, ...lines].join("\n") },
                ],
                structuredContent: { kind: "commands", commands },
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [
                    {
                        type: "text",
                        text: `Documentation search failed: ${message}`,
                    },
                ],
                isError: true,
            }
        }
    },
)

// --- nu_doc_help -----------------------------------------------------------
server.registerTool(
    "nu_doc_help",
    {
        title: "Get full Nushell command help",
        description:
            "Fetch complete help for one Nushell command (usage, flags, " +
            "parameters, examples) via upstream's `command_help`. On a miss, " +
            "returns near-match `suggestions` fuzzy-scored against the full " +
            "command list.",
        inputSchema: {
            name: z
                .string()
                .min(1)
                .describe(
                    'Exact command name, e.g. "str join", "http get", "where".',
                ),
        },
        outputSchema: {
            found: z.boolean(),
            help: z.string(),
            suggestions: z.array(z.string()).optional(),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async ({ name }) => {
        try {
            const doc = await getCommandDoc(name)
            const text = doc.found
                ? doc.help
                : `Command "${name}" not found.` +
                  (doc.suggestions?.length
                      ? `\n\nDid you mean:\n${doc.suggestions
                            .map((s) => `- ${s}`)
                            .join("\n")}`
                      : "")
            return {
                content: [{ type: "text", text }],
                structuredContent: {
                    found: doc.found,
                    help: doc.help,
                    suggestions: doc.suggestions,
                },
                isError: !doc.found,
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [
                    {
                        type: "text",
                        text: `Documentation lookup failed: ${message}`,
                    },
                ],
                isError: true,
            }
        }
    },
)

// --- nu_repl_spawn ---------------------------------------------------------
const REPL_KEY = z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/)
    .describe(
        "Bucket name. Restricted to `[A-Za-z0-9_-]+` so it can be used " +
            "internally for bookkeeping safely.",
    )

server.registerTool(
    "nu_repl_spawn",
    {
        title: "Spawn a persistent Nushell REPL bucket",
        description:
            "Register a new REPL bucket backed by a long-lived `nu --mcp` " +
            "process. The child is spawned lazily on the first call. Errors " +
            "if the key is already taken or the pool is at capacity " +
            "(default 10, override via NUSHELL_MCP_MAX_REPLS).",
        inputSchema: { key: REPL_KEY },
        outputSchema: { key: z.string() },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    },
    async ({ key }) => {
        try {
            getReplPool().spawn(key)
            return {
                content: [{ type: "text", text: `Spawned REPL bucket "${key}".` }],
                structuredContent: { key },
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [
                    { type: "text", text: `Spawn failed: ${message}` },
                ],
                isError: true,
            }
        }
    },
)

// --- nu_repl_list ----------------------------------------------------------
server.registerTool(
    "nu_repl_list",
    {
        title: "List active REPL buckets",
        description: "Return the set of bucket keys currently registered.",
        inputSchema: {},
        outputSchema: { keys: z.array(z.string()) },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async () => {
        const keys = getReplPool().list()
        const text = keys.length
            ? `Active REPL buckets (${keys.length}):\n${keys.map((k) => `- ${k}`).join("\n")}`
            : "No active REPL buckets."
        return {
            content: [{ type: "text", text }],
            structuredContent: { keys },
        }
    },
)

// --- nu_repl_kill ----------------------------------------------------------
server.registerTool(
    "nu_repl_kill",
    {
        title: "Kill a REPL bucket",
        description:
            "Terminate the `nu --mcp` child for a bucket and unregister it. " +
            "Errors if no bucket with that key is registered. This is the " +
            "panic button for a wedged bucket: kill returns promptly even " +
            "if a long-running pipeline (e.g. `sleep 1hr`, infinite loop) " +
            "is in flight. Prefer this over `nu_repl_clear` when a call " +
            "is stuck — `nu_repl_clear` waits for the in-flight call to " +
            "complete before resetting.",
        inputSchema: { key: REPL_KEY },
        outputSchema: { key: z.string(), killed: z.boolean() },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
        },
    },
    async ({ key }) => {
        try {
            const killed = await getReplPool().kill(key)
            if (!killed) {
                return {
                    content: [
                        { type: "text", text: `No REPL bucket named "${key}".` },
                    ],
                    structuredContent: { key, killed: false },
                    isError: true,
                }
            }
            return {
                content: [{ type: "text", text: `Killed REPL bucket "${key}".` }],
                structuredContent: { key, killed: true },
            }
        } catch (err) {
            // pool.kill is async (awaits mutex for ordering). A rejection
            // there would otherwise propagate out of the tool callback —
            // mirror nu_repl_write's catch shape so the client sees a
            // structured error rather than a torn transport response.
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [
                    { type: "text", text: `Kill failed: ${message}` },
                ],
                structuredContent: { key, killed: false },
                isError: true,
            }
        }
    },
)

// --- nu_repl_write ---------------------------------------------------------
server.registerTool(
    "nu_repl_write",
    {
        title: "Execute Nushell code in a REPL bucket",
        description:
            "Evaluate a pipeline inside the long-lived `nu --mcp` child for " +
            "the bucket. State (`let`, `$env`, cwd, defs) persists across " +
            "calls within the bucket. Calls to the same bucket serialize; " +
            "calls to different buckets run in parallel. Errors if the " +
            "bucket does not exist — use `nu_repl_spawn` first.",
        inputSchema: {
            key: REPL_KEY,
            input: z
                .string()
                .min(1)
                .describe(
                    "Nushell pipeline to evaluate inside the bucket's " +
                        "session. Multi-line scripts are allowed.",
                ),
        },
        outputSchema: {
            key: z.string(),
            output: z.string(),
            cwd: z.string().optional(),
            historyIndex: z.number().optional(),
            timestamp: z.string().optional(),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    },
    async ({ key, input }) => {
        const pool = getReplPool()
        try {
            // Destructure atomically: the envelope snapshot is taken while the
            // mutex is still held, so the bucket dying after the call cannot
            // cause a separate pool.envelope(key) lookup to throw "bucket does
            // not exist" even though the call itself returned a valid response.
            const { response, envelope } = await pool.call(key, "evaluate", { input })
            // Narrow on the NuMcpToolResponse discriminator: success → text,
            // error → errorText. The MCP wire schema for structuredContent.output
            // stays a single string field — we map errorText back into it on
            // the error branch so callers don't see a missing field.
            const output = response.isError ? response.errorText : response.text
            // Branch on the envelope discriminator: only the `ok` variant
            // carries cwd/historyIndex/timestamp. An `empty` envelope (e.g.
            // a malformed evaluate response that didn't parse) emits just
            // key + output, matching the optional-field outputSchema.
            const structuredContent =
                envelope.kind === "ok"
                    ? {
                          key,
                          output,
                          cwd: envelope.cwd,
                          ...(envelope.historyIndex !== undefined && {
                              historyIndex: envelope.historyIndex,
                          }),
                          ...(envelope.timestamp !== undefined && {
                              timestamp: envelope.timestamp,
                          }),
                      }
                    : { key, output }
            return {
                content: [{ type: "text", text: output }],
                structuredContent,
                isError: response.isError,
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [
                    { type: "text", text: `Write failed: ${message}` },
                ],
                isError: true,
            }
        }
    },
)

// --- nu_repl_read ----------------------------------------------------------
server.registerTool(
    "nu_repl_read",
    {
        title: "Read the last response from a REPL bucket",
        description:
            "Return the most recent `nu_repl_write` response for a bucket. " +
            "Returns `response: null` on a freshly-spawned bucket that has " +
            "never been written. Errors if the bucket does not exist.",
        inputSchema: { key: REPL_KEY },
        outputSchema: {
            key: z.string(),
            response: z
                .object({
                    text: z.string(),
                    isError: z.boolean(),
                })
                .nullable(),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async ({ key }) => {
        try {
            const response = getReplPool().lastResponse(key)
            // Narrow on the union for the rendered text. The wire schema
            // (structuredContent.response) keeps a single `text` field, so
            // we project errorText → text on the error branch — callers see
            // a stable shape and can still discriminate via `isError`.
            const renderedText =
                response === null
                    ? `Bucket "${key}" has no response yet.`
                    : response.isError
                      ? response.errorText
                      : response.text
            const structuredResponse =
                response === null
                    ? null
                    : response.isError
                      ? { isError: true as const, text: response.errorText }
                      : { isError: false as const, text: response.text }
            return {
                content: [{ type: "text", text: renderedText }],
                structuredContent: { key, response: structuredResponse },
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [{ type: "text", text: `Read failed: ${message}` }],
                isError: true,
            }
        }
    },
)

// --- nu_repl_clear ---------------------------------------------------------
server.registerTool(
    "nu_repl_clear",
    {
        title: "Clear a REPL bucket's state or buffer",
        description:
            "Reset a bucket. `mode: 'all'` (default) kills the child and " +
            "respawns it — wipes session state (`let`, `$env`, cwd). " +
            "`mode: 'buffer'` empties the response buffer only; session " +
            "state survives. Note: `mode: 'all'` waits for any in-flight " +
            "call on the bucket to complete before resetting. To break out " +
            "of a wedged long-running pipeline, use `nu_repl_kill` (then " +
            "`nu_repl_spawn` to start fresh) instead.",
        inputSchema: {
            key: REPL_KEY,
            mode: z.enum(["all", "buffer"]).optional(),
        },
        outputSchema: { key: z.string(), mode: z.enum(["all", "buffer"]) },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async ({ key, mode }) => {
        const effective = mode ?? "all"
        try {
            await getReplPool().clear(key, effective)
            return {
                content: [
                    {
                        type: "text",
                        text: `Cleared bucket "${key}" (mode: ${effective}).`,
                    },
                ],
                structuredContent: { key, mode: effective },
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [{ type: "text", text: `Clear failed: ${message}` }],
                isError: true,
            }
        }
    },
)

// --- nu_repl_status --------------------------------------------------------
server.registerTool(
    "nu_repl_status",
    {
        title: "Snapshot a REPL bucket's state",
        description:
            "Return the bucket's current `cwd`, `historyIndex`, last " +
            "`timestamp` (from the cached envelope), and `envKeys` (probed " +
            "side-channel via `$env | columns`). The env probe increments " +
            "the bucket's history index — treat the snapshot as best-effort. " +
            "Probe failures surface as `probeError` rather than throwing; " +
            "when set, `envKeys` will be an empty array.",
        inputSchema: { key: REPL_KEY },
        outputSchema: {
            key: z.string(),
            cwd: z.string().optional(),
            historyIndex: z.number().optional(),
            timestamp: z.string().optional(),
            envKeys: z.array(z.string()),
            probeError: z.string().optional(),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    },
    async ({ key }) => {
        try {
            const status: BucketStatus = await getReplPool().status(key)
            // Branch on the status discriminator. The `ok` variant carries
            // envKeys plus the post-probe envelope fields; the `probe-error`
            // variant carries probeError plus the cached envelope from
            // before the probe failed (envKeys is empty in this case).
            if (status.kind === "ok") {
                const summary = [
                    `Bucket "${key}":`,
                    `  cwd: ${status.cwd ?? "(unknown)"}`,
                    `  historyIndex: ${status.historyIndex ?? "(unknown)"}`,
                    `  envKeys: ${status.envKeys.length} entries`,
                ].join("\n")
                return {
                    content: [{ type: "text", text: summary }],
                    structuredContent: {
                        key,
                        ...(status.cwd !== undefined && { cwd: status.cwd }),
                        ...(status.historyIndex !== undefined && {
                            historyIndex: status.historyIndex,
                        }),
                        ...(status.timestamp !== undefined && {
                            timestamp: status.timestamp,
                        }),
                        envKeys: status.envKeys,
                    },
                }
            }
            // probe-error: surface cached envelope fields if any.
            const cached = status.cachedEnvelope
            const summary = [
                `Bucket "${key}":`,
                `  cwd: ${cached.kind === "ok" ? cached.cwd : "(unknown)"}`,
                `  historyIndex: ${
                    cached.kind === "ok" && cached.historyIndex !== undefined
                        ? cached.historyIndex
                        : "(unknown)"
                }`,
                `  envKeys: 0 entries\n  probeError: ${status.probeError}`,
            ].join("\n")
            return {
                content: [{ type: "text", text: summary }],
                structuredContent: {
                    key,
                    ...(cached.kind === "ok" && {
                        cwd: cached.cwd,
                        ...(cached.historyIndex !== undefined && {
                            historyIndex: cached.historyIndex,
                        }),
                        ...(cached.timestamp !== undefined && {
                            timestamp: cached.timestamp,
                        }),
                    }),
                    envKeys: [],
                    probeError: status.probeError,
                },
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [
                    { type: "text", text: `Status failed: ${message}` },
                ],
                isError: true,
            }
        }
    },
)

// --- nu_repl_nuke ----------------------------------------------------------
server.registerTool(
    "nu_repl_nuke",
    {
        title: "Kill every REPL bucket",
        description: "Terminate every registered REPL bucket. Idempotent.",
        inputSchema: {},
        outputSchema: { killed: z.number() },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async () => {
        const killed = getReplPool().nukeAll()
        return {
            content: [
                {
                    type: "text",
                    text: `Killed ${killed} REPL bucket(s).`,
                },
            ],
            structuredContent: { killed },
        }
    },
)

// --- nu_exec_abort ---------------------------------------------------------
server.registerTool(
    "nu_exec_abort",
    {
        title: "Abort all in-flight nu_exec calls",
        description:
            "Kill every active one-shot exec subprocess AND any bashEnv " +
            "runner subprocess associated with an in-flight nu_exec call. " +
            "Leaves REPL buckets and the doc singleton untouched — use " +
            "`nu_repl_kill` or `nu_repl_nuke` to terminate REPL state.",
        inputSchema: {},
        outputSchema: { aborted: z.number() },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async () => {
        const aborted = abortExec()
        return {
            content: [
                {
                    type: "text",
                    text: `Aborted ${aborted} exec/bash subprocess(es).`,
                },
            ],
            structuredContent: { aborted },
        }
    },
)

// --- Lifecycle -------------------------------------------------------------
process.on("SIGINT", () => {
    killAll()
    process.exit(0)
})

const transport = new StdioServerTransport()
await server.connect(transport)
const version = await getNuVersion()
console.error(`nushell-mcp running on stdio (nu ${version} at ${NU_PATH})`)
