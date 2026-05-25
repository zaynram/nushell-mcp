/**
 * Integration tests for NuMcpPool — a Map-backed registry of NuMcpChild
 * instances, one per REPL bucket key. Each test spawns real `nu --mcp`
 * children and the afterAll teardown nukes them so files don't leak.
 *
 * Plan B Cycle 3.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { killAll as nuKillAll } from "../src/nu.js"

// Use the OS temp dir instead of a hardcoded "/tmp" so envelope-cache /
// cwd-tracking tests stay portable across Linux, macOS, and Windows
// (Copilot 3297050914 / 3297050941).
const TMP_DIR = tmpdir()
import { type NuMcpToolResponse, getNuMcpClient } from "../src/nuMcpClient.js"
import { NuMcpPool, getReplPool, parseEvaluateEnvelope } from "../src/nuMcpPool.js"

/**
 * Narrow a `NuMcpToolResponse` to its success branch. The discriminated
 * union forbids reading `.text` without narrowing — `expect()` isn't a
 * type guard, so each test that wants `.text` after asserting success
 * funnels through this helper.
 */
function assertOk(
    r: NuMcpToolResponse,
): asserts r is Extract<NuMcpToolResponse, { isError: false }> {
    if (r.isError) {
        throw new Error(`expected success response, got error: ${r.errorText}`)
    }
}

let pool: NuMcpPool

beforeAll(() => {
    pool = new NuMcpPool()
})

afterAll(() => {
    pool.nukeAll()
})

describe("NuMcpPool — basic spawn / has / list / kill", () => {
    test("fresh pool has no buckets", () => {
        const fresh = new NuMcpPool()
        expect(fresh.list()).toEqual([])
        expect(fresh.has("anything")).toBe(false)
    })

    test("spawn registers a bucket; has() and list() reflect it", async () => {
        pool.spawn("alpha")
        expect(pool.has("alpha")).toBe(true)
        expect(pool.list()).toContain("alpha")
        // Sanity: child is live after spawn
        const child = pool.get("alpha")
        expect(child).toBeDefined()
        expect(child!.isAlive()).toBe(false) // lazy spawn — not alive until first call
    })

    test("spawning the same key twice errors", () => {
        // alpha exists from prior test
        expect(() => pool.spawn("alpha")).toThrow(/already exists|already spawned/i)
    })

    test("kill() removes the bucket from the map", async () => {
        pool.spawn("beta")
        expect(pool.has("beta")).toBe(true)
        const killed = await pool.kill("beta")
        expect(killed).toBe(true)
        expect(pool.has("beta")).toBe(false)
        expect(pool.list()).not.toContain("beta")
    })

    test("kill() on a missing bucket returns false (idempotent)", async () => {
        expect(await pool.kill("nonexistent-key")).toBe(false)
    })

    test("nukeAll empties the pool and returns the count killed", () => {
        // Pool has alpha + however many test-spawned buckets remain.
        // Reset to known state first.
        pool.nukeAll()
        pool.spawn("a1")
        pool.spawn("a2")
        pool.spawn("a3")
        expect(pool.list().sort()).toEqual(["a1", "a2", "a3"])
        const killed = pool.nukeAll()
        expect(killed).toBe(3)
        expect(pool.list()).toEqual([])
    })
})

describe("NuMcpPool — key sanitization", () => {
    test("rejects keys with invalid characters", () => {
        const p = new NuMcpPool()
        try {
            expect(() => p.spawn("has space")).toThrow()
            expect(() => p.spawn("has/slash")).toThrow()
            expect(() => p.spawn("has.dot")).toThrow()
            expect(() => p.spawn("")).toThrow()
        } finally {
            p.nukeAll()
        }
    })

    test("accepts alphanumeric, underscore, hyphen", () => {
        const p = new NuMcpPool()
        try {
            p.spawn("Valid_Key-123")
            expect(p.has("Valid_Key-123")).toBe(true)
        } finally {
            p.nukeAll()
        }
    })
})

