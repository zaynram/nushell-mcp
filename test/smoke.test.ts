/**
 * Smoke tests for nushell-mcp.
 *
 * Covers the two required capabilities directly against the nu layer:
 *   (a) queryable documentation — searchDocs / getCommandDoc
 *   (b) execution environment   — runPipeline / runRaw
 * plus one end-to-end check that the MCP server boots and lists its tools.
 *
 * Run with: bun test
 */
import { describe, expect, test } from "bun:test"
import {
    getCommandDoc,
    getNuVersion,
    runPipeline,
    runRaw,
    searchDocs,
} from "../src/nu.js"

describe("installed-version detection", () => {
    test("getNuVersion reports a real semver-ish version", async () => {
        const version = await getNuVersion()
        expect(version).toMatch(/^\d+\.\d+\.\d+/)
    })
})

describe("capability (a): queryable documentation", () => {
    test("searchDocs finds commands by keyword", async () => {
        const { count, matches } = await searchDocs("split")
        expect(count).toBeGreaterThan(0)
        expect(matches.some(m => m.name.includes("split"))).toBe(true)
    })

    test("searchDocs keeps recall for multi-word queries", async () => {
        const { matches } = await searchDocs("parse json")
        expect(matches.some(m => m.name === "from json")).toBe(true)
    })

    test("searchDocs honors the category filter", async () => {
        const { matches } = await searchDocs("str", { category: "strings" })
        expect(matches.length).toBeGreaterThan(0)
        expect(matches.every(m => m.category === "strings")).toBe(true)
    })

    test("searchDocs reports the installed version", async () => {
        const { nushellVersion } = await searchDocs("split")
        expect(nushellVersion).toMatch(/^\d+\.\d+/)
    })

    test("getCommandDoc returns help text and structured info", async () => {
        const doc = await getCommandDoc("str join")
        expect(doc.found).toBe(true)
        expect(doc.help.toLowerCase()).toContain("join")
        expect(doc.info).not.toBeNull()
        expect(doc.nushellVersion).toMatch(/^\d+\.\d+/)
    })

    test("getCommandDoc suggests near matches for unknown commands", async () => {
        const doc = await getCommandDoc("strjoin")
        expect(doc.found).toBe(false)
        expect(doc.suggestions?.length).toBeGreaterThan(0)
    })
})

describe("capability (b): execution environment", () => {
    test("runPipeline serializes a scalar result as NUON", async () => {
        const r = await runPipeline("[1 2 3] | math sum")
        expect(r.exitCode).toBe(0)
        expect(r.nuon).toBe("6")
        expect(r.resultType).toBe("int")
    })

    test("runPipeline serializes a table as NUON with its type", async () => {
        const r = await runPipeline("[[a b]; [1 2] [3 4]]")
        expect(r.resultType).toBe("table<a: int, b: int>")
        expect(r.nuon).toContain("[a, b]")
    })

    test("runPipeline preserves Nushell-native types in NUON", async () => {
        // A filesize survives as a `b`-suffixed literal, a type JSON cannot
        // express — it would flatten to a bare number.
        const r = await runPipeline("1kb")
        expect(r.resultType).toBe("filesize")
        expect(r.nuon).toBe("1000b")
    })

    test("runPipeline pipes `input` into the pipeline as $in", async () => {
        // `input` accepts JSON, since `from nuon` is a superset of JSON.
        const r = await runPipeline("where a > 1 | length", {
            input: '[{"a": 1}, {"a": 2}, {"a": 3}]',
        })
        expect(r.exitCode).toBe(0)
        expect(r.nuon).toBe("2")
    })

    test("runPipeline surfaces a non-zero exit code", async () => {
        const r = await runPipeline("error make { msg: 'boom' }")
        expect(r.exitCode).not.toBe(0)
        expect(r.stderr).toContain("boom")
    })

    test("runRaw streams plain stdout", async () => {
        const r = await runRaw("print 'hello-smoke'")
        expect(r.stdout).toContain("hello-smoke")
        expect(r.exitCode).toBe(0)
    })

    test("a per-call timeout cancels a stuck pipeline", async () => {
        const r = await runRaw("sleep 5sec", { timeoutMs: 800 })
        expect(r.timedOut).toBe(true)
    })
})

describe("MCP server wiring", () => {
    test(
        "server initializes over stdio and lists its four tools",
        async () => {
            const proc = Bun.spawn(
                ["bun", `${import.meta.dir}/../src/index.ts`],
                { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
            )

            const reader = proc.stdout.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            // Read one newline-delimited JSON-RPC message from the server.
            const nextMessage = async (): Promise<Record<string, unknown>> => {
                for (;;) {
                    const newline = buffer.indexOf("\n")
                    if (newline >= 0) {
                        const line = buffer.slice(0, newline).trim()
                        buffer = buffer.slice(newline + 1)
                        if (line) return JSON.parse(line)
                        continue
                    }
                    const { value, done } = await reader.read()
                    if (done) throw new Error("server closed stdout early")
                    buffer += decoder.decode(value, { stream: true })
                }
            }
            const send = (message: object) =>
                proc.stdin.write(JSON.stringify(message) + "\n")

            try {
                // The SDK processes line-delimited messages in order, so the
                // full handshake can be sent in one batch.
                send({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        clientInfo: { name: "smoke", version: "0" },
                    },
                })
                send({ jsonrpc: "2.0", method: "notifications/initialized" })
                send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
                await proc.stdin.flush()

                const initResponse = await nextMessage()
                expect(initResponse.id).toBe(1)
                const listResponse = (await nextMessage()) as {
                    result: { tools: { name: string }[] }
                }
                const toolNames = listResponse.result.tools
                    .map(t => t.name)
                    .sort()
                expect(toolNames).toEqual([
                    "nu_doc_command",
                    "nu_doc_search",
                    "nu_kill",
                    "nu_run",
                ])
            } finally {
                reader.cancel().catch(() => {})
                proc.kill()
            }
        },
        15_000,
    )
})
