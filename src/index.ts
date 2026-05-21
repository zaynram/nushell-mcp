#!/usr/bin/env bun
/**
 * nushell-mcp — a Model Context Protocol server for Nushell.
 *
 * Spiritual successor to terminal-mcp (lineage: winterm-mcp). Where that
 * server exposed "run a command in a Windows shell", this one is scoped to
 * Nushell specifically and adds queryable documentation.
 *
 * Tools:
 *   nu_run         — execute a Nushell pipeline, returning NUON-structured data
 *   nu_kill        — cancel in-flight runs
 *   nu_doc_search  — search installed commands
 *   nu_doc_command — full help for one command
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
    DEFAULT_TIMEOUT_MS,
    NU_PATH,
    type PipelineResult,
    getCommandDoc,
    getNuVersion,
    killAll,
    runPipeline,
    runRaw,
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

const server = new McpServer({ name: "nushell-mcp", version: "0.1.0" })

// --- nu_run ----------------------------------------------------------------
server.registerTool(
    "nu_run",
    {
        title: "Run a Nushell pipeline",
        description:
            "Evaluate Nushell code in a fresh, one-shot `nu` process. Returns " +
            "the rendered output plus the final value as NUON — a concise " +
            "superset of JSON that preserves Nushell types (filesizes, " +
            "durations, datetimes) — and its `describe` type. Each call is " +
            "independent (no persistent session): pass `cwd`/`env` per call. " +
            "Pass `input` to feed a dataset into the pipeline as `$in`. For " +
            "large results, slice inside the pipeline (e.g. `... | first 50`).",
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
                        "or JSON text. Use to transform data you already hold.",
                ),
            cwd: z
                .string()
                .optional()
                .describe("Working directory to run the pipeline in."),
            env: z
                .record(z.string())
                .optional()
                .describe("Extra environment variables for this call."),
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
                        "for raw `nu -c` execution when the wrapper would interfere.",
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
    async ({ pipeline, input, cwd, env, cleanEnv, timeoutMs, structured }) => {
        const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
        try {
            const result: PipelineResult =
                structured === false
                    ? {
                          ...(await runRaw(pipeline, {
                              cwd,
                              env,
                              cleanEnv,
                              timeoutMs,
                          })),
                          nuon: null,
                          resultType: null,
                      }
                    : await runPipeline(pipeline, {
                          input,
                          cwd,
                          env,
                          cleanEnv,
                          timeoutMs,
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

// --- Lifecycle -------------------------------------------------------------
process.on("SIGINT", () => {
    killAll()
    process.exit(0)
})

const transport = new StdioServerTransport()
await server.connect(transport)
const version = await getNuVersion()
console.error(`nushell-mcp running on stdio (nu ${version} at ${NU_PATH})`)