describe("NuMcpPool — capacity check (MAX_REPLS)", () => {
    test("spawn past MAX_REPLS errors", () => {
        // Construct a pool with explicit small cap so test isn't sensitive to env.
        const p = new NuMcpPool({ maxRepls: 2 })
        try {
            p.spawn("k1")
            p.spawn("k2")
            expect(() => p.spawn("k3")).toThrow(/capacity|max/i)
            expect(p.list().sort()).toEqual(["k1", "k2"])
        } finally {
            p.nukeAll()
        }
    })

    test("after kill, a new spawn fits under the cap", async () => {
        const p = new NuMcpPool({ maxRepls: 2 })
        try {
            p.spawn("k1")
            p.spawn("k2")
            await p.kill("k1")
            // Should now succeed — slot freed
            p.spawn("k3")
            expect(p.list().sort()).toEqual(["k2", "k3"])
        } finally {
            p.nukeAll()
        }
    })

    test("MAX_REPLS reads from NUSHELL_MCP_MAX_REPLS env var when option omitted", () => {
        const original = process.env.NUSHELL_MCP_MAX_REPLS
        process.env.NUSHELL_MCP_MAX_REPLS = "1"
        try {
            const p = new NuMcpPool()
            try {
                p.spawn("only")
                expect(() => p.spawn("second")).toThrow(/capacity|max/i)
            } finally {
                p.nukeAll()
            }
        } finally {
            if (original === undefined) delete process.env.NUSHELL_MCP_MAX_REPLS
            else process.env.NUSHELL_MCP_MAX_REPLS = original
        }
    })

    test("default cap is 10 when env var unset and no option given", () => {
        const original = process.env.NUSHELL_MCP_MAX_REPLS
        delete process.env.NUSHELL_MCP_MAX_REPLS
        try {
            const p = new NuMcpPool()
            try {
                for (let i = 0; i < 10; i++) p.spawn(`k${i}`)
                expect(() => p.spawn("k10")).toThrow(/capacity|max/i)
            } finally {
                p.nukeAll()
            }
        } finally {
            if (original !== undefined) process.env.NUSHELL_MCP_MAX_REPLS = original
        }
    })
})

