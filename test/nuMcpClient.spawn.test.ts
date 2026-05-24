/**
 * Integration tests for the singleton `nu --mcp` client lifecycle. Spawns a
 * real `nu --mcp` subprocess; the per-file afterAll teardown kills it so
 * tests across files don't leak children.
 *
 * Plan A, Cycle 2+.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { killAll as nuKillAll } from "../src/nu.js"
import {
    NuMcpChild,
    type NuMcpToolResponse,
    getNuMcpClient,
} from "../src/nuMcpClient.js"

/**
 * Narrow a `NuMcpToolResponse` to its success branch. The discriminated
 * union forbids reading `.text` without narrowing — `expect()` isn't a
 * type guard, so each test that wants `.text` after asserting success
 * funnels through this helper instead of duplicating the `if (isError)
 * throw` boilerplate.
 */
function assertOk(
    r: NuMcpToolResponse,
): asserts r is Extract<NuMcpToolResponse, { isError: false }> {
    if (r.isError) {
        throw new Error(`expected success response, got error: ${r.errorText}`)
    }
}

// Reset singleton state at file start — other test files (smoke.test.ts) may
// have spawned the singleton, which would invalidate "not alive before any
// call" assertions. The afterAll handles cleanup for callers running AFTER us.
beforeAll(() => {
    getNuMcpClient().kill()
})

afterAll(() => {
    getNuMcpClient().kill()
})

describe("getNuMcpClient — Cycle 2: lazy spawn + initialize handshake", () => {
    test("not alive before any call", () => {
        const client = getNuMcpClient()
        expect(client.isAlive()).toBe(false)
    })

    test("first callTool spawns child, runs initialize, returns response", async () => {
        const client = getNuMcpClient()
        const response = await client.callTool("list_commands", {
            find: "where",
        })
        assertOk(response)
        // Output should contain the `where` builtin
        expect(response.text).toContain("where")
        expect(client.isAlive()).toBe(true)
    })

    test("subsequent calls reuse the same child", async () => {
        const client = getNuMcpClient()
        expect(client.isAlive()).toBe(true)
        const response = await client.callTool("command_help", {
            name: "where",
        })
        assertOk(response)
        expect(response.text).toContain("Filter values")
    })

    test("calling a tool with an invalid name surfaces error", async () => {
        const client = getNuMcpClient()
        const response = await client.callTool("command_help", {
            name: "this-command-does-not-exist-xyz",
        })
        expect(response.isError).toBe(true)
    })
})

describe("getNuMcpClient — Cycle 3: concurrent request correlation", () => {
    test("two concurrent callTools resolve to their own responses", async () => {
        const client = getNuMcpClient()
        // Ensure singleton is up (kill from a prior test forces respawn here).
        await client.callTool("list_commands", { find: "ls" })
        const [list, help] = await Promise.all([
            client.callTool("list_commands", { find: "where" }),
            client.callTool("command_help", { name: "where" }),
        ])
        assertOk(list)
        assertOk(help)
        // Each response must match its own request, not the other's.
        expect(list.text).toContain("where")
        expect(help.text).toContain("Filter values")
        expect(help.text).not.toContain("polars arg-where")
    })

    test("kill() rejects in-flight pending requests", async () => {
        const client = getNuMcpClient()
        await client.callTool("list_commands", { find: "ls" })
        // Kick off a request without awaiting, then pump the microtask queue
        // so callTool gets past `await ensureReady()` and registers a
        // pending entry before we kill — otherwise the call fails with
        // "no stdin" on resume (also a valid rejection, but not the path
        // this test is meant to exercise).
        const pending = client.callTool("list_commands", { find: "anything" })
        await new Promise((r) => setImmediate(r))
        client.kill()
        await expect(pending).rejects.toThrow(/killed|exited/)
    })
})

