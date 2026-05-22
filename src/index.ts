#!/usr/bin/env bun
/**
 * nushell-mcp — a Model Context Protocol server for Nushell.
 *
 * Spiritual successor to terminal-mcp (lineage: winterm-mcp). Where that
 * server exposed "run a command in a Windows shell", this one is scoped to
 * Nushell specifically and adds queryable documentation.
 *
 * Tools:
 *   nu_run           — execute a Nushell pipeline, returning NUON-structured data
 *   nu_kill          — cancel in-flight runs
 *   nu_doc_search    — search installed commands
 *   nu_doc_command   — full help for one command
 *   nu_persist_clear — wipe a persisted-env bucket
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
    DEFAULT_TIMEOUT_MS,
    NU_PATH,
    PERSIST_DIR,
    type PipelineResult,
    clearPersistedEnv,
    getCommandDoc,
    getNuVersion,
    killAll,
    runPipeline,
    searchDocs,
} from "./nu.js"

/** Build the human-readable text block for a `nu_run` result. */
function renderRun(result: PipelineResult, timeoutMs: number): string {
    const parts = [result.stdout.replace(/\s+$/, "") || "(no output)"]
    if (result.stderr.trim()) parts.push(`\n[stderr]\n${result.stderr.trim()}`)
    if (result.resultType && result.resultType !== "nothing") {
        parts.push(`\n[result type: ${result.resultType}]`)
    }
    if (result.timedOut) {
        parts.push(`\n[timed out after ${timeoutMs}ms — process killed]`)
    } else if (result.exitCode !== 0 && result.exitCode !== null) {
        parts.push(`\n[exit code ${result.exitCode}]`)
    }
    return parts.join("\n")
}

const server = new McpServer({ name: "nushell-mcp", version: "0.2.0" })