describe("NuMcpPool — Cycle 4: per-bucket serialization in pool.call", () => {
    test("call on a missing bucket errors", async () => {
        const p = new NuMcpPool()
        try {
            await expect(p.call("nope", "evaluate", { input: "1" })).rejects.toThrow(
                /does not exist|missing|not found/i,
            )
        } finally {
            p.nukeAll()
        }
    })

    test("call delegates to the bucket's child and returns its response", async () => {
        const p = new NuMcpPool({ maxRepls: 2 })
        try {
            p.spawn("solo")
            const { response: r } = await p.call("solo", "evaluate", { input: "1 + 1" })
            assertOk(r)
            expect(r.text).toContain("output:\"2\"")
        } finally {
            p.nukeAll()
        }
    })

    test("two concurrent calls to the SAME key serialize (timing check)", async () => {
        const p = new NuMcpPool({ maxRepls: 2 })
        try {
            p.spawn("same")
            // Warm up — first call pays the lazy-spawn + handshake cost.
            await p.call("same", "evaluate", { input: "1" })

            // Baseline: how long does a single 200ms sleep take?
            const baseStart = performance.now()
            await p.call("same", "evaluate", { input: "sleep 200ms; 1" })
            const baseMs = performance.now() - baseStart

            // Two concurrent calls; if serialized, total ≈ 2× baseline.
            const parStart = performance.now()
            await Promise.all([
                p.call("same", "evaluate", { input: "sleep 200ms; 1" }),
                p.call("same", "evaluate", { input: "sleep 200ms; 1" }),
            ])
            const parMs = performance.now() - parStart

            // Serialized: parMs ≈ 2 × baseMs. Allow some slack (>= 1.5×).
            expect(parMs).toBeGreaterThanOrEqual(baseMs * 1.5)
        } finally {
            p.nukeAll()
        }
    })

    test("two concurrent calls to DIFFERENT keys parallelize", async () => {
        const p = new NuMcpPool({ maxRepls: 2 })
        try {
            p.spawn("k1")
            p.spawn("k2")
            // Warm up both — pays handshake on each child.
            await Promise.all([
                p.call("k1", "evaluate", { input: "1" }),
                p.call("k2", "evaluate", { input: "1" }),
            ])

            // Baseline single call cost
            const baseStart = performance.now()
            await p.call("k1", "evaluate", { input: "sleep 200ms; 1" })
            const baseMs = performance.now() - baseStart

            // Cross-key concurrent: should ≈ baseline (parallel), not 2×.
            const parStart = performance.now()
            await Promise.all([
                p.call("k1", "evaluate", { input: "sleep 200ms; 1" }),
                p.call("k2", "evaluate", { input: "sleep 200ms; 1" }),
            ])
            const parMs = performance.now() - parStart

            // If they truly parallelize, parMs is closer to baseMs than 2×baseMs.
            // Cap at 1.6× to leave room for scheduling jitter.
            expect(parMs).toBeLessThan(baseMs * 1.6)
        } finally {
            p.nukeAll()
        }
    })

    test("call result is appended to the bucket's ring buffer head", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("buf")
            const { response: a } = await p.call("buf", "evaluate", { input: "1 + 1" })
            const head1 = p.lastResponse("buf")
            expect(head1).toEqual(a)
            const { response: b } = await p.call("buf", "evaluate", { input: "2 + 2" })
            const head2 = p.lastResponse("buf")
            expect(head2).toEqual(b)
            expect(head2).not.toEqual(head1)
        } finally {
            p.nukeAll()
        }
    })

    test("mutex releases on rejection — next call still runs", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("rej")
            // First call: invalid nu code → evaluate returns isError, but the
            // JSON-RPC response still completes, so the mutex must release.
            // (We also cover the throw path by directly testing the thrown-error
            // case via a missing tool name.)
            await expect(
                p.call("rej", "this-tool-does-not-exist", { input: "1" }),
            ).rejects.toThrow()

            // If mutex leaked, this hangs forever; bun test will time out.
            const { response: r } = await p.call("rej", "evaluate", { input: "42" })
            assertOk(r)
            expect(r.text).toContain("42")
        } finally {
            p.nukeAll()
        }
    })
})

