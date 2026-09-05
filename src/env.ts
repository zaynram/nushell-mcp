/**
 * Windows-essential environment backfill (issue #2).
 *
 * MCP hosts launch stdio servers with a whitelist env; the MCP TypeScript
 * SDK's win32 list omits PATHEXT, COMSPEC, and TMP. Bun's own spawn backfill
 * adds SYSTEMROOT, TEMP, PATH, and WINDIR, never these three. Without PATHEXT,
 * nu's `which` and bare external invocation cannot resolve extensionless
 * names, so every nu spawn site routes its env through `withEssentials`.
 */

export type Env = Record<string, string | undefined>

/** Windows env names are case-insensitive and hosts vary (`ComSpec`, `SystemRoot`). */
function lookup(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/** The allowlist: name → Windows default when neither env nor host has it. */
const WINDOWS_ESSENTIALS: Record<string, (host: Env) => string | undefined> = {
  PATHEXT: () => '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
  COMSPEC: (host) => `${lookup(host, 'SYSTEMROOT') ?? 'C:\\Windows'}\\system32\\cmd.exe`,
  TMP: (host) => lookup(host, 'TEMP'),
}

/**
 * Return a copy of `env` with each Windows essential added when absent: the
 * host's value if it has one, else the Windows default. Presence is matched
 * case-insensitively so an existing `ComSpec` never gains a shadow `COMSPEC`.
 * Off Windows `env` is returned untouched.
 */
export function withEssentials(
  env: Env,
  host: Env = process.env,
  platform: string = process.platform
): Env {
  if (platform !== 'win32') return env
  const out: Env = { ...env }
  for (const [name, fallback] of Object.entries(WINDOWS_ESSENTIALS)) {
    if (lookup(out, name) !== undefined) continue
    const value = lookup(host, name) ?? fallback(host)
    if (value !== undefined) out[name] = value
  }
  return out
}
