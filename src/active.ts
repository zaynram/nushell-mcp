/**
 * Process-wide registry of active subprocesses with their role tags.
 *
 * Extracted into its own module to avoid an import cycle: `nu.ts` imports
 * from `nuMcpClient.ts`, so `nuMcpClient.ts` cannot reach back into `nu.ts`.
 * Both `nu.ts` and `nuMcpClient.ts` can safely import from this module.
 *
 * Role tags:
 *   - `"exec"` — one-shot nu pipelines spawned via `spawnNu`.
 *   - `"bash"` — bash-bridge subprocesses spawned via `dumpEnv` for bashEnv.
 *   - `"repl"` — long-lived `nu --mcp` children managed by `NuMcpPool`.
 *   - `"doc"`  — the process-wide `nu --mcp` singleton used for doc queries.
 */

/**
 * Role tag for entries in the `active` map. Used by selective kill paths:
 *   - `killAll` kills every role.
 *   - `abortExec` kills only `"exec"` and `"bash"`.
 */
export type ActiveRole = "exec" | "bash" | "repl" | "doc"

// Every nu/bash subprocess this server has spawned and not yet reaped.
export const active = new Map<Bun.Subprocess, ActiveRole>()

/** Register a subprocess in the active set. */
export function addActive(proc: Bun.Subprocess, role: ActiveRole): void {
    active.set(proc, role)
}

/** Remove a subprocess from the active set (idempotent). */
export function removeActive(proc: Bun.Subprocess): void {
    active.delete(proc)
}

/**
 * Test-only accessor exposing the role tags of currently-tracked
 * subprocesses. Underscore prefix flags this as not part of the stable
 * surface — consumers outside tests should use `killAll` / `abortExec`.
 */
export function _getActiveRoles(): ActiveRole[] {
    return Array.from(active.values())
}