describe("NuMcpPool — Cycle 5: ring buffer + envelope cache", () => {
    test("lastResponse on missing key throws", () => {
        const p = new NuMcpPool()
        try {
            expect(() => p.lastResponse("nope")).toThrow(/does not exist|missing|not found/i)
        } finally {
            p.nukeAll()
        }
    })

    test("lastResponse on a fresh, never-called bucket returns null", () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("fresh")
            expect(p.lastResponse("fresh")).toBeNull()
        } finally {
            p.nukeAll()
        }
    })

    test("ring buffer evicts at the size-5 boundary (head is most recent)", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("ring")
            // Push 6 distinct calls; size=5 means the first must be evicted.
            for (let i = 1; i <= 6; i++) {
                await p.call("ring", "evaluate", { input: `${i}` })
            }
            const head = p.lastResponse("ring")
            if (head === null) throw new Error("expected non-null head")
            assertOk(head)
            expect(head.text).toContain("output:\"6\"")
            // Inspect buffer to confirm oldest is gone — head is 6, oldest entry
            // should be 2 (entries 2..6), not 1.
            const all = p._inspectBuffer("ring")
            expect(all.length).toBe(5)
            const first = all[0]
            const last = all[4]
            if (first === undefined || last === undefined) {
                throw new Error("buffer slots populated above; unreachable")
            }
            assertOk(first)
            assertOk(last)
            // Head-first ordering: index 0 is newest.
            expect(first.text).toContain("output:\"6\"")
            expect(last.text).toContain("output:\"2\"")
            // 1 is evicted. Each pushed evaluate succeeded, so every entry is
            // on the success branch; safe to read `.text` after narrowing.
            const found = all.find((r) => !r.isError && r.text.includes("output:\"1\""))
            expect(found).toBeUndefined()
        } finally {
            p.nukeAll()
        }
    })

    test("clearBuffer empties the bucket's buffer but keeps the child alive", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("clr")
            await p.call("clr", "evaluate", { input: "1" })
            expect(p.lastResponse("clr")).not.toBeNull()
            p.clearBuffer("clr")
            expect(p.lastResponse("clr")).toBeNull()
            // Child still works — clearBuffer is buffer-only.
            const { response: r } = await p.call("clr", "evaluate", { input: "2" })
            expect(r.isError).toBe(false)
        } finally {
            p.nukeAll()
        }
    })

    test("envelope cache updates cwd after `cd`", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("env")
            await p.call("env", "evaluate", { input: `cd "${TMP_DIR}"` })
            const env = p.envelope("env")
            expect(env.kind).toBe("ok")
            if (env.kind !== "ok") throw new Error("envelope not ok")
            expect(env.cwd).toBe(TMP_DIR)
        } finally {
            p.nukeAll()
        }
    })

    test("envelope cache tracks history_index as it advances", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("hist")
            await p.call("hist", "evaluate", { input: "1" })
            const env1 = p.envelope("hist")
            if (env1.kind !== "ok") throw new Error("env1 not ok")
            const first = env1.historyIndex
            await p.call("hist", "evaluate", { input: "2" })
            const env2 = p.envelope("hist")
            if (env2.kind !== "ok") throw new Error("env2 not ok")
            const second = env2.historyIndex
            expect(typeof first).toBe("number")
            expect(typeof second).toBe("number")
            expect(second).toBeGreaterThan(first ?? -1)
        } finally {
            p.nukeAll()
        }
    })
})

describe("NuMcpPool — Cycle 6: crash policy + killAll integration", () => {
    test("getReplPool() returns a stable singleton", () => {
        const a = getReplPool()
        const b = getReplPool()
        expect(a).toBe(b)
    })

    test("when a bucket's child dies unexpectedly, it is removed from the map", async () => {
        const pool = getReplPool()
        pool.nukeAll()
        const child = pool.spawn("crash1")
        // Force lazy spawn so the child process actually exists.
        await pool.call("crash1", "evaluate", { input: "1" })
        expect(pool.has("crash1")).toBe(true)
        // Kill the child directly, bypassing pool.kill. The pool should
        // observe the exit and prune the bucket.
        child.kill()
        // Yield to let exit handlers run.
        await new Promise((r) => setTimeout(r, 50))
        expect(pool.has("crash1")).toBe(false)
    })

    test("calling a bucket whose child has died errors", async () => {
        const pool = getReplPool()
        pool.nukeAll()
        const child = pool.spawn("crash2")
        await pool.call("crash2", "evaluate", { input: "1" })
        child.kill()
        await new Promise((r) => setTimeout(r, 50))
        await expect(
            pool.call("crash2", "evaluate", { input: "2" }),
        ).rejects.toThrow(/does not exist|missing|not found|died/i)
    })

    test("nu.killAll() empties the singleton pool", async () => {
        const pool = getReplPool()
        pool.nukeAll()
        pool.spawn("k1")
        pool.spawn("k2")
        await pool.call("k1", "evaluate", { input: "1" })
        await pool.call("k2", "evaluate", { input: "2" })
        expect(pool.list().sort()).toEqual(["k1", "k2"])
        const killed = nuKillAll()
        expect(killed).toBeGreaterThanOrEqual(2)
        expect(pool.list()).toEqual([])
    })

    test("a fresh NuMcpPool (not the singleton) is unaffected by nu.killAll()", () => {
        const fresh = new NuMcpPool()
        try {
            fresh.spawn("isolated")
            expect(fresh.has("isolated")).toBe(true)
            // killAll only nukes the singleton pool — fresh instance is independent.
            nuKillAll()
            expect(fresh.has("isolated")).toBe(true)
        } finally {
            fresh.nukeAll()
            // Clean up singleton too in case any prior test left it.
            getNuMcpClient().kill()
        }
    })
})

