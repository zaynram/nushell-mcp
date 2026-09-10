/**
 * Windows-essential environment backfill (issue #2).
 *
 * MCP hosts launch stdio servers with a whitelist env; the MCP TypeScript
 * SDK's win32 list omits PATHEXT, COMSPEC, and TMP. Bun's own spawn backfill
 * adds SYSTEMROOT, TEMP, PATH, and WINDIR, never these three. Without PATHEXT,
 * nu's `which` and bare external invocation cannot resolve extensionless
 * names, so every nu spawn site routes its env through `withEssentials`.
 */

type Platform = typeof process.platform
export type Env = Record<string, string | undefined>

export const isWin = (platform: Platform = process.platform) => platform === 'win32'

/** Windows env names are case-insensitive and hosts vary (`ComSpec`, `SystemRoot`). */
function findKey(
  env: Env,
  name: string,
  platform: Platform = process.platform
): string | undefined {
  const upper = name.toUpperCase()
  const compare = isWin(platform)
    ? (s: string) => s.toUpperCase() == upper
    : (s: string) => s == name
  return Object.keys(env).find(compare)
}

function lookup<
  T extends undefined | true = undefined,
  O extends [string, string | undefined] | string | undefined = T extends undefined
    ? string | undefined
    : [string, string | undefined],
>(env: Env, name: string, platform: Platform = process.platform, includeKey?: T): O {
  const key = findKey(env, name, platform)
  const val: string | undefined = key && env[key]
  return (includeKey ? [key ?? name, val] : val) as O
}

/** The allowlist: name → Windows default when neither env nor host has it. */
const WINDOWS_ESSENTIALS: Record<string, (host: Env) => string | undefined> = {
  PATHEXT: () => '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
  COMSPEC: host =>
    `${lookup(host, 'SYSTEMROOT', 'win32') ?? 'C:\\Windows'}\\system32\\cmd.exe`,
  TMP: host => lookup(host, 'TEMP', 'win32'),
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
  platform: Platform = process.platform
): Env {
  if (!isWin(platform)) return env
  const acc = { ...env }
  for (const [key, fallback] of Object.entries(WINDOWS_ESSENTIALS)) {
    if (lookup(acc, key, platform) !== undefined) continue
    const val = lookup(host, key, platform) ?? fallback(host)
    if (val === undefined) continue
    acc[key] = val
  }
  return acc
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
  platform: Platform = process.platform
): Env {
  if (dirs.length === 0) return env
  const [key, value] = lookup(env, 'NU_LIB_DIRS', platform, true)
  const joined = (value ? [...dirs, value] : dirs).join(isWin(platform) ? ';' : ':')
  return { ...env, [key]: joined }
}
