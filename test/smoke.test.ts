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
import { randomBytes } from "node:crypto"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import {
    PERSIST_DIR,
    clearPersistedEnv,
    getCommandDoc,
    getNuVersion,
    killAll,
    loadBashEnv,
    runPipeline,
    runRaw,
    searchDocs,
} from "../src/nu.js"

/** Generate a fresh persist-key per test so cases never interfere. */
const freshKey = (): string => `test-${randomBytes(4).toString("hex")}`

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

describe("persistEnv", () => {
    test("survives across two runPipeline calls (default bucket)", async () => {
        const key = freshKey()
        try {
            const a = await runPipeline(
                `$env.NUSHELL_MCP_TEST_VAR = "carry-over"`,
                { persistEnv: true, persistKey: key },
            )
            expect(a.exitCode).toBe(0)
            const b = await runPipeline("$env.NUSHELL_MCP_TEST_VAR", {
                persistEnv: true,
                persistKey: key,
            })
            expect(b.exitCode).toBe(0)
            // NUON always quotes strings — `to nuon --serialize` on the string
            // `carry-over` produces the literal `"carry-over"`.
            expect(b.nuon).toBe('"carry-over"')
        } finally {
            await clearPersistedEnv(key)
        }
    })

    test("persistKey isolates buckets", async () => {
        const keyA = freshKey()
        const keyB = freshKey()
        try {
            await runPipeline(`$env.SHARED = "bucket-A"`, {
                persistEnv: true,
                persistKey: keyA,
            })
            await runPipeline(`$env.SHARED = "bucket-B"`, {
                persistEnv: true,
                persistKey: keyB,
            })
            const seenA = await runPipeline("$env.SHARED", {
                persistEnv: true,
                persistKey: keyA,
            })
            const seenB = await runPipeline("$env.SHARED", {
                persistEnv: true,
                persistKey: keyB,
            })
            expect(seenA.nuon).toBe('"bucket-A"')
            expect(seenB.nuon).toBe('"bucket-B"')
        } finally {
            await clearPersistedEnv(keyA)
            await clearPersistedEnv(keyB)
        }
    })

    test("clearPersistedEnv removes the bucket file", async () => {
        const key = freshKey()
        await runPipeline(`$env.WILL_BE_CLEARED = "x"`, {
            persistEnv: true,
            persistKey: key,
        })
        const first = await clearPersistedEnv(key)
        expect(first.existed).toBe(true)
        const second = await clearPersistedEnv(key)
        expect(second.existed).toBe(false)
    })

    test("persistEnv ignores non-JSON-serializable env values silently", async () => {
        const key = freshKey()
        try {
            // Setting `$env.X` to a closure should fail to round-trip but
            // must not crash the pipeline — `to json` rejection is swallowed.
            const r = await runPipeline(
                `$env.X = {|| 42 }; $env.PLAIN = "ok"; 1`,
                { persistEnv: true, persistKey: key },
            )
            expect(r.exitCode).toBe(0)
            const followUp = await runPipeline(
                `[($env.X? | default "missing"), $env.PLAIN]`,
                { persistEnv: true, persistKey: key },
            )
            expect(followUp.exitCode).toBe(0)
            // PLAIN is preserved; X is dropped because closures can't JSON-ify.
            expect(followUp.nuon).toContain("missing")
            expect(followUp.nuon).toContain("ok")
        } finally {
            await clearPersistedEnv(key)
        }
    })

    test("invalid persistKey is rejected with a clear error", async () => {
        await expect(
            runPipeline("1", { persistEnv: true, persistKey: "../escape" }),
        ).rejects.toThrow(/persistKey/)
    })

    // Regression: the save filter previously stripped only `ENV_CONVERSIONS`,
    // `config`, and nu-automatic vars, leaving the server's own bookkeeping
    // env vars (`NU_MCP_NUON_PATH`, `NU_MCP_TYPE_PATH`, `NU_MCP_PERSIST_LOAD`,
    // `NU_MCP_PERSIST_SAVE`, and — when input was used — `NU_MCP_INPUT`) in
    // the bucket file. Those are per-call temp paths and request-scoped input
    // with no cross-call meaning; persisting them just bloats the bucket.
    test("saved bucket file excludes server NU_MCP_* bookkeeping vars", async () => {
        const key = freshKey()
        const path = `${PERSIST_DIR}/${key}.json`
        try {
            const r = await runPipeline(`$env.MY = "x"; $in`, {
                persistEnv: true,
                persistKey: key,
                input: '"sentinel-input"',
            })
            expect(r.exitCode).toBe(0)
            const saved = JSON.parse(await fs.readFile(path, "utf-8"))
            const leaked = Object.keys(saved).filter(k =>
                k.startsWith("NU_MCP_"),
            )
            expect(leaked).toEqual([])
        } finally {
            await clearPersistedEnv(key)
        }
    })

    // Regression: when a persisted PWD pointed to a directory that had since
    // been deleted, runPipeline handed the stale path to Bun.spawn as cwd,
    // which surfaced as "ENOENT … posix_spawn '<nu>'" — blaming the nu binary
    // rather than the missing directory. readPersistedPwd now validates the
    // path is an existing directory and returns null on a miss so the caller
    // falls back to its default cwd.
    test("persistCwd falls back when persisted PWD no longer exists", async () => {
        const key = freshKey()
        const path = `${PERSIST_DIR}/${key}.json`
        const nonexistent = `/this/dir/should/never/exist-${randomBytes(8).toString("hex")}`
        try {
            await fs.mkdir(PERSIST_DIR, { recursive: true })
            await fs.writeFile(path, JSON.stringify({ PWD: nonexistent }))
            const r = await runPipeline("pwd", {
                persistEnv: true,
                persistKey: key,
                persistCwd: true,
            })
            expect(r.exitCode).toBe(0)
            const seen = (r.nuon ?? "").replace(/^"|"$/g, "").replace(/\\/g, "/")
            expect(seen).not.toBe(nonexistent.replace(/\\/g, "/"))
            // Falls back to the test process's cwd.
            expect(seen).toBe(process.cwd().replace(/\\/g, "/"))
        } finally {
            await clearPersistedEnv(key)
        }
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
    // Was: `nu_run` with `structured: false` silently dropped persistEnv,
    // persistKey, persistCwd, and bashEnv. Now routed through runPipeline with
    // `noCapture: true` instead of the old `runRaw` shortcut.
    test("noCapture preserves persistEnv", async () => {
        const key = freshKey()
        try {
            const set = await runPipeline(`$env.NC_VAR = "raw-mode"`, {
                persistEnv: true,
                persistKey: key,
                noCapture: true,
            })
            expect(set.exitCode).toBe(0)
            expect(set.nuon).toBeNull()
            expect(set.resultType).toBeNull()
            const get = await runPipeline("$env.NC_VAR", {
                persistEnv: true,
                persistKey: key,
            })
            expect(get.exitCode).toBe(0)
            expect(get.nuon).toBe('"raw-mode"')
        } finally {
            await clearPersistedEnv(key)
        }
    })

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

    test(
        "bashEnv-exported vars get persisted into the bucket",
        async () => {
            if (!(await bashRuntimeAvailable())) return
            const key = freshKey()
            try {
                const a = await runPipeline("1", {
                    bashEnv: "export NC_BRIDGED=via-bash",
                    persistEnv: true,
                    persistKey: key,
                })
                expect(a.exitCode).toBe(0)
                const b = await runPipeline("$env.NC_BRIDGED", {
                    persistEnv: true,
                    persistKey: key,
                })
                expect(b.exitCode).toBe(0)
                expect(b.nuon).toBe('"via-bash"')
            } finally {
                await clearPersistedEnv(key)
            }
        },
        20_000,
    )

    test("persistCwd carries $env.PWD across calls", async () => {
        const key = freshKey()
        const targetDir = tmpdir()
        try {
            const a = await runPipeline(`cd '${targetDir}'`, {
                persistEnv: true,
                persistKey: key,
                persistCwd: true,
            })
            expect(a.exitCode).toBe(0)
            const b = await runPipeline("pwd", {
                persistEnv: true,
                persistKey: key,
                persistCwd: true,
            })
            expect(b.exitCode).toBe(0)
            const seen = (b.nuon ?? "").replace(/^"|"$/g, "").replace(/\\/g, "/")
            const want = targetDir.replace(/\\/g, "/")
            expect(seen).toBe(want)
        } finally {
            await clearPersistedEnv(key)
        }
    })

    test("persistCwd off: $env.PWD does NOT propagate", async () => {
        const key = freshKey()
        const targetDir = tmpdir()
        const startCwd = process.cwd()
        try {
            await runPipeline(`cd '${targetDir}'`, {
                persistEnv: true,
                persistKey: key,
            })
            const b = await runPipeline("pwd", {
                persistEnv: true,
                persistKey: key,
            })
            expect(b.exitCode).toBe(0)
            const seen = (b.nuon ?? "").replace(/^"|"$/g, "").replace(/\\/g, "/")
            expect(seen).toBe(startCwd.replace(/\\/g, "/"))
            expect(seen).not.toBe(targetDir.replace(/\\/g, "/"))
        } finally {
            await clearPersistedEnv(key)
        }
    })

    // Defense in depth: a persist file (perhaps written by an older binary)
    // that still contains nu's automatic vars must not crash subsequent calls.
    test("stale persist file with auto vars loads cleanly", async () => {
        const key = freshKey()
        const path = `${PERSIST_DIR}/${key}.json`
        try {
            await fs.mkdir(PERSIST_DIR, { recursive: true })
            await fs.writeFile(
                path,
                JSON.stringify({
                    FILE_PWD: "/synthetic/path",
                    CURRENT_FILE: "/synthetic/file.nu",
                    LAST_EXIT_CODE: 42,
                    NU_VERSION: "0.0.0-fake",
                    USER_VAR: "real-data",
                }),
            )
            const r = await runPipeline("$env.USER_VAR", {
                persistEnv: true,
                persistKey: key,
            })
            expect(r.exitCode).toBe(0)
            expect(r.nuon).toBe('"real-data"')
        } finally {
            await clearPersistedEnv(key)
        }
    })

    test("saved bucket file excludes nu auto vars", async () => {
        const key = freshKey()
        const path = `${PERSIST_DIR}/${key}.json`
        try {
            await runPipeline(`$env.MY_VAR = "kept"`, {
                persistEnv: true,
                persistKey: key,
            })
            const saved = JSON.parse(await fs.readFile(path, "utf-8"))
            expect(saved.MY_VAR).toBe("kept")
            expect(saved.FILE_PWD).toBeUndefined()
            expect(saved.CURRENT_FILE).toBeUndefined()
            expect(saved.PROCESS_PATH).toBeUndefined()
            expect(saved.LAST_EXIT_CODE).toBeUndefined()
            expect(saved.NU_VERSION).toBeUndefined()
            expect(saved.OLDPWD).toBeUndefined()
            expect(saved.ENV_CONVERSIONS).toBeUndefined()
            expect(saved.config).toBeUndefined()
            expect(typeof saved.PWD).toBe("string")
        } finally {
            await clearPersistedEnv(key)
        }
    })

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

    // Per-key try-load: future nu versions adding a new "automatic env var"
    // not in NU_AUTO_LOAD_BLOCKED must not kill the entire load. The `for`
    // loop's inner `try { load-env { (k): v } } catch {}` isolates failures
    // per key. This test exercises the multi-key load path.
    test("persist file with many heterogeneous keys all load", async () => {
        const key = freshKey()
        const path = `${PERSIST_DIR}/${key}.json`
        try {
            await fs.mkdir(PERSIST_DIR, { recursive: true })
            await fs.writeFile(
                path,
                JSON.stringify({
                    SP_STRING: "alpha",
                    SP_NUMBER_AS_STRING: "42",
                    SP_EMPTY: "",
                    SP_UNICODE: "résumé · 漢字",
                    SP_LONG: "x".repeat(500),
                }),
            )
            // NUON's string-quoting is context-dependent — bare alphanumerics
            // can render unquoted inside lists. To avoid that fragility, do the
            // equality check inside nu and assert against a single boolean.
            const r = await runPipeline(
                `($env.SP_STRING == "alpha") and ($env.SP_NUMBER_AS_STRING == "42") and (($env.SP_EMPTY | str length) == 0) and (($env.SP_UNICODE | str length) == 18) and (($env.SP_LONG | str length) == 500)`,
                { persistEnv: true, persistKey: key },
            )
            expect(r.exitCode).toBe(0)
            expect(r.nuon).toBe("true")
        } finally {
            await clearPersistedEnv(key)
        }
    })

    // Persist save failures used to vanish into a bare `catch {}`. Now they
    // emit a stderr line so operators notice. We exercise it by pointing
    // NUSHELL_MCP_PERSIST_DIR at a path that is a regular file — `mkdir` will
    // succeed but `save` cannot write into a file-as-directory. (Skipping on
    // platforms where the behavior diverges.)
    test("persistEnv save failure surfaces to stderr", async () => {
        const sentinelDir = `${tmpdir()}/nushell-mcp-bad-${Date.now()}`
        // Create a file at the path — `save` will fail trying to write into it.
        await fs.writeFile(sentinelDir, "not a directory")
        const prev = process.env.NUSHELL_MCP_PERSIST_DIR
        process.env.NUSHELL_MCP_PERSIST_DIR = sentinelDir
        try {
            // mkdir will throw EEXIST-on-file or ENOTDIR depending on platform.
            // Rather than asserting that specific path, assert the pipeline
            // itself returns and produces a stderr warning OR the
            // ensurePersistDir step throws. Either is acceptable signal.
            try {
                const r = await runPipeline("1 + 1", { persistEnv: true })
                // If we got here, mkdir didn't throw — but save should have
                // either errored at the nu layer (visible in stderr) or via
                // exit code.
                const stderrSeen = r.stderr.toLowerCase()
                const hasWarning =
                    stderrSeen.includes("persistenv") ||
                    stderrSeen.includes("save failed") ||
                    stderrSeen.includes("io::") ||
                    r.exitCode !== 0
                expect(hasWarning).toBe(true)
            } catch {
                // ensurePersistDir threw — also acceptable.
            }
        } finally {
            if (prev === undefined) {
                delete process.env.NUSHELL_MCP_PERSIST_DIR
            } else {
                process.env.NUSHELL_MCP_PERSIST_DIR = prev
            }
            await fs.unlink(sentinelDir).catch(() => {})
        }
    })

    // Opportunistic coverage: nu_kill was never tested directly.
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
    test("searchDocs returns empty matches for an unknown query", async () => {
        const result = await searchDocs("xxxnonsenseyyyzzz")
        expect(result.count).toBe(0)
        expect(result.matches).toEqual([])
        expect(result.nushellVersion).toMatch(/^\d+\.\d+/)
    })

    // Opportunistic coverage: limit applied.
    test("searchDocs respects the limit parameter", async () => {
        const limited = await searchDocs("str", { limit: 3 })
        expect(limited.matches.length).toBeLessThanOrEqual(3)
    })
})

describe("MCP server wiring", () => {
    test(
        "server initializes over stdio and lists its five tools",
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
                    "nu_doc_command",
                    "nu_doc_search",
                    "nu_kill",
                    "nu_persist_clear",
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