// --- nu_run ----------------------------------------------------------------
server.registerTool(
    "nu_run",
    {
        title: "Run a Nushell pipeline",
        description:
            "Evaluate Nushell code in a fresh, one-shot `nu` process on the " +
            "host running this server (a local OS process — paths and `sys` " +
            "calls reflect that host, not the caller's sandbox). Returns the " +
            "rendered output plus the final value as NUON — a concise " +
            "superset of JSON that preserves Nushell types (filesizes, " +
            "durations, datetimes) — and its `describe` type. Each call is " +
            "independent (no implicit session): pass `cwd`/`env` per call. " +
            "Pass `input` to feed a dataset into the pipeline as `$in` (works " +
            "in both structured and raw modes). Opt into cross-call carryover " +
            "with `persistEnv` (file-backed env bucket keyed by `persistKey`) " +
            "or import a bash-style environment with `bashEnv` (script runs " +
            "via WSL/Git Bash/bash; exported vars merge into nu's env for " +
            "this call). For large results, slice inside the pipeline " +
            "(e.g. `... | first 50`).",
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
            persistEnv: z
                .boolean()
                .optional()
                .describe(
                    "When true, load `$env` from a server-side bucket before the " +
                        "pipeline runs and save it again afterward. Off by default — " +
                        "calls remain independent unless you opt in. Only " +
                        "JSON-serializable env values round-trip; closures and " +
                        "similar are silently dropped.",
                ),
            persistKey: z
                .string()
                .regex(/^[A-Za-z0-9_-]+$/)
                .optional()
                .describe(
                    'Bucket name for `persistEnv`. Defaults to "default" — all ' +
                        "calls share one env unless a key is supplied. Restricted " +
                        "to `[A-Za-z0-9_-]+` so it can be used as a filename safely.",
                ),
            persistCwd: z
                .boolean()
                .optional()
                .describe(
                    "When `persistEnv` is on and `cwd` is not supplied, use the " +
                        "persisted `$env.PWD` as the call's working directory. " +
                        "Lets `cd foo` survive across calls. Off by default.",
                ),
            bashEnv: z
                .string()
                .optional()
                .describe(
                    "Bash script evaluated through WSL / Git Bash / `bash` before " +
                        "the user pipeline runs. Variables it exports (new or " +
                        "changed vs. baseline) are merged into nu's env for this " +
                        "call. Probe order: NUSHELL_MCP_BASH_PATH override, then " +
                        "WSL, then Git Bash, then `bash`. Errors out if none are " +
                        "available.",
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
        persistEnv,
        persistKey,
        persistCwd,
        bashEnv,
    }) => {
        const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
        try {
            // Always go through runPipeline so persistEnv, persistKey,
            // persistCwd, and bashEnv are honored regardless of `structured`.
            // `structured: false` just toggles the NUON/describe capture off.
            const result: PipelineResult = await runPipeline(pipeline, {
                input,
                cwd,
                env,
                cleanEnv,
                timeoutMs,
                persistEnv,
                persistKey,
                persistCwd,
                bashEnv,
                noCapture: structured === false,
            })
            return {
                content: [
                    { type: "text", text: renderRun(result, effectiveTimeout) },
                ],
                structuredContent: {
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                    nuon: result.nuon,
                    resultType: result.resultType,
                },
                isError:
                    result.timedOut ||
                    (result.exitCode !== 0 && result.exitCode !== null),
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

// --- nu_kill ---------------------------------------------------------------
server.registerTool(
    "nu_kill",
    {
        title: "Cancel running Nushell processes",
        description:
            "Terminate every `nu` process this server currently has in flight. " +
            "Use to recover from a long-running or stuck pipeline.",
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
        const killed = killAll()
        return {
            content: [
                {
                    type: "text",
                    text: `Terminated ${killed} running nu process(es).`,
                },
            ],
            structuredContent: { killed },
        }
    },
)

// --- nu_doc_search ---------------------------------------------------------
server.registerTool(
    "nu_doc_search",
    {
        title: "Search Nushell documentation",
        description:
            "Search every installed Nushell command by name, description, and " +
            "search terms. Results reflect the installed `nu` version, reported " +
            "as `nushellVersion`. Follow up with `nu_doc_command` for full help.",
        inputSchema: {
            query: z
                .string()
                .min(1)
                .describe('Text to search for, e.g. "parse json", "split".'),
            category: z
                .string()
                .optional()
                .describe(
                    'Restrict to one category, e.g. "filters", "strings", "formats".',
                ),
            limit: z
                .number()
                .int()
                .positive()
                .max(200)
                .optional()
                .describe("Maximum results to return (default 50)."),
        },
        outputSchema: {
            nushellVersion: z.string(),
            count: z.number(),
            matches: z.array(
                z.object({
                    name: z.string(),
                    category: z.string().nullable(),
                    command_type: z.string().nullable(),
                    description: z.string().nullable(),
                }),
            ),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async ({ query, category, limit }) => {
        try {
            const { count, matches, nushellVersion } = await searchDocs(query, {
                category,
                limit,
            })
            const lines = matches.map(
                m => `- ${m.name} (${m.category ?? "?"}) — ${m.description ?? ""}`,
            )
            const header =
                count === 0
                    ? `No commands match "${query}" (Nushell ${nushellVersion}).`
                    : `${count} command(s) match "${query}" (Nushell ${nushellVersion}):`
            return {
                content: [
                    { type: "text", text: [header, ...lines].join("\n") },
                ],
                structuredContent: { nushellVersion, count, matches },
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

// --- nu_doc_command --------------------------------------------------------
server.registerTool(
    "nu_doc_command",
    {
        title: "Get full Nushell command help",
        description:
            "Fetch complete help for one Nushell command: usage, flags, " +
            "parameters, input/output types, and examples. `help` is the " +
            "formatted text; `info` carries the same data structured. Reflects " +
            "the installed `nu` version. On a miss, returns `suggestions`.",
        inputSchema: {
            name: z
                .string()
                .min(1)
                .describe(
                    'Exact command name, e.g. "str join", "http get", "where".',
                ),
        },
        outputSchema: {
            nushellVersion: z.string(),
            found: z.boolean(),
            help: z.string(),
            info: z.unknown(),
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
                : `Command "${name}" not found in Nushell ${doc.nushellVersion}.` +
                  (doc.suggestions?.length
                      ? `\n\nDid you mean:\n${doc.suggestions
                            .map(s => `- ${s}`)
                            .join("\n")}`
                      : "")
            return {
                content: [{ type: "text", text }],
                structuredContent: {
                    nushellVersion: doc.nushellVersion,
                    found: doc.found,
                    help: doc.help,
                    info: doc.info,
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

// --- nu_persist_clear ------------------------------------------------------
server.registerTool(
    "nu_persist_clear",
    {
        title: "Clear a persisted-env bucket",
        description:
            "Delete the persisted `$env` file for a `nu_run` persistence " +
            'bucket. Defaults to the "default" bucket when `key` is omitted. ' +
            "Idempotent — returns `existed: false` if the bucket had no file. " +
            `Buckets live under \`${PERSIST_DIR}\`.`,
        inputSchema: {
            key: z
                .string()
                .regex(/^[A-Za-z0-9_-]+$/)
                .optional()
                .describe(
                    'Bucket name to clear. Defaults to "default". Must match ' +
                        "`[A-Za-z0-9_-]+`.",
                ),
        },
        outputSchema: {
            key: z.string(),
            existed: z.boolean(),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    async ({ key }) => {
        try {
            const result = await clearPersistedEnv(key)
            return {
                content: [
                    {
                        type: "text",
                        text: result.existed
                            ? `Cleared persisted env bucket "${result.key}".`
                            : `No persisted env file found for bucket "${result.key}" (nothing to clear).`,
                    },
                ],
                structuredContent: {
                    key: result.key,
                    existed: result.existed,
                },
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [
                    {
                        type: "text",
                        text: `Clear persisted env failed: ${message}`,
                    },
                ],
                isError: true,
            }
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
