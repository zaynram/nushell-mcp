/**
 * Tests for the async Mutex primitive. Pure — no subprocess or timer
 * dependency beyond `setTimeout` for fairness probes.
 *
 * Plan B Cycle 1.
 */
import { describe, expect, test } from "bun:test"
import { Mutex } from "../src/mutex.js"

describe("Mutex", () => {
    test("sequential acquire/release", async () => {
        const m = new Mutex()
        const r1 = await m.acquire()
        r1()
        const r2 = await m.acquire()
        r2()
        // No assertions needed — if either acquire hung, the test would time out.
        expect(true).toBe(true)
    })

    test("acquire blocks while held; resolves after release", async () => {
        const m = new Mutex()
        const r1 = await m.acquire()
        let second = false
        const promise = m.acquire().then((r) => {
            second = true
            r()
        })
        // Yield twice; `second` must still be false because lock is held.
        await new Promise((r) => setTimeout(r, 20))
        expect(second).toBe(false)
        r1()
        await promise
        expect(second).toBe(true)
    })

    test("concurrent acquires resolve in FIFO order", async () => {
        const m = new Mutex()
        const order: number[] = []
        const tasks = [1, 2, 3, 4].map((n) =>
            (async () => {
                const r = await m.acquire()
                order.push(n)
                // Hold briefly so out-of-order resolves would be detectable.
                await new Promise((r) => setTimeout(r, 5))
                r()
            })(),
        )
        await Promise.all(tasks)
        expect(order).toEqual([1, 2, 3, 4])
    })

    test("release after throw doesn't leak the lock", async () => {
        const m = new Mutex()
        const r1 = await m.acquire()
        try {
            throw new Error("boom")
        } catch {
            // swallow
        } finally {
            r1()
        }
        // If the lock leaked, this acquire would hang.
        const r2 = await m.acquire()
        r2()
        expect(true).toBe(true)
    })

    test("double-release is a no-op (doesn't unlock the wrong holder)", async () => {
        const m = new Mutex()
        const r1 = await m.acquire()
        r1()
        r1() // calling release twice should not invalidate state

        // Queue two more acquires; both must still serialize.
        const order: number[] = []
        await Promise.all([
            (async () => {
                const r = await m.acquire()
                order.push(1)
                await new Promise((r) => setTimeout(r, 5))
                r()
            })(),
            (async () => {
                const r = await m.acquire()
                order.push(2)
                r()
            })(),
        ])
        expect(order).toEqual([1, 2])
    })
})
