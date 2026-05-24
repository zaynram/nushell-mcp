/**
 * Async Mutex primitive — a promise-chain mutex that serializes async code.
 *
 * `acquire()` returns a `release` function the holder must invoke (typically
 * in a `finally`) before another acquire can proceed. Queued acquires resolve
 * in FIFO order. Double-release is a no-op so callers can safely call
 * release on multiple exit paths without risk of unlocking the wrong holder.
 *
 * Plan B Cycle 1.
 */

export class Mutex {
  /** The end of the current chain. New acquires await this and then extend it. */
  private chain: Promise<void> = Promise.resolve()

  /**
   * Wait until any prior holder releases, then take the lock. Returns a
   * `release` function. Calling it more than once is a no-op (the second
   * call doesn't unlock a subsequent holder).
   */
  async acquire(): Promise<() => void> {
    // Use a sentinel to make release idempotent.
    let released = false
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = () => {
        if (released) return
        released = true
        resolve()
      }
    })
    const prev = this.chain
    // Extend the chain *before* awaiting prev — otherwise concurrent
    // acquires would all see the same `prev` and race to extend, breaking
    // FIFO order.
    this.chain = next
    await prev
    return release
  }
}
