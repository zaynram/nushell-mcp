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
import { tmpdir } from "node:os"
import {
    _resetBashRunnerProbe,
    getCommandDoc,
    getNuVersion,
    killAll,
    loadBashEnv,
    runPipeline,
    runRaw,
    searchDocs,
} from "../src/nu.js"

// Use the OS temp dir instead of a hardcoded "/tmp" so the cwd / status
// portability assertions stay valid across Linux, macOS, and Windows
// (Copilot 3297050891).
const TMP_DIR = tmpdir()

/**
 * Shared bash-runtime probe. `loadBashEnv("true")` exercises the same detect /
 * spawn path the real bridge uses, so a success here means the bashEnv tests
 * will run. On a host with no runtime (no WSL, no Git Bash, no bash), the test
 * returns early instead of failing.
 */
let bashRuntimeAvailableCache: boolean | undefined
async function bashRuntimeAvailable(): Promise<boolean> {
    if (bashRuntimeAvailableCache !== undefined) return bashRuntimeAvailableCache
    try {
        await loadBashEnv("true")
        bashRuntimeAvailableCache = true
    } catch {
        bashRuntimeAvailableCache = false
    }
    return bashRuntimeAvailableCache
}

describe("installed-version detection", () => {
    test("getNuVersion reports a real semver-ish version", async () => {
        const version = await getNuVersion()
        expect(version).toMatch(/^\d+\.\d+\.\d+/)
    })
})