describe("getNuMcpClient — Cycle 4: restart on death", () => {
    test("after kill(), next callTool transparently respawns", async () => {
        const client = getNuMcpClient()
        await client.callTool("list_commands", { find: "ls" })
        expect(client.isAlive()).toBe(true)
        client.kill()
        expect(client.isAlive()).toBe(false)
        const response = await client.callTool("list_commands", {
            find: "where",
        })
        expect(response.isError).toBe(false)
        expect(client.isAlive()).toBe(true)
    })

    test("two concurrent calls after kill don't double-spawn", async () => {
        const client = getNuMcpClient()
        await client.callTool("list_commands", { find: "ls" })
        client.kill()
        // Both calls race to spawn; the readyPromise gate must hand back the
        // same in-flight startup to both, not start two children.
        const [r1, r2] = await Promise.all([
            client.callTool("list_commands", { find: "where" }),
            client.callTool("command_help", { name: "where" }),
        ])
        assertOk(r1)
        assertOk(r2)
        expect(r2.text).toContain("Filter values")
    })
})

describe("NuMcpChild — Plan B Cycle 2: instantiable independently", () => {
    test("new NuMcpChild() can be created without going through the singleton", async () => {
        const child = new NuMcpChild("doc")
        try {
            expect(child.isAlive()).toBe(false)
            const response = await child.callTool("list_commands", {
                find: "where",
            })
            assertOk(response)
            expect(response.text).toContain("where")
            expect(child.isAlive()).toBe(true)
        } finally {
            child.kill()
        }
    })

    test("two NuMcpChild instances are isolated — killing one leaves the other alive", async () => {
        const a = new NuMcpChild("doc")
        const b = new NuMcpChild("doc")
        try {
            await Promise.all([
                a.callTool("list_commands", { find: "ls" }),
                b.callTool("list_commands", { find: "ls" }),
            ])
            expect(a.isAlive()).toBe(true)
            expect(b.isAlive()).toBe(true)
            a.kill()
            expect(a.isAlive()).toBe(false)
            expect(b.isAlive()).toBe(true)
            // b can still service requests after a was killed
            const response = await b.callTool("command_help", { name: "where" })
            assertOk(response)
            expect(response.text).toContain("Filter values")
        } finally {
            a.kill()
            b.kill()
        }
    })

    test("singleton and a fresh NuMcpChild instance don't share lifecycle", async () => {
        // Reset singleton first so we know its state.
        getNuMcpClient().kill()
        const fresh = new NuMcpChild("doc")
        try {
            await fresh.callTool("list_commands", { find: "ls" })
            expect(fresh.isAlive()).toBe(true)
            // Singleton must remain dead — we only touched the fresh instance.
            expect(getNuMcpClient().isAlive()).toBe(false)
        } finally {
            fresh.kill()
        }
    })
})

describe("getNuMcpClient — Cycle 5: killAll integration", () => {
    test("nu.killAll() also kills the doc singleton", async () => {
        const client = getNuMcpClient()
        await client.callTool("list_commands", { find: "ls" })
        expect(client.isAlive()).toBe(true)
        nuKillAll()
        expect(client.isAlive()).toBe(false)
    })

    test("count returned by killAll includes the singleton when alive", async () => {
        const client = getNuMcpClient()
        await client.callTool("list_commands", { find: "ls" })
        const killed = nuKillAll()
        expect(killed).toBeGreaterThanOrEqual(1)
    })

    test("killAll on a dead singleton does not over-count", () => {
        const client = getNuMcpClient()
        expect(client.isAlive()).toBe(false)
        const killed = nuKillAll()
        // Nothing should be alive — singleton dead from prior test, active set empty.
        expect(killed).toBe(0)
    })
})

describe("NuMcpChild — onExit listener-error isolation", () => {
    test("one throwing listener does not prevent subsequent listeners from firing", async () => {
        const child = new NuMcpChild("doc")
        let called2 = false
        let called3 = false

        child.onExit(() => {
            throw new Error("listener-1 boom")
        })
        child.onExit(() => {
            called2 = true
        })
        child.onExit(() => {
            called3 = true
        })

        // kill() calls fireExit() unconditionally even when proc is null —
        // we never called startup so proc remains null.
        child.kill()

        expect(called2).toBe(true)
        expect(called3).toBe(true)
    })

    test("onExit registered after exit fires via queueMicrotask", async () => {
        const child = new NuMcpChild("doc")

        // Kill first — fireExit marks child.exited = true.
        child.kill()

        let called4 = false
        child.onExit(() => {
            called4 = true
        })

        // The callback was scheduled via queueMicrotask; flush the microtask
        // queue before asserting.
        await new Promise<void>((r) => queueMicrotask(r))

        expect(called4).toBe(true)
    })
})
