/**
 * Regression coverage for issue #2 (pathext-omission).
 *
 * The MCP host may launch this server without PATHEXT: the MCP TypeScript SDK
 * stdio whitelist omits PATHEXT, COMSPEC, and TMP on Windows. Every nu child
 * must still resolve bare-name externals. The Windows-only tests below
 * simulate that host by stripping PATHEXT from this process before spawning,
 * which is exactly what `{ ...process.env }` then propagates.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withEssentials } from '#env'
import { killAll, runPipeline } from '#nu'

const WINDOWS = process.platform === 'win32'

/** Bare-name resolution probe: `cmd` is an external on every Windows PATH. */
const PROBE = `if (which cmd | is-not-empty) { 'RESOLVED-OK' } else { 'RESOLVED-MISSING' }`

/** Names from the essentials allowlist the child cannot see (case-insensitive). */
const MISSING_ESSENTIALS = `let cols = ($env | columns | str upcase); [PATHEXT COMSPEC TMP] | where {|k| $k not-in $cols }`

/** Run `fn` with PATHEXT removed from this process, mirroring the SDK whitelist. */
async function withoutPathext<T>(fn: () => Promise<T>): Promise<T> {
  // Hosts vary the key's casing (PATHEXT, PathExt): strip whichever is set
  // and restore it under its original name.
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATHEXT')
  const saved = key === undefined ? undefined : process.env[key]
  if (key !== undefined) delete process.env[key]
  try {
    expect(process.env.PATHEXT).toBeUndefined()
    return await fn()
  } finally {
    if (key !== undefined && saved !== undefined) process.env[key] = saved
  }
}

/**
 * The MCP TypeScript SDK's win32 stdio whitelist (`DEFAULT_INHERITED_ENV_VARS`):
 * what a host like Claude Desktop hands the server. No PATHEXT, COMSPEC, TMP.
 */
const SDK_WIN32_WHITELIST = [
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERNAME',
  'USERPROFILE',
  'PROGRAMFILES',
]

/**
 * Drive a `NuMcpChild` from a child Bun launched under the SDK whitelist env.
 * An env-less `Bun.spawn` inherits the OS-level env block, which mutating
 * `process.env` never touches, so this is the only faithful way to strip
 * PATHEXT from the long-lived `nu --mcp` path. Returns the child's output.
 */
async function replProbeUnderSdkWhitelist(): Promise<string> {
  const env: Record<string, string> = {}
  for (const k of SDK_WIN32_WHITELIST) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  // nu discovery is not what's under test; pin it so the child never has to
  // resolve `nu` without PATHEXT.
  const nuPath = process.env.NUSHELL_MCP_NU_PATH ?? Bun.which('nu')
  if (nuPath) env.NUSHELL_MCP_NU_PATH = nuPath

  const client = join(import.meta.dir, '..', 'src', 'client.ts')
  const script = join(tmpdir(), `nushell-mcp-repl-probe-${crypto.randomUUID()}.ts`)
  await Bun.write(
    script,
    `import { NuMcpChild } from ${JSON.stringify(client)}
const child = new NuMcpChild('repl')
try {
  const r = await child.callTool('evaluate', { input: ${JSON.stringify(PROBE)} })
  console.log(r.isError ? r.errorText : r.text)
} finally {
  child.kill()
}
`
  )
  try {
    const proc = Bun.spawn([process.execPath, script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => proc.kill(), 20_000)
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)
    return out + err
  } finally {
    await rm(script, { force: true })
  }
}

afterAll(() => {
  killAll()
})

const PATHEXT_DEFAULT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'

describe('withEssentials', () => {
  test('is a no-op off Windows even when the host has essentials', () => {
    const host = { PATHEXT: '.EXE', COMSPEC: 'x', TEMP: 't', TMP: 't' }
    expect(withEssentials({ A: '1' }, host, 'linux')).toEqual({ A: '1' })
  })

  test('on Windows fills PATHEXT and COMSPEC with Windows defaults when host and env lack them', () => {
    expect(withEssentials({}, {}, 'win32')).toEqual({
      PATHEXT: PATHEXT_DEFAULT,
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    })
  })

  test('on Windows prefers host values, matched case-insensitively', () => {
    const host = { PathExt: '.EXE', ComSpec: 'D:\\Win\\cmd.exe', Tmp: 'D:\\tmp', temp: 'D:\\t' }
    expect(withEssentials({ A: '1' }, host, 'win32')).toEqual({
      A: '1',
      PATHEXT: '.EXE',
      COMSPEC: 'D:\\Win\\cmd.exe',
      TMP: 'D:\\tmp',
    })
  })

  test('on Windows derives COMSPEC from the host SYSTEMROOT and TMP from TEMP', () => {
    expect(withEssentials({}, { SystemRoot: 'D:\\Win', TEMP: 'D:\\t' }, 'win32')).toEqual({
      PATHEXT: PATHEXT_DEFAULT,
      COMSPEC: 'D:\\Win\\system32\\cmd.exe',
      TMP: 'D:\\t',
    })
  })

  test('on Windows never shadows a differently-cased key already in env', () => {
    const env = { ComSpec: 'keep', pathext: '.BAT', tmp: 'keep' }
    expect(withEssentials(env, { COMSPEC: 'host', PATHEXT: '.EXE', TMP: 'host' }, 'win32')).toEqual(env)
  })

  test('does not mutate its input', () => {
    const env = {}
    withEssentials(env, {}, 'win32')
    expect(env).toEqual({})
  })
})

describe.skipIf(!WINDOWS)('Windows essentials backfill (issue #2)', () => {
  test('one-shot default env resolves a bare external when the host lacks PATHEXT', async () => {
    const r = await withoutPathext(() => runPipeline(PROBE))
    expect(r.nuon).toContain('RESOLVED-OK')
  })

  test('one-shot cleanEnv resolves a bare external with no caller env', async () => {
    const r = await runPipeline(PROBE, { cleanEnv: true, env: {} })
    expect(r.nuon).toContain('RESOLVED-OK')
  })

  test('one-shot cleanEnv child sees PATHEXT, COMSPEC, and TMP', async () => {
    const r = await runPipeline(MISSING_ESSENTIALS, { cleanEnv: true, env: {} })
    expect(r.nuon).toBe('[]')
  })

  // A child Bun over a network share can take well over Bun's 5s default to
  // transpile, spawn nu --mcp, and hand-shake; the fixture has its own 20s guard.
  test(
    'REPL child resolves a bare external under the SDK whitelist env',
    async () => {
      const output = await replProbeUnderSdkWhitelist()
      expect(output).toContain('RESOLVED-OK')
    },
    30_000
  )
})