describe("capability (a): queryable documentation", () => {
    test("searchDocs finds commands by substring", async () => {
        const result = await searchDocs("split")
        expect(result.kind).toBe("commands")
        if (result.kind !== "commands") throw new Error("unreachable")
        expect(result.commands.length).toBeGreaterThan(0)
        expect(result.commands.some(c => c.name.includes("split"))).toBe(true)
    })

    test("searchDocs with no query returns usage help", async () => {
        const result = await searchDocs()
        expect(result.kind).toBe("help")
        if (result.kind !== "help") throw new Error("unreachable")
        expect(result.help).toContain("nu_doc_search")
    })

    test("searchDocs with empty string returns usage help", async () => {
        const result = await searchDocs("")
        expect(result.kind).toBe("help")
    })

    test('searchDocs("*") returns the full command list, sliced by limit', async () => {
        const result = await searchDocs("*", { limit: 5 })
        expect(result.kind).toBe("commands")
        if (result.kind !== "commands") throw new Error("unreachable")
        expect(result.commands.length).toBe(5)
    })

    test("getCommandDoc returns help text on hit", async () => {
        const doc = await getCommandDoc("str join")
        expect(doc.found).toBe(true)
        expect(doc.help.toLowerCase()).toContain("join")
        expect(doc.suggestions).toBeUndefined()
    })

    test("getCommandDoc suggests near matches for unknown commands", async () => {
        const doc = await getCommandDoc("strjoin")
        expect(doc.found).toBe(false)
        expect(doc.suggestions?.length).toBeGreaterThan(0)
        // Suggestions should include the actual correct command.
        expect(doc.suggestions).toContain("str join")
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

    // Regression: prior to the input-in-raw-mode fix, `input` was destructured
    // off the tool call but silently dropped when `structured: false`, so the
    // pipeline saw no `$in` and errored "pipeline empty".
    test("runRaw threads `input` into the pipeline as $in", async () => {
        const r = await runRaw("where a > 1 | length", {
            input: '[{"a": 1}, {"a": 2}, {"a": 3}]',
        })
        expect(r.exitCode).toBe(0)
        expect(r.stdout).toContain("2")
    })
})

describe("bashEnv bridge", () => {
    test(
        "exported vars from the snippet land in nu's $env",
        async () => {
            if (!(await bashRuntimeAvailable())) {
                console.warn("skipping bashEnv test — no bash runtime detected")
                return
            }
            const r = await runPipeline(
                "$env.NUSHELL_MCP_FROM_BASH? | default 'missing'",
                {
                    bashEnv: "export NUSHELL_MCP_FROM_BASH=hello-from-bash",
                },
            )
            expect(r.exitCode).toBe(0)
            expect(r.nuon).toBe('"hello-from-bash"')
        },
        20_000,
    )

    test(
        "loadBashEnv returns only changed vars",
        async () => {
            if (!(await bashRuntimeAvailable())) {
                console.warn("skipping bashEnv test — no bash runtime detected")
                return
            }
            const result = await loadBashEnv("export NUSHELL_MCP_DELTA=set-once")
            expect(result.vars.NUSHELL_MCP_DELTA).toBe("set-once")
            // Variables we did NOT touch must not appear in the delta.
            expect(result.vars.PATH).toBeUndefined()
            expect(result.vars.HOME).toBeUndefined()
            expect(result.runner.length).toBeGreaterThan(0)
        },
        20_000,
    )
})

// Tests targeting the issues surfaced during the audit pass.
describe("audit regressions", () => {
    test(
        "noCapture preserves bashEnv",
        async () => {
            if (!(await bashRuntimeAvailable())) return
            const r = await runPipeline("print $env.NC_FROM_BASH", {
                bashEnv: "export NC_FROM_BASH=nocapture-ok",
                noCapture: true,
            })
            expect(r.exitCode).toBe(0)
            expect(r.stdout).toContain("nocapture-ok")
            expect(r.nuon).toBeNull()
            expect(r.resultType).toBeNull()
        },
        20_000,
    )

    // Was: `${script}\nenv` mixed user-script stdout into the env-var parse.
    // A line like `echo foo=bar` would create a phantom `foo` env var. Fix
    // redirects prelude stdout to /dev/null and parses env -0 after a sentinel.
    test(
        "bashEnv ignores prelude stdout noise",
        async () => {
            if (!(await bashRuntimeAvailable())) return
            const result = await loadBashEnv(
                [
                    'echo "fake_key=fake_value"',
                    'echo "another spurious line"',
                    "printf 'NC_NOT_AN_ENV=should-not-appear\\n'",
                    "export NC_REAL=actually-set",
                ].join("\n"),
            )
            expect(result.vars.NC_REAL).toBe("actually-set")
            expect(result.vars.fake_key).toBeUndefined()
            expect(result.vars.NC_NOT_AN_ENV).toBeUndefined()
        },
        20_000,
    )

    // Was: line-based env parser broke any value containing `\n`. env -0 +
    // NUL parsing now round-trips embedded newlines.
    test(
        "bashEnv preserves multi-line values",
        async () => {
            if (!(await bashRuntimeAvailable())) return
            const result = await loadBashEnv(
                "export NC_MULTI=$'line-one\\nline-two\\nline-three'",
            )
            expect(result.vars.NC_MULTI).toBe(
                "line-one\nline-two\nline-three",
            )
        },
        20_000,
    )

    test("bashEnv: empty script is a no-op (no subprocess fired)", async () => {
        // Force a failure if any subprocess runs by pointing the override at a
        // binary that does not exist. If loadBashEnv is invoked it errors; if
        // runPipeline correctly skips the bridge for empty bashEnv, the
        // pipeline runs unaffected.
        const prevOverride = process.env.NUSHELL_MCP_BASH_PATH
        process.env.NUSHELL_MCP_BASH_PATH =
            "/definitely/not/a/real/bash/binary"
        try {
            const r = await runPipeline("1 + 1", { bashEnv: "" })
            expect(r.exitCode).toBe(0)
            expect(r.nuon).toBe("2")
        } finally {
            if (prevOverride === undefined) {
                delete process.env.NUSHELL_MCP_BASH_PATH
            } else {
                process.env.NUSHELL_MCP_BASH_PATH = prevOverride
            }
        }
    })

    test(
        "bashEnv surfaces stderr on prelude failure",
        async () => {
            if (!(await bashRuntimeAvailable())) return
            await expect(
                loadBashEnv("echo problem >&2; exit 17"),
            ).rejects.toThrow(/exit 17|problem/i)
        },
        20_000,
    )

    test("input handles strings with quotes, newlines, and JSON escapes", async () => {
        // NUON records use unquoted keys (`{a: 1}`) and double-quoted strings
        // allow literal newlines, so neither shape parses as JSON. Verify the
        // round-trip by doing the equality check inside nu itself — the
        // pipeline returns a bool, which is JSON-compatible NUON.
        const tricky = 'line one\nhas "quotes" and a \\ backslash'
        const r = await runPipeline("$in.text == $in.want", {
            input: JSON.stringify({ text: tricky, want: tricky }),
        })
        expect(r.exitCode).toBe(0)
        expect(r.nuon).toBe("true")
    })
})

describe("second-pass audit", () => {
    // bashEnv now threads `opts.timeoutMs` into both dumpEnv subprocesses.
    // Previously a 30-second hardcoded ceiling — callers asking for 1s would
    // wait 30s when the bash script hung.
    test(
        "bashEnv honors opts.timeoutMs",
        async () => {
            if (!(await bashRuntimeAvailable())) return
            const start = Date.now()
            await expect(
                loadBashEnv("sleep 5", { timeoutMs: 800 }),
            ).rejects.toThrow(/timed out after 800ms/)
            const elapsed = Date.now() - start
            // Generous bound: the timeout kicks in well under the 5s sleep.
            expect(elapsed).toBeLessThan(3000)
        },
        10_000,
    )

    test(
        "runPipeline propagates timeoutMs to the bash bridge",
        async () => {
            if (!(await bashRuntimeAvailable())) return
            // Confirm the wiring from runPipeline → loadBashEnv → dumpEnv:
            // a slow bashEnv prelude causes runPipeline to reject with the
            // same timed-out error inside the configured deadline. The MCP
            // layer's try/catch converts this into an isError response.
            const start = Date.now()
            await expect(
                runPipeline("1", { bashEnv: "sleep 5", timeoutMs: 800 }),
            ).rejects.toThrow(/timed out after 800ms/)
            const elapsed = Date.now() - start
            expect(elapsed).toBeLessThan(3000)
        },
        10_000,
    )

    // Opportunistic coverage: killAll was never tested directly.
    test(
        "killAll cancels in-flight nu processes",
        async () => {
            // Start a long-running pipeline. Don't await — we want it alive
            // when we call killAll.
            const pending = runPipeline("sleep 30sec", { timeoutMs: 10_000 })
            // Give the spawn a moment to register.
            await new Promise(resolve => setTimeout(resolve, 200))
            const killed = killAll()
            expect(killed).toBeGreaterThan(0)
            const r = await pending
            expect(r.exitCode).not.toBe(0)
        },
        15_000,
    )

    // Opportunistic coverage: empty search result path.
    test("searchDocs returns empty commands for an unknown query", async () => {
        const result = await searchDocs("xxxnonsenseyyyzzz")
        expect(result.kind).toBe("commands")
        if (result.kind !== "commands") throw new Error("unreachable")
        expect(result.commands).toEqual([])
    })

    // Opportunistic coverage: limit applied.
    test("searchDocs respects the limit parameter", async () => {
        const limited = await searchDocs("str", { limit: 3 })
        expect(limited.kind).toBe("commands")
        if (limited.kind !== "commands") throw new Error("unreachable")
        expect(limited.commands.length).toBeLessThanOrEqual(3)
    })
})

describe("cycle 2 audit regressions", () => {
    // FIX C1: NUSHELL_MCP_BASH_PATH override must hard-error rather than
    // silently falling through to auto-detection when the probe fails.
    test(
        "NUSHELL_MCP_BASH_PATH to nonexistent path throws instead of falling through",
        async () => {
            const prevOverride = process.env.NUSHELL_MCP_BASH_PATH
            // Reset memo so the fresh env-var value is probed, not a cached result.
            _resetBashRunnerProbe()
            process.env.NUSHELL_MCP_BASH_PATH =
                "/nonexistent/path/that/does/not/exist/bash"
            try {
                await expect(
                    loadBashEnv("export CYCLE2_C1_TEST=should-not-run"),
                ).rejects.toThrow(/NUSHELL_MCP_BASH_PATH=.*did not pass probe/)
            } finally {
                // Restore env and reset memo so downstream tests are unaffected.
                if (prevOverride === undefined) {
                    delete process.env.NUSHELL_MCP_BASH_PATH
                } else {
                    process.env.NUSHELL_MCP_BASH_PATH = prevOverride
                }
                _resetBashRunnerProbe()
            }
        },
        10_000,
    )

    // FIX C2: loadBashEnv returns the runner label, and runPipeline propagates
    // it in PipelineResult.bashRunner so callers can see which runtime was used.
    test(
        "loadBashEnv result includes runner label",
        async () => {
            if (!(await bashRuntimeAvailable())) {
                console.warn("skipping bashRunner label test — no bash runtime detected")
                return
            }
            const result = await loadBashEnv("export CYCLE2_C2_TEST=runner-label")
            expect(result.runner.length).toBeGreaterThan(0)
            expect(result.vars.CYCLE2_C2_TEST).toBe("runner-label")
        },
        20_000,
    )

    test(
        "runPipeline populates PipelineResult.bashRunner when bashEnv is used",
        async () => {
            if (!(await bashRuntimeAvailable())) {
                console.warn("skipping bashRunner field test — no bash runtime detected")
                return
            }
            const r = await runPipeline(
                "$env.CYCLE2_RUNNER_VAR? | default 'missing'",
                { bashEnv: "export CYCLE2_RUNNER_VAR=present" },
            )
            expect(r.exitCode).toBe(0)
            expect(r.bashRunner).toBeDefined()
            expect((r.bashRunner ?? "").length).toBeGreaterThan(0)
        },
        20_000,
    )

    test(
        "runPipeline leaves PipelineResult.bashRunner undefined when no bashEnv",
        async () => {
            const r = await runPipeline("1 + 1")
            expect(r.exitCode).toBe(0)
            expect(r.bashRunner).toBeUndefined()
        },
    )
})

describe("MCP server wiring", () => {
    test(
        "server initializes over stdio and lists its twelve tools",
        async () => {
            const proc = Bun.spawn(
                ["bun", `${import.meta.dir}/../src/index.ts`],
                { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
            )

            const reader = proc.stdout.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

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
                    "nu_doc_help",
                    "nu_doc_search",
                    "nu_exec",
                    "nu_exec_abort",
                    "nu_repl_clear",
                    "nu_repl_kill",
                    "nu_repl_list",
                    "nu_repl_nuke",
                    "nu_repl_read",
                    "nu_repl_spawn",
                    "nu_repl_status",
                    "nu_repl_write",
                ])

                // Cycle 10 end-to-end: exercise both doc tools through the
                // MCP protocol. Both go through the singleton `nu --mcp`
                // child, so a second call after the first verifies the
                // singleton stays alive across calls (no per-call spawn).
                send({
                    jsonrpc: "2.0",
                    id: 3,
                    method: "tools/call",
                    params: {
                        name: "nu_doc_search",
                        arguments: { query: "where", limit: 3 },
                    },
                })
                send({
                    jsonrpc: "2.0",
                    id: 4,
                    method: "tools/call",
                    params: {
                        name: "nu_doc_help",
                        arguments: { name: "where" },
                    },
                })
                await proc.stdin.flush()

                // Responses can arrive in either order — index by id.
                const responses: Record<number, Record<string, unknown>> = {}
                while (Object.keys(responses).length < 2) {
                    const msg = await nextMessage()
                    if (typeof msg.id === "number")
                        responses[msg.id] = msg
                }
                const searchResult = responses[3] as {
                    result: { structuredContent: { kind: string } }
                }
                expect(searchResult.result.structuredContent.kind).toBe(
                    "commands",
                )
                const helpResult = responses[4] as {
                    result: { structuredContent: { found: boolean } }
                }
                expect(helpResult.result.structuredContent.found).toBe(true)
            } finally {
                reader.cancel().catch(() => {})
                proc.kill()
            }
        },
        20_000,
    )

    // --- Plan B Cycle 7: REPL lifecycle tools ----------------------------
    test(
        "nu_repl_spawn / nu_repl_list / nu_repl_kill / nu_repl_nuke",
        async () => {
            const proc = Bun.spawn(
                ["bun", `${import.meta.dir}/../src/index.ts`],
                { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
            )
            const reader = proc.stdout.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

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
            const send = (m: object) =>
                proc.stdin.write(JSON.stringify(m) + "\n")
            const collect = async (
                ids: number[],
            ): Promise<Record<number, Record<string, unknown>>> => {
                const out: Record<number, Record<string, unknown>> = {}
                while (Object.keys(out).length < ids.length) {
                    const msg = await nextMessage()
                    if (typeof msg.id === "number" && ids.includes(msg.id)) {
                        out[msg.id] = msg
                    }
                }
                return out
            }

            try {
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
                await proc.stdin.flush()
                await collect([1])

                // Helper: send one tools/call and await its response.
                // Serializes the test so map state mutations land in order.
                type ToolResult = {
                    result: {
                        isError?: boolean
                        structuredContent?: Record<string, unknown>
                    }
                }
                let nextId = 2
                const call = async (
                    name: string,
                    args: object = {},
                ): Promise<ToolResult> => {
                    const id = nextId++
                    send({
                        jsonrpc: "2.0",
                        id,
                        method: "tools/call",
                        params: { name, arguments: args },
                    })
                    await proc.stdin.flush()
                    const res = (await collect([id])) as unknown as Record<
                        number,
                        ToolResult
                    >
                    return res[id]!
                }

                // List initially: should be empty.
                const r1 = await call("nu_repl_list")
                expect(r1.result.structuredContent?.keys).toEqual([])

                // Spawn a bucket.
                const r2 = await call("nu_repl_spawn", { key: "smoke1" })
                expect(r2.result.isError).toBeFalsy()
                expect(r2.result.structuredContent?.key).toBe("smoke1")

                // Duplicate spawn errors.
                const r3 = await call("nu_repl_spawn", { key: "smoke1" })
                expect(r3.result.isError).toBe(true)

                // List shows the bucket.
                const r4 = await call("nu_repl_list")
                expect(r4.result.structuredContent?.keys).toEqual(["smoke1"])

                // Kill missing errors.
                const r5 = await call("nu_repl_kill", { key: "does-not-exist" })
                expect(r5.result.isError).toBe(true)

                // Kill the spawned key.
                const r6 = await call("nu_repl_kill", { key: "smoke1" })
                expect(r6.result.isError).toBeFalsy()

                // Spawn two more, then nuke.
                const r7 = await call("nu_repl_spawn", { key: "a" })
                expect(r7.result.isError).toBeFalsy()
                const r8 = await call("nu_repl_spawn", { key: "b" })
                expect(r8.result.isError).toBeFalsy()
                const r9 = await call("nu_repl_nuke")
                expect(
                    (r9.result.structuredContent?.killed as number) ?? 0,
                ).toBeGreaterThanOrEqual(2)
                const r10 = await call("nu_repl_list")
                expect(r10.result.structuredContent?.keys).toEqual([])

                // --- Plan B Cycle 8: nu_repl_write -------------------
                // Spawn a fresh bucket, write `let x = 42`, write `$x`,
                // confirm second response carries the value.
                await call("nu_repl_spawn", { key: "writebench" })
                const w1 = await call("nu_repl_write", {
                    key: "writebench",
                    input: "let x = 42",
                })
                expect(w1.result.isError).toBeFalsy()
                const w2 = await call("nu_repl_write", {
                    key: "writebench",
                    input: "$x",
                })
                expect(w2.result.isError).toBeFalsy()
                expect(
                    (w2.result.structuredContent?.output as string) ?? "",
                ).toContain("42")
                // Write on a missing bucket errors.
                const wErr = await call("nu_repl_write", {
                    key: "no-such-bucket",
                    input: "1",
                })
                expect(wErr.result.isError).toBe(true)

                // --- Plan B Cycle 9: nu_repl_read --------------------
                // Fresh bucket → null lastResponse.
                await call("nu_repl_spawn", { key: "readbench" })
                const rd0 = await call("nu_repl_read", { key: "readbench" })
                expect(rd0.result.structuredContent?.response).toBeNull()
                // After a write, read returns the head.
                await call("nu_repl_write", {
                    key: "readbench",
                    input: "100 + 1",
                })
                const rd1 = await call("nu_repl_read", { key: "readbench" })
                expect(
                    (rd1.result.structuredContent?.response as
                        | { text?: string }
                        | null)?.text ?? "",
                ).toContain("101")
                // Read on a missing bucket errors.
                const rdErr = await call("nu_repl_read", { key: "missing" })
                expect(rdErr.result.isError).toBe(true)

                // --- Plan B Cycle 10: nu_repl_clear ------------------
                // Set state, clear buffer (state remains).
                await call("nu_repl_write", {
                    key: "readbench",
                    input: "let y = 99",
                })
                const cb = await call("nu_repl_clear", {
                    key: "readbench",
                    mode: "buffer",
                })
                expect(cb.result.isError).toBeFalsy()
                const rdAfterBufClear = await call("nu_repl_read", {
                    key: "readbench",
                })
                expect(
                    rdAfterBufClear.result.structuredContent?.response,
                ).toBeNull()
                // $y still defined — state survived buffer clear.
                const yLookup = await call("nu_repl_write", {
                    key: "readbench",
                    input: "$y",
                })
                expect(yLookup.result.isError).toBeFalsy()
                expect(
                    (yLookup.result.structuredContent?.output as string) ?? "",
                ).toContain("99")
                // Clear "all" wipes the session.
                const ca = await call("nu_repl_clear", {
                    key: "readbench",
                    mode: "all",
                })
                expect(ca.result.isError).toBeFalsy()
                const yLost = await call("nu_repl_write", {
                    key: "readbench",
                    input: "$y",
                })
                // $y should now be undefined → evaluate errors.
                expect(yLost.result.isError).toBe(true)
                // Default mode is "all" (per Plan B open question resolution).
                await call("nu_repl_write", {
                    key: "readbench",
                    input: "let z = 5",
                })
                await call("nu_repl_clear", { key: "readbench" })
                const zLost = await call("nu_repl_write", {
                    key: "readbench",
                    input: "$z",
                })
                expect(zLost.result.isError).toBe(true)

                // --- Plan B Cycle 11: nu_repl_status -----------------
                await call("nu_repl_spawn", { key: "statbench" })
                await call("nu_repl_write", {
                    key: "statbench",
                    input: `cd "${TMP_DIR}"`,
                })
                const stat = await call("nu_repl_status", {
                    key: "statbench",
                })
                expect(stat.result.isError).toBeFalsy()
                expect(stat.result.structuredContent?.cwd).toBe(TMP_DIR)
                expect(
                    (stat.result.structuredContent?.historyIndex as number) ??
                        0,
                ).toBeGreaterThan(0)
                expect(
                    (stat.result.structuredContent?.envKeys as string[])
                        ?.length ?? 0,
                ).toBeGreaterThan(0)
                // Status on a missing bucket errors.
                const statErr = await call("nu_repl_status", {
                    key: "no-such-key",
                })
                expect(statErr.result.isError).toBe(true)

                // --- Plan B Cycle 12: nu_exec_abort ------------------
                // Fire a long-running nu_exec and abort it. Send both
                // concurrently — the abort must reach the server before
                // the run finishes its sleep.
                const longId = nextId++
                const abortId = nextId++
                send({
                    jsonrpc: "2.0",
                    id: longId,
                    method: "tools/call",
                    params: {
                        name: "nu_exec",
                        arguments: {
                            pipeline: "sleep 30sec; 1",
                            timeoutMs: 60_000,
                        },
                    },
                })
                await proc.stdin.flush()
                // Wait for the run to actually start (otherwise nothing
                // for abort to kill). 600ms is more than enough.
                await new Promise((r) => setTimeout(r, 600))
                send({
                    jsonrpc: "2.0",
                    id: abortId,
                    method: "tools/call",
                    params: { name: "nu_exec_abort", arguments: {} },
                })
                await proc.stdin.flush()
                const collected = (await collect([
                    longId,
                    abortId,
                ])) as unknown as Record<number, ToolResult>
                const abortRes = collected[abortId]!
                const longRes = collected[longId]!
                expect(
                    (abortRes.result.structuredContent?.aborted as number) ??
                        0,
                ).toBeGreaterThanOrEqual(1)
                // The killed run reports error (timedOut false, exitCode != 0).
                expect(longRes.result.isError).toBeTruthy()

                // --- Plan B Cycle 15: multi-bucket isolation ---------
                // Two buckets each hold their own `$a`. Writes to one
                // do not bleed into the other.
                await call("nu_repl_spawn", { key: "iso1" })
                await call("nu_repl_spawn", { key: "iso2" })
                await call("nu_repl_write", {
                    key: "iso1",
                    input: "let a = 1",
                })
                await call("nu_repl_write", {
                    key: "iso2",
                    input: "let a = 2",
                })
                const iso1 = await call("nu_repl_write", {
                    key: "iso1",
                    input: "$a",
                })
                const iso2 = await call("nu_repl_write", {
                    key: "iso2",
                    input: "$a",
                })
                expect(
                    (iso1.result.structuredContent?.output as string) ?? "",
                ).toContain("1")
                expect(
                    (iso2.result.structuredContent?.output as string) ?? "",
                ).toContain("2")

                // --- Plan B Cycle 15: cross-bucket parallelism -------
                // Two concurrent writes to different buckets should
                // overlap (per-bucket mutex; cross-bucket free-running).
                // Precondition: iso1/iso2 are already warm from the isolation
                // assertions above, so the ~400ms threshold amortizes only the
                // pipeline itself, not first-spawn handshake. If you reorder
                // or extract this block, warm both buckets first.
                const p1Id = nextId++
                const p2Id = nextId++
                send({
                    jsonrpc: "2.0",
                    id: p1Id,
                    method: "tools/call",
                    params: {
                        name: "nu_repl_write",
                        arguments: {
                            key: "iso1",
                            input: "sleep 400ms; 'one'",
                        },
                    },
                })
                send({
                    jsonrpc: "2.0",
                    id: p2Id,
                    method: "tools/call",
                    params: {
                        name: "nu_repl_write",
                        arguments: {
                            key: "iso2",
                            input: "sleep 400ms; 'two'",
                        },
                    },
                })
                await proc.stdin.flush()
                const parallelStart = performance.now()
                await collect([p1Id, p2Id])
                const parallelMs = performance.now() - parallelStart
                // If parallel: ~400ms. If serialized: ~800ms. Allow
                // headroom for handshake jitter; assert clearly under 2×.
                expect(parallelMs).toBeLessThan(700)

                await call("nu_repl_nuke")
            } finally {
                reader.cancel().catch(() => {})
                proc.kill()
            }
        },
        30_000,
    )

    // G2 regression: renderExec must emit "[bashEnv runner: <label>]" in
    // content[0].text when bashEnv is used. This protects the src/index.ts
    // branch `if (result.bashRunner) parts.push(...)` against a refactor
    // that drops the push or misnames the field.
    test(
        "nu_exec: [bashEnv runner: ...] label appears in MCP content text",
        async () => {
            if (!(await bashRuntimeAvailable())) {
                console.warn(
                    "skipping bashEnv runner label MCP test — no bash runtime detected",
                )
                return
            }

            const proc = Bun.spawn(
                ["bun", `${import.meta.dir}/../src/index.ts`],
                { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
            )
            const reader = proc.stdout.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

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
            const send = (m: object) =>
                proc.stdin.write(JSON.stringify(m) + "\n")

            try {
                send({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        clientInfo: { name: "smoke-g2", version: "0" },
                    },
                })
                send({ jsonrpc: "2.0", method: "notifications/initialized" })
                send({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/call",
                    params: {
                        name: "nu_exec",
                        arguments: {
                            pipeline: "$env.G2_VAR? | default 'unset'",
                            bashEnv: "export G2_VAR=present",
                        },
                    },
                })
                await proc.stdin.flush()

                // Skip the initialize response, collect the tools/call response.
                let execResponse: Record<string, unknown> | undefined
                for (let i = 0; i < 3; i++) {
                    const msg = await nextMessage()
                    if (msg.id === 2) {
                        execResponse = msg
                        break
                    }
                }
                expect(execResponse).toBeDefined()

                const result = execResponse!.result as {
                    content?: { type: string; text: string }[]
                    isError?: boolean
                }
                expect(result.isError).toBeFalsy()
                expect(result.content).toBeDefined()
                expect(result.content!.length).toBeGreaterThan(0)

                const text = result.content![0]!.text
                // The runner label must appear in the user-visible text block.
                expect(text).toContain("[bashEnv runner: ")

                // Negative: when bashEnv is absent the label must not appear.
                send({
                    jsonrpc: "2.0",
                    id: 3,
                    method: "tools/call",
                    params: {
                        name: "nu_exec",
                        arguments: { pipeline: "1 + 1" },
                    },
                })
                await proc.stdin.flush()

                let plainResponse: Record<string, unknown> | undefined
                for (let i = 0; i < 3; i++) {
                    const msg = await nextMessage()
                    if (msg.id === 3) {
                        plainResponse = msg
                        break
                    }
                }
                expect(plainResponse).toBeDefined()

                const plainResult = plainResponse!.result as {
                    content?: { type: string; text: string }[]
                }
                const plainText = plainResult.content![0]!.text
                expect(plainText).not.toContain("[bashEnv runner: ")
            } finally {
                reader.cancel().catch(() => {})
                proc.kill()
            }
        },
        30_000,
    )
})