describe("NuMcpPool — status() probeError surfacing", () => {
    test("probeError is set when the child subprocess dies before the probe completes", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            const child = p.spawn("probe-err")
            // Trigger lazy spawn so the underlying proc is populated.
            await p.call("probe-err", "evaluate", { input: "1" })
            // Kill the raw Bun subprocess directly — NOT child.kill(), which
            // would synchronously prune the bucket and make status() throw
            // "does not exist" before the probe even starts. Reaching the
            // raw proc goes through the _getProc test-only accessor since
            // the field itself is private (Copilot 3295803625).
            const rawProc = child._getProc()
            if (!rawProc) throw new Error("expected proc to be spawned by p.call")
            rawProc.kill()
            // status() sees the bucket entry still alive (onExit fires async)
            // but the probe evaluate call will fail because the child is dead.
            const result = await p.status("probe-err")
            expect(result.kind).toBe("probe-error")
            if (result.kind !== "probe-error") throw new Error("expected probe-error")
            expect(result.probeError).toBeDefined()
            expect(typeof result.probeError).toBe("string")
            // The error message should mention the child dying or stdin being gone.
            expect(result.probeError).toMatch(/child|exited|killed|stdin/i)
            // The cached envelope (from the prior successful evaluate) is
            // carried explicitly on the probe-error variant.
            expect(result.cachedEnvelope.kind).toBe("ok")
        } finally {
            p.nukeAll()
        }
    })
})

describe("NuMcpPool — Copilot 3296946827: status() probe does not record into ring buffer", () => {
    test("nu_repl_status's $env|columns probe leaves nu_repl_read pointing at the user's last write", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("rec")
            // First, a normal user write — this SHOULD be recorded.
            await p.call("rec", "evaluate", { input: "42" })
            const headBeforeStatus = p.lastResponse("rec")
            expect(headBeforeStatus).not.toBeNull()
            if (!headBeforeStatus) throw new Error("unreachable")
            // Now call status — its internal probe must not displace the user's
            // last recorded response.
            const stat = await p.status("rec")
            expect(stat.kind).toBe("ok")
            const headAfterStatus = p.lastResponse("rec")
            // Same response object reference: status's probe was not pushed.
            expect(headAfterStatus).toBe(headBeforeStatus)
        } finally {
            p.nukeAll()
        }
    })
})

describe("NuMcpPool — crash mid-call", () => {
    test("pending call rejects when child dies mid-flight and bucket is pruned", async () => {
        const p = new NuMcpPool({ maxRepls: 2 })
        try {
            p.spawn("victim")
            // Warm the bucket so the child process is actually alive.
            await p.call("victim", "evaluate", { input: "1" })
            expect(p.has("victim")).toBe(true)

            // Start a long-running call WITHOUT awaiting.
            const callPromise = p.call("victim", "evaluate", { input: "sleep 5sec" })

            // Give the call's sendRpc time to register on the pending map
            // before we kill the child.
            await new Promise((r) => setImmediate(r))

            // Reach in and kill the bucket's child directly.
            p.get("victim")!.kill()

            // The in-flight call must reject because handleExit/kill rejects
            // all pending handlers.
            await expect(callPromise).rejects.toThrow(/child exited|killed/i)

            // The onExit listener registered by spawn() prunes the bucket.
            // Give the microtask / exit-handler a moment to fire.
            await new Promise((r) => setTimeout(r, 50))
            expect(p.has("victim")).toBe(false)

            // Respawn with the same key must work — slot is free.
            expect(() => p.spawn("victim")).not.toThrow()
        } finally {
            p.nukeAll()
        }
    })
})

