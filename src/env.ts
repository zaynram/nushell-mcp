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
function findKey(env: Env, name: string): string | undefined {
  const target = name.toUpperCase()
  return Object.keys(env).find((k) => k.toUpperCase() === target)
}

function lookup(env: Env, name: string): string | undefined {
  const key = findKey(env, name)
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

/**
 * Return a copy of `env` with `dirs` prepended to `NU_LIB_DIRS`, joined with
 * the separator nu splits that variable on: `;` on Windows, `:` elsewhere.
 * Earlier entries win, and every entry outranks the host's own `NU_LIB_DIRS`
 * and nu's defaults. The `--include-path` flag cannot carry these: nu splits
 * it on `:` on every platform ("for backwards compatibility"), so `C:\\dir`
 * fragments into `C` and a drive-relative `\\dir` that resolves only when the
 * cwd shares the drive. Empty `dirs` returns `env` untouched.
 */
export function withIncludeDirs(
  env: Env,
  dirs: readonly string[],
  platform: string = process.platform
): Env {
  if (dirs.length === 0) return env
  const windows = platform === 'win32'
  const key = (windows ? findKey(env, 'NU_LIB_DIRS') : undefined) ?? 'NU_LIB_DIRS'
  const existing = env[key]
  const joined = [...dirs, ...(existing ? [existing] : [])].join(windows ? ';' : ':')
  return { ...env, [key]: joined }
}
