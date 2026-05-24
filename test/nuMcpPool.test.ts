/**
 * Integration tests for NuMcpPool — a Map-backed registry of NuMcpChild
 * instances, one per REPL bucket key. Each test spawns real `nu --mcp`
 * children and the afterAll teardown nukes them so files don't leak.
 *
 * Plan B Cycle 3.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { killAll as nuKillAll } from "../src/nu.js"
import { getNuMcpClient } from "../src/nuMcpClient.js"
import { NuMcpPool, getReplPool, parseEvaluateEnvelope } from "../src/nuMcpPool.js"

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

    test("kill() removes the bucket from the map", () => {
        pool.spawn("beta")
        expect(pool.has("beta")).toBe(true)
        const killed = pool.kill("beta")
        expect(killed).toBe(true)
        expect(pool.has("beta")).toBe(false)
        expect(pool.list()).not.toContain("beta")
    })

    test("kill() on a missing bucket returns false (idempotent)", () => {
        expect(pool.kill("nonexistent-key")).toBe(false)
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

    test("after kill, a new spawn fits under the cap", () => {
        const p = new NuMcpPool({ maxRepls: 2 })
        try {
            p.spawn("k1")
            p.spawn("k2")
            p.kill("k1")
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
            const r = await p.call("solo", "evaluate", { input: "1 + 1" })
            expect(r.isError).toBe(false)
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
            const a = await p.call("buf", "evaluate", { input: "1 + 1" })
            const head1 = p.lastResponse("buf")
            expect(head1).toEqual(a)
            const b = await p.call("buf", "evaluate", { input: "2 + 2" })
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
            const r = await p.call("rej", "evaluate", { input: "42" })
            expect(r.isError).toBe(false)
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
            expect(head?.text).toContain("output:\"6\"")
            // Inspect buffer to confirm oldest is gone — head is 6, oldest entry
            // should be 2 (entries 2..6), not 1.
            const all = p._inspectBuffer("ring")
            expect(all.length).toBe(5)
            // Head-first ordering: index 0 is newest.
            expect(all[0]?.text).toContain("output:\"6\"")
            expect(all[4]?.text).toContain("output:\"2\"")
            // 1 is evicted.
            expect(all.find((r) => r.text.includes("output:\"1\""))).toBeUndefined()
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
            const r = await p.call("clr", "evaluate", { input: "2" })
            expect(r.isError).toBe(false)
        } finally {
            p.nukeAll()
        }
    })

    test("envelope cache updates cwd after `cd`", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("env")
            await p.call("env", "evaluate", { input: "cd /tmp" })
            const env = p.envelope("env")
            expect(env.cwd).toBe("/tmp")
        } finally {
            p.nukeAll()
        }
    })

    test("envelope cache tracks history_index as it advances", async () => {
        const p = new NuMcpPool({ maxRepls: 1 })
        try {
            p.spawn("hist")
            await p.call("hist", "evaluate", { input: "1" })
            const first = p.envelope("hist").historyIndex
            await p.call("hist", "evaluate", { input: "2" })
            const second = p.envelope("hist").historyIndex
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

describe("parseEvaluateEnvelope — pure helper", () => {
    test("extracts cwd, history_index, timestamp from a canonical envelope", () => {
        const text = `{cwd:/home/ramda/code/nushell-mcp,history_index:5,timestamp:2026-05-23T19:29:15.835595276+00:00,output:"42"}`
        const env = parseEvaluateEnvelope(text)
        expect(env.cwd).toBe("/home/ramda/code/nushell-mcp")
        expect(env.historyIndex).toBe(5)
        expect(env.timestamp).toBe("2026-05-23T19:29:15.835595276+00:00")
    })

    test("tolerates reordered fields", () => {
        const text = `{history_index:7, output:"x", cwd:/tmp, timestamp:2026-01-01T00:00:00.000000000+00:00}`
        const env = parseEvaluateEnvelope(text)
        expect(env.cwd).toBe("/tmp")
        expect(env.historyIndex).toBe(7)
        expect(env.timestamp).toBe("2026-01-01T00:00:00.000000000+00:00")
    })

    test("returns empty object for non-envelope text (e.g. list_commands plaintext)", () => {
        const env = parseEvaluateEnvelope("ls: list files\nwhere: filter\n")
        expect(env).toEqual({})
    })

    test("returns partial object when some fields are missing", () => {
        const text = `{cwd:/var/log, output:"ok"}`
        const env = parseEvaluateEnvelope(text)
        expect(env.cwd).toBe("/var/log")
        expect(env.historyIndex).toBeUndefined()
        expect(env.timestamp).toBeUndefined()
    })
})