describe("NuMcpPool — env-var cap (NUSHELL_MCP_MAX_REPLS=3)", () => {
    test("3 spawns succeed; 4th throws capacity error matching limit", () => {
        const original = process.env.NUSHELL_MCP_MAX_REPLS
        process.env.NUSHELL_MCP_MAX_REPLS = "3"
        let p: NuMcpPool | null = null
        try {
            p = new NuMcpPool() // no explicit option — reads from env
            p.spawn("cap1")
            p.spawn("cap2")
            p.spawn("cap3")
            expect(p.list().sort()).toEqual(["cap1", "cap2", "cap3"])
            expect(() => p!.spawn("cap4")).toThrow(/maximum active repls reached.*3/i)
        } finally {
            p?.nukeAll()
            if (original === undefined) delete process.env.NUSHELL_MCP_MAX_REPLS
            else process.env.NUSHELL_MCP_MAX_REPLS = original
        }
    })

    test("env var '0' falls back to DEFAULT_MAX_REPLS (10)", () => {
        const original = process.env.NUSHELL_MCP_MAX_REPLS
        process.env.NUSHELL_MCP_MAX_REPLS = "0"
        let p: NuMcpPool | null = null
        try {
            p = new NuMcpPool()
            // Spawn 10 — should all succeed at the default cap.
            for (let i = 0; i < 10; i++) p.spawn(`z${i}`)
            expect(p.list().length).toBe(10)
            // 11th should fail.
            expect(() => p!.spawn("z10")).toThrow(/capacity|max/i)
        } finally {
            p?.nukeAll()
            if (original === undefined) delete process.env.NUSHELL_MCP_MAX_REPLS
            else process.env.NUSHELL_MCP_MAX_REPLS = original
        }
    })

    test("env var garbage (non-numeric) falls back to DEFAULT_MAX_REPLS (10)", () => {
        const original = process.env.NUSHELL_MCP_MAX_REPLS
        process.env.NUSHELL_MCP_MAX_REPLS = "not-a-number"
        let p: NuMcpPool | null = null
        try {
            p = new NuMcpPool()
            for (let i = 0; i < 10; i++) p.spawn(`g${i}`)
            expect(p.list().length).toBe(10)
            expect(() => p!.spawn("g10")).toThrow(/capacity|max/i)
        } finally {
            p?.nukeAll()
            if (original === undefined) delete process.env.NUSHELL_MCP_MAX_REPLS
            else process.env.NUSHELL_MCP_MAX_REPLS = original
        }
    })
})

