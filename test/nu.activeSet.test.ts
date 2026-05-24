/**
 * Plan B Cycle 0: prep refactors in nu.ts. Verifies the active set's role
 * tagging and the sanitizeKey export. Both are infrastructure changes with
 * no user-visible behavior change.
 */
import { afterAll, describe, expect, test } from "bun:test"
import {
    _getActiveRoles,
    killAll,
    runRaw,
    sanitizeKey,
} from "../src/nu.js"

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
