/**
 * Plan B Cycle 0: prep refactors in nu.ts. Verifies the active set's role
 * tagging and the sanitizeKey export. Both are infrastructure changes with
 * no user-visible behavior change.
 */
import { afterAll, describe, expect, test } from "bun:test"
import {
    _getActiveRoles,
    abortExec,
    killAll,
    runRaw,
    sanitizeKey,
} from "../src/nu.js"
import { active, addActive } from "../src/active.js"
import { NuMcpChild } from "../src/nuMcpClient.js"
import { NuMcpPool } from "../src/nuMcpPool.js"

afterAll(() => {
    killAll()
})

describe("sanitizeKey export (Cycle 0)", () => {
    test("accepts valid keys and defaults to 'default'", () => {
        expect(sanitizeKey("valid-key_123")).toBe("valid-key_123")
        expect(sanitizeKey(undefined)).toBe("default")
        expect(sanitizeKey("a")).toBe("a")
    })

    test("rejects keys with disallowed characters", () => {
        expect(() => sanitizeKey("has space")).toThrow()
        expect(() => sanitizeKey("with/slash")).toThrow()
        expect(() => sanitizeKey("dots.no")).toThrow()
        expect(() => sanitizeKey("")).toThrow()
    })
})

describe("active set role tagging (Cycle 0)", () => {
    test("a running nu exec spawn is tagged as 'exec'", async () => {
        // Kick off a long-ish process so we can observe the active set while
        // it's in-flight, then await it to clean up.
        const pending = runRaw("sleep 1sec", { timeoutMs: 5_000 })
        // Yield twice so spawnNu has time to register the proc in active.
        await new Promise((r) => setTimeout(r, 100))
        const roles = _getActiveRoles()
        expect(roles).toContain("exec")
        await pending
    })

    test("active set empties after the proc exits", async () => {
        await runRaw("1 + 1")
        // After await resolves, spawnNu's finally has run; proc is removed.
        const roles = _getActiveRoles()
        expect(roles.length).toBe(0)
    })

    test("killAll terminates active procs regardless of role", async () => {
        const pending = runRaw("sleep 30sec", { timeoutMs: 10_000 })
        await new Promise((r) => setTimeout(r, 100))
        const killed = killAll()
        expect(killed).toBeGreaterThanOrEqual(1)
        const r = await pending
        expect(r.exitCode).not.toBe(0)
    }, 15_000)
})

describe("active set role tagging — NuMcpChild (repl + doc)", () => {
    test("a spawned NuMcpChild('repl') appears in active set as 'repl'", async () => {
        const child = new NuMcpChild("repl")
        try {
            // ensureReady triggers startup() and addActive.
            await child.callTool("list_commands", { find: "where" })
            const roles = _getActiveRoles()
            expect(roles).toContain("repl")
        } finally {
            child.kill()
        }
    })

    test("after kill(), repl child is removed from active set", async () => {
        const child = new NuMcpChild("repl")
        await child.callTool("list_commands", { find: "where" })
        expect(_getActiveRoles()).toContain("repl")
        child.kill()
        // kill() calls removeActive synchronously.
        const roles = _getActiveRoles()
        expect(roles.filter((r) => r === "repl").length).toBe(0)
    })

    test("a spawned NuMcpChild('doc') appears in active set as 'doc'", async () => {
        const child = new NuMcpChild("doc")
        try {
            await child.callTool("list_commands", { find: "where" })
            const roles = _getActiveRoles()
            expect(roles).toContain("doc")
        } finally {
            child.kill()
        }
    })

    test("after kill(), doc child is removed from active set", async () => {
        const child = new NuMcpChild("doc")
        await child.callTool("list_commands", { find: "where" })
        expect(_getActiveRoles()).toContain("doc")
        child.kill()
        const roles = _getActiveRoles()
        expect(roles.filter((r) => r === "doc").length).toBe(0)
    })

    test("pool spawn registers child as 'repl' in active set", async () => {
        const pool = new NuMcpPool({ maxRepls: 1 })
        try {
            pool.spawn("activetest")
            // Trigger lazy spawn via a real call.
            await pool.call("activetest", "evaluate", { input: "1" })
            const roles = _getActiveRoles()
            expect(roles).toContain("repl")
        } finally {
            pool.nukeAll()
        }
    })

    test("pool nukeAll removes repl children from active set", async () => {
        const pool = new NuMcpPool({ maxRepls: 1 })
        pool.spawn("activeclean")
        await pool.call("activeclean", "evaluate", { input: "1" })
        expect(_getActiveRoles()).toContain("repl")
        pool.nukeAll()
        const roles = _getActiveRoles()
        expect(roles.filter((r) => r === "repl").length).toBe(0)
    })
})

describe("abortExec — Copilot 3295712499/3295712510: kills bash too", () => {
    test("abortExec kills both 'exec' and 'bash' procs and leaves 'repl'/'doc' alone", async () => {
        // Spawn one long-running exec (auto-tagged 'exec') and manually
        // register a fake bash-tagged proc (the bash-runner code path is
        // platform-gated and not always reachable in CI; this directly
        // exercises the role filter that was previously dropping bash).
        const execPending = runRaw("sleep 30sec", { timeoutMs: 10_000 })
        await new Promise((r) => setTimeout(r, 100))
        const fakeBash = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
        addActive(fakeBash, "bash")

        // Park a repl child as a control — abortExec must not touch it.
        const repl = new NuMcpChild("repl")
        await repl.callTool("list_commands", { find: "where" })

        const beforeRoles = _getActiveRoles()
        expect(beforeRoles).toContain("exec")
        expect(beforeRoles).toContain("bash")
        expect(beforeRoles).toContain("repl")

        const aborted = abortExec()
        // At least the exec and the bash proc were killed.
        expect(aborted).toBeGreaterThanOrEqual(2)

        const afterRoles = _getActiveRoles()
        expect(afterRoles.includes("exec")).toBe(false)
        expect(afterRoles.includes("bash")).toBe(false)
        // Repl untouched.
        expect(afterRoles).toContain("repl")

        // Cleanup: drain the killed exec promise and tear down the repl.
        const execResult = await execPending
        expect(execResult.exitCode).not.toBe(0)
        repl.kill()
        // fakeBash was already killed by abortExec; make sure it's reaped.
        try {
            fakeBash.kill()
        } catch {
            // already dead
        }
        active.delete(fakeBash)
    }, 15_000)
})