describe("parseEvaluateEnvelope — pure helper", () => {
    test("extracts cwd, history_index, timestamp from a canonical envelope", () => {
        const text = `{cwd:/home/ramda/code/nushell-mcp,history_index:5,timestamp:2026-05-23T19:29:15.835595276+00:00,output:"42"}`
        const env = parseEvaluateEnvelope(text)
        expect(env.kind).toBe("ok")
        if (env.kind !== "ok") throw new Error("expected ok")
        expect(env.cwd).toBe("/home/ramda/code/nushell-mcp")
        expect(env.historyIndex).toBe(5)
        expect(env.timestamp).toBe("2026-05-23T19:29:15.835595276+00:00")
    })

    test("tolerates reordered fields", () => {
        const text = `{history_index:7, output:"x", cwd:/tmp, timestamp:2026-01-01T00:00:00.000000000+00:00}`
        const env = parseEvaluateEnvelope(text)
        expect(env.kind).toBe("ok")
        if (env.kind !== "ok") throw new Error("expected ok")
        expect(env.cwd).toBe("/tmp")
        expect(env.historyIndex).toBe(7)
        expect(env.timestamp).toBe("2026-01-01T00:00:00.000000000+00:00")
    })

    test("returns empty variant for non-envelope text (e.g. list_commands plaintext)", () => {
        const env = parseEvaluateEnvelope("ls: list files\nwhere: filter\n")
        expect(env).toEqual({ kind: "empty" })
    })

    test("returns ok variant with only cwd when other fields are missing", () => {
        const text = `{cwd:/var/log, output:"ok"}`
        const env = parseEvaluateEnvelope(text)
        expect(env.kind).toBe("ok")
        if (env.kind !== "ok") throw new Error("expected ok")
        expect(env.cwd).toBe("/var/log")
        expect(env.historyIndex).toBeUndefined()
        expect(env.timestamp).toBeUndefined()
    })

    // BUG 1 regression: cwd paths containing spaces must not be truncated.
    test("cwd with a single internal space is captured in full", () => {
        const text = `{cwd:/home/user/My Documents,history_index:1,timestamp:2026-01-01T00:00:00.000000000+00:00,output:"ok"}`
        const env = parseEvaluateEnvelope(text)
        expect(env.kind).toBe("ok")
        if (env.kind !== "ok") throw new Error("expected ok")
        expect(env.cwd).toBe("/home/user/My Documents")
        expect(env.historyIndex).toBe(1)
    })

    test("cwd with multiple internal spaces is captured in full", () => {
        const text = `{cwd:/home/user/path with many spaces,history_index:2,timestamp:2026-01-01T00:00:00.000000000+00:00,output:"ok"}`
        const env = parseEvaluateEnvelope(text)
        expect(env.kind).toBe("ok")
        if (env.kind !== "ok") throw new Error("expected ok")
        expect(env.cwd).toBe("/home/user/path with many spaces")
        expect(env.historyIndex).toBe(2)
    })

    test("cwd appears at the start of the envelope (no preceding comma)", () => {
        const text = `{cwd:/tmp/spaced path,output:"x"}`
        const env = parseEvaluateEnvelope(text)
        expect(env.kind).toBe("ok")
        if (env.kind !== "ok") throw new Error("expected ok")
        expect(env.cwd).toBe("/tmp/spaced path")
    })

    test("cwd appears at the end of the envelope (last field before closing brace)", () => {
        const text = `{output:"x",history_index:3,cwd:/end spaced path}`
        const env = parseEvaluateEnvelope(text)
        expect(env.kind).toBe("ok")
        if (env.kind !== "ok") throw new Error("expected ok")
        expect(env.cwd).toBe("/end spaced path")
        expect(env.historyIndex).toBe(3)
    })

    // G4 regression: trailing whitespace in cwd must be stripped. These protect
    // the `[^,}]+?\s*(?=[,}])` lookahead in the parser against a refactor that
    // replaces it with the greedy `[^,}]+` (no trim), which would silently
    // leave trailing spaces in the returned cwd.
    test("cwd with trailing spaces before a comma is stripped (mid-envelope)", () => {
        const text = `{cwd:/foo bar   ,history_index:5,timestamp:0}`
        const env = parseEvaluateEnvelope(text)
        expect(env.kind).toBe("ok")
        if (env.kind !== "ok") throw new Error("expected ok")
        expect(env.cwd).toBe("/foo bar")
        expect(env.historyIndex).toBe(5)
    })

    test("cwd with trailing spaces before closing brace is stripped (end-of-envelope)", () => {
        const text = `{history_index:5,timestamp:0,cwd:/foo bar   }`
        const env = parseEvaluateEnvelope(text)
        expect(env.kind).toBe("ok")
        if (env.kind !== "ok") throw new Error("expected ok")
        expect(env.cwd).toBe("/foo bar")
    })
})

describe("NuMcpPool — BUG 3 regression: concurrent clear(key, 'all') must not throw", () => {
    test("two concurrent clear(key, 'all') calls both resolve without error", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("concurrent-clear")
            // Both callers race to clear the same key. Only one should
            // do the kill+spawn work; the second should silently succeed.
            await expect(
                Promise.all([
                    p.clear("concurrent-clear", "all"),
                    p.clear("concurrent-clear", "all"),
                ]),
            ).resolves.toEqual([undefined, undefined])
            // Bucket must still exist (one clear won and respawned).
            expect(p.has("concurrent-clear")).toBe(true)
            // Pool has exactly one bucket registered under this key.
            expect(p.list().filter((k) => k === "concurrent-clear").length).toBe(1)
        } finally {
            p.nukeAll()
        }
    })
})

describe("NuMcpPool — BUG 4 regression: concurrent kill and clear must not resurrect bucket", () => {
    test("kill() wins over concurrent clear('all') — bucket is gone after both settle", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("race-kill-clear")
            // Fire both concurrently. kill() should acquire the mutex and
            // destroy the bucket; clear()'s spawn attempt must not revive it.
            await Promise.all([
                p.clear("race-kill-clear", "all"),
                p.kill("race-kill-clear"),
            ])
            // After both settle, the bucket must be gone (kill wins).
            expect(p.has("race-kill-clear")).toBe(false)
        } finally {
            p.nukeAll()
        }
    })

    test("kill() on a missing key returns false asynchronously", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        expect(await p.kill("never-existed")).toBe(false)
    })
})

describe("NuMcpPool — BUG 2 regression: call() returns atomic {response, envelope} snapshot", () => {
    test("call() returns envelope snapshot co-located with the response", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("atomic-env")
            await p.call("atomic-env", "evaluate", { input: `cd "${TMP_DIR}"` })
            // The second call's envelope should reflect cwd=/tmp set above.
            const { response, envelope } = await p.call("atomic-env", "evaluate", {
                input: "1 + 1",
            })
            assertOk(response)
            expect(response.text).toContain("output:\"2\"")
            // Envelope must carry the cwd that was set before this call.
            expect(envelope.kind).toBe("ok")
            if (envelope.kind !== "ok") throw new Error("envelope not ok")
            expect(envelope.cwd).toBeDefined()
            expect(typeof envelope.historyIndex).toBe("number")
        } finally {
            p.nukeAll()
        }
    })

    test("call() envelope snapshot survives bucket pruning after the call", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("pruned-env")
            // Establish a cwd in the session.
            await p.call("pruned-env", "evaluate", { input: `cd "${TMP_DIR}"` })
            // Start the call and capture the return atomically.
            const callPromise = p.call("pruned-env", "evaluate", { input: "1" })
            // The result must be available regardless of what happens next.
            const { response, envelope } = await callPromise
            // Immediately kill the bucket so it is pruned from the map.
            await p.kill("pruned-env")
            // The envelope snapshot from call() must still be accessible —
            // it was captured inside the mutex, so no separate lookup is needed.
            expect(p.has("pruned-env")).toBe(false)
            expect(response.isError).toBe(false)
            expect(envelope.kind).toBe("ok")
            if (envelope.kind !== "ok") throw new Error("envelope not ok")
            expect(envelope.cwd).toBeDefined()
        } finally {
            p.nukeAll()
        }
    })
})

describe("NuMcpPool — cycle 3: kill terminates an in-flight long call promptly", () => {
    test("pool.kill resolves quickly (kill-first), in-flight call rejects", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("long-call")
            // Fire a long evaluate without awaiting — it will hold the
            // bucket mutex for the duration of the sleep.
            const callPromise = p.call("long-call", "evaluate", {
                input: "sleep 5sec",
            })
            // Capture the call's eventual outcome without leaking an
            // unhandled rejection in the meantime.
            const settled = callPromise.then(
                () => ({ ok: true }),
                (err) => ({ ok: false, err }),
            )
            // Yield one macrotask so the call's mutex.acquire() registers.
            await new Promise((r) => setImmediate(r))
            const t0 = Date.now()
            const killed = await p.kill("long-call")
            const elapsed = Date.now() - t0
            // Pre-fix code would wait ~5sec here (mutex held by sleep).
            // Post-fix (kill-first) resolves within milliseconds because
            // child.kill() triggers handleExit which rejects the in-flight
            // callTool, releasing the mutex immediately.
            expect(killed).toBe(true)
            expect(elapsed).toBeLessThan(1000)
            // The in-flight call promise must reject (child died).
            const outcome = await settled
            expect(outcome.ok).toBe(false)
            // Bucket is gone.
            expect(p.has("long-call")).toBe(false)
        } finally {
            p.nukeAll()
        }
    })
})
