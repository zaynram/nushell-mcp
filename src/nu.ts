/**
 * Nushell subprocess layer.
 *
 * Every capability the server exposes ultimately runs the `nu` binary in a
 * fresh, one-shot process (see README "Session model" for why one-shot). This
 * module owns process spawning, timeout/cancellation, version detection, the
 * documentation queries, opt-in env persistence across calls, and the bash
 * environment bridge. `index.ts` only wires these functions to MCP tools.
 */
import { randomBytes } from "node:crypto"
import { mkdir, unlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/** Absolute path to the `nu` executable. Override with `NUSHELL_MCP_NU_PATH`. */
export const NU_PATH: string =
    process.env.NUSHELL_MCP_NU_PATH ?? Bun.which("nu") ?? "nu"

/** Default per-call timeout in ms. Override with `NUSHELL_MCP_TIMEOUT_MS`. */
export const DEFAULT_TIMEOUT_MS: number = Number(
    process.env.NUSHELL_MCP_TIMEOUT_MS ?? 30_000,
)

/**
 * Directory used to store persisted env buckets when `persistEnv` is set on a
 * pipeline call. Override with `NUSHELL_MCP_PERSIST_DIR`; defaults to
 * `~/.nushell-mcp/persist/`.
 */
function defaultPersistDir(): string {
    // `homedir()` can return an empty string on misconfigured systems (no
    // HOME/USERPROFILE set). Falling back to tmpdir keeps persistence usable —
    // the files won't survive a reboot, but the bucket abstraction still
    // works for the lifetime of the running shell session.
    const home = homedir()
    const base = home && home.length > 0 ? home : tmpdir()
    return join(base, ".nushell-mcp", "persist")
}

export const PERSIST_DIR: string =
    process.env.NUSHELL_MCP_PERSIST_DIR ?? defaultPersistDir()

// Every nu subprocess this server has spawned and not yet reaped. `killAll`
// walks this set so a stuck pipeline can be cancelled without touching any
// other process on the machine.
const active = new Set<Bun.Subprocess>()

export interface RunOptions {
    /** Directory to spawn `nu` in. Defaults to the server's working directory. */
    cwd?: string
    /** Extra environment variables for this call. */
    env?: Record<string, string>
    /** Use only `env` instead of extending the server's environment. */
    cleanEnv?: boolean
    /** Kill the process after this many ms. Defaults to `DEFAULT_TIMEOUT_MS`. */
    timeoutMs?: number
    /**
     * Value piped into the pipeline as `$in`, given as NUON or JSON text
     * (`from nuon` accepts both). Honored in **both** structured execution
     * (`runPipeline`) and raw execution (`runRaw`).
     */
    input?: string
}

export interface RawResult {
    stdout: string
    stderr: string
    /** Process exit code, or `null` if the process was killed by a signal. */
    exitCode: number | null
    /** True when the call exceeded its timeout and was killed. */
    timedOut: boolean
}

export interface PipelineResult extends RawResult {
    /**
     * The pipeline's final value serialized as NUON (Nushell Object Notation)
     * via `to nuon --serialize`. NUON is a concise superset of JSON that also
     * preserves Nushell-native types — filesizes, durations, datetimes — that
     * JSON would flatten. `null` only when serialization fails outright.
     */
    nuon: string | null
    /**
     * The `describe` type of the final value, e.g. `table<name: string,
     * size: filesize>`. Tells the model the shape of the data at a glance.
     */
    resultType: string | null
}

/** Spawn `nu` with the given argv, collecting stdout/stderr under a timeout. */
async function spawnNu(argv: string[], opts: RunOptions): Promise<RawResult> {
    const env = opts.cleanEnv
        ? (opts.env ?? {})
        : { ...process.env, ...(opts.env ?? {}) }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const proc = Bun.spawn([NU_PATH, ...argv], {
        cwd: opts.cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    })
    active.add(proc)

    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
    }, timeoutMs)

    try {
        // Drain both pipes concurrently so a chatty stream on one can't wedge
        // the other, then wait for the process to actually finish.
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ])
        await proc.exited
        return { stdout, stderr, exitCode: proc.exitCode, timedOut }
    } finally {
        clearTimeout(timer)
        active.delete(proc)
    }
}

/** Read a temp file's text, or `null` if `nu` never created it. */
async function readIfExists(path: string): Promise<string | null> {
    const file = Bun.file(path)
    return (await file.exists()) ? file.text() : null
}

// --- Script construction ---------------------------------------------------

interface ScriptOptions {
    pipeline: string
    /** When true, the script reads `NU_MCP_INPUT` env var and pipes it as `$in`. */
    hasInput: boolean
    /**
     * When set, the script saves the pipeline's final value as NUON and its
     * `describe` type to these temp paths. Omit for "raw" execution that just
     * runs the pipeline without value capture.
     */
    capture?: { nuonPath: string; typePath: string }
    /**
     * When set, the script loads `$env` from `loadPath` before the pipeline
     * runs (best-effort; missing/invalid file is silently ignored) and saves
     * `$env` to `savePath` afterward. To make env mutations inside the user's
     * pipeline visible to the post-pipeline save line, the `do { }` wrap is
     * switched to `do --env { }`.
     */
    persist?: { loadPath: string; savePath: string }
}

/**
 * Build the nu script string. Composed out of optional fragments so a raw
 * "no-capture" call doesn't pay for NUON serialization, and a non-persisting
 * call doesn't pay for env load/save.
 */
// Nushell's automatic env vars — set by the runtime itself and read-only as
// far as `load-env` is concerned. Persisting them is harmless; loading them
// raises `automatic_env_var_set_manually` and kills the script.
const NU_AUTO_LOAD_BLOCKED = [
    "FILE_PWD",
    "CURRENT_FILE",
    "PROCESS_PATH",
    "LAST_EXIT_CODE",
    "NU_VERSION",
    "OLDPWD",
    // PWD is automatic too. We deliberately KEEP it in the saved file so
    // `persistCwd` can read it via `readPersistedPwd` at the TS layer, but we
    // strip it on load so the spawn cwd remains authoritative.
    "PWD",
]

// Vars omitted from the save side. Two classes:
//   - Pure bloat: `config` is the user's full nushell config (kilobytes per
//     call); `ENV_CONVERSIONS` carries closures we don't want to round-trip.
//   - Nu-automatic vars: same set as NU_AUTO_LOAD_BLOCKED minus PWD, since
//     PWD is intentionally kept on save so `persistCwd` can read it at the
//     TS layer (it gets stripped again on load).
const NU_SAVE_BLOCKED = [
    "ENV_CONVERSIONS",
    "config",
    "FILE_PWD",
    "CURRENT_FILE",
    "PROCESS_PATH",
    "LAST_EXIT_CODE",
    "NU_VERSION",
    "OLDPWD",
]

/**
 * Build the nu script. The shape stays the same regardless of which features
 * are enabled, but each feature contributes a self-contained block:
 *
 *   1. Snapshot server-controlled paths from env vars into local `let`s so
 *      the user pipeline cannot redirect our reads/writes via $env mutation.
 *   2. (persisting) Load the bucket as a record, then `for`-loop each entry
 *      through `load-env` with a per-key `try` — future nu versions that add
 *      new automatic vars fail for that one key, not the whole script.
 *   3. Run the user pipeline. Input (if any) flows in as a single expression:
 *      `$env.NU_MCP_INPUT | from nuon | do --env { ... }`. `do --env` is what
 *      lets `$env` mutations inside the user pipeline reach the save step
 *      below — `do` alone would isolate them.
 *   4. (capture) Save `describe` output and best-effort NUON. Both go through
 *      paths captured in step 1.
 *   5. (persisting) Save `$env` as JSON. The filter is a declarative
 *      pipeline: drop bloat columns, view as a key/value table, `where` rows
 *      that round-trip through JSON, fold back into a record, write. A failed
 *      write emits one stderr line instead of vanishing silently.
 *   6. Re-emit `$__nu_mcp_value` so nu renders the rendered table to stdout.
 *
 * Paths come from env vars rather than being interpolated as nu string
 * literals because (a) nu has first-class env access (`$env.X`) and we should
 * use it, and (b) it eliminates a tiny but real quote-injection surface if
 * `PERSIST_DIR` ever contained an apostrophe.
 */
function buildScript(o: ScriptOptions): string {
    const lines: string[] = []
    const persisting = o.persist !== undefined

    // (1) Snapshot paths into immutable lets at script entry.
    if (persisting) {
        lines.push(`let __nu_mcp_load_path = $env.NU_MCP_PERSIST_LOAD`)
        lines.push(`let __nu_mcp_save_path = $env.NU_MCP_PERSIST_SAVE`)
    }
    if (o.capture) {
        lines.push(`let __nu_mcp_nuon_path = $env.NU_MCP_NUON_PATH`)
        lines.push(`let __nu_mcp_type_path = $env.NU_MCP_TYPE_PATH`)
    }

    // (2) Per-key try-load. `for` propagates env mutations to the outer
    //     scope, unlike `each`/`items` which run in isolated closures.
    if (persisting) {
        const loadReject = NU_AUTO_LOAD_BLOCKED.join(" ")
        lines.push(`let __nu_mcp_persisted = try {`)
        lines.push(`    open --raw $__nu_mcp_load_path | from json | reject --optional ${loadReject}`)
        lines.push(`} catch { {} }`)
        lines.push(`for entry in ($__nu_mcp_persisted | transpose key value) {`)
        lines.push(`    try { load-env { ($entry.key): $entry.value } } catch {}`)
        lines.push(`}`)
    }

    // (3) The user pipeline. Input flows in via a single chained expression.
    const doFlag = persisting ? "do --env" : "do"
    const lead = o.hasInput
        ? `$env.NU_MCP_INPUT | from nuon | ${doFlag} {`
        : `${doFlag} {`
    lines.push(`let __nu_mcp_value = (${lead}`)
    lines.push(o.pipeline)
    lines.push(`})`)

    // (4) Capture. describe always succeeds; nuon can reject closures and a
    //     few other value shapes, hence the try.
    if (o.capture) {
        lines.push(`$__nu_mcp_value | describe | save --force --raw $__nu_mcp_type_path`)
        lines.push(`try { $__nu_mcp_value | to nuon --serialize | save --force --raw $__nu_mcp_nuon_path }`)
    }

    // (5) Save. The pipeline reads as one record-native sentence: drop bloat,
    //     project each entry to a single-key record IF its value round-trips
    //     through JSON (`items` returns `null` for unserializable values like
    //     closures), drop the nulls, merge the singletons back into a record,
    //     write. Compared to the older `transpose | where | reduce` form this
    //     keeps the data in nu's native shape (a record) throughout, and the
    //     filter/project step is one combined operation instead of two.
    //
    //     The outer try keeps a write failure (read-only dir, disk full)
    //     from masking the user's pipeline result; the catch emits a single
    //     stderr line so persistence breakage doesn't vanish silently.
    if (persisting) {
        const saveReject = NU_SAVE_BLOCKED.join(" ")
        lines.push(`try {`)
        lines.push(`    $env`)
        lines.push(`    | reject --optional ${saveReject}`)
        lines.push(`    | items { |k, v| try { $v | to json --raw | ignore; {($k): $v} } catch { null } }`)
        lines.push(`    | where $it != null`)
        lines.push(`    | into record`)
        lines.push(`    | to json --raw`)
        lines.push(`    | save --force --raw $__nu_mcp_save_path`)
        lines.push(`} catch { |e|`)
        lines.push(`    print -e $"[nushell-mcp] persistEnv save failed: ($e.msg)"`)
        lines.push(`}`)
    }

    // (6) Re-emit the value so nu renders its table to stdout (the
    //     human-readable view that complements the NUON capture).
    lines.push(`$__nu_mcp_value`)
    return lines.join("\n") + "\n"
}

// --- Persistence bucket helpers --------------------------------------------

const PERSIST_KEY_RE = /^[A-Za-z0-9_-]+$/

/**
 * Validate and normalize a persist key. Restricted to `[A-Za-z0-9_-]+` so the
 * key can be used as a filename without escaping or directory traversal risk.
 */
function sanitizeKey(key: string | undefined): string {
    const k = key ?? "default"
    if (!PERSIST_KEY_RE.test(k)) {
        throw new Error(
            `persistKey must match ${PERSIST_KEY_RE} (got ${JSON.stringify(k)})`,
        )
    }
    return k
}

function persistPath(key: string): string {
    return join(PERSIST_DIR, `${key}.json`)
}

async function ensurePersistDir(): Promise<void> {
    await mkdir(PERSIST_DIR, { recursive: true })
}

export interface ClearPersistedEnvResult {
    /** The normalized key (defaults to `"default"` when omitted). */
    key: string
    /** True if a persisted file existed and was deleted. */
    existed: boolean
}

/**
 * Delete the persisted env file for a bucket, if any. Idempotent: returns
 * `existed: false` when there was nothing to delete. Throws only on key-shape
 * violations or unexpected filesystem errors.
 */
export async function clearPersistedEnv(
    key?: string,
): Promise<ClearPersistedEnvResult> {
    const k = sanitizeKey(key)
    const path = persistPath(k)
    const file = Bun.file(path)
    const existed = await file.exists()
    if (existed) {
        await unlink(path)
    }
    return { key: k, existed }
}

/**
 * Read `$env.PWD` from a persisted bucket, or `null` if the bucket has no
 * file yet, no PWD, or doesn't parse. Used by `runPipeline` when `persistCwd`
 * is true and the caller did not pass `cwd`.
 */
async function readPersistedPwd(key: string): Promise<string | null> {
    const path = persistPath(key)
    const file = Bun.file(path)
    if (!(await file.exists())) return null
    try {
        const parsed = JSON.parse(await file.text())
        const pwd = parsed?.PWD
        return typeof pwd === "string" ? pwd : null
    } catch {
        return null
    }
}

// --- Bash bridge -----------------------------------------------------------
//
// Runs a user-supplied bash snippet via a probed-once runtime, captures the
// exported environment as a delta against a baseline run, and returns the
// new/changed vars. Spiritual sibling of the `bash-env` nushell module: lets
// a bash-style `export FOO=bar` reach a Nushell pipeline.

/** A bash invocation prefix: argv that, when extended with one script string, runs it. */
interface BashRunner {
    /** argv prefix, e.g. `["wsl.exe", "-e", "/usr/bin/bash", "-c"]`. */
    argv: string[]
    /** Human-readable label of which runner this is. */
    label: string
}

let bashRunnerProbe: Promise<BashRunner | null> | null = null

/** Spawn the candidate runner with `true` to confirm it actually executes. */
async function probeRunner(argv: string[]): Promise<boolean> {
    try {
        const proc = Bun.spawn([...argv, "true"], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        })
        const timer = setTimeout(() => proc.kill(), 5_000)
        await proc.exited
        clearTimeout(timer)
        return proc.exitCode === 0
    } catch {
        return false
    }
}

/**
 * Detect the bash runtime to use for `bashEnv`. Probe order, matching the
 * design choice from the project's notes (WSL first):
 *
 *   1. `NUSHELL_MCP_BASH_PATH` env override. If the basename is `wsl.exe`,
 *      treat it as a WSL invocation; otherwise as a direct bash binary.
 *   2. `wsl.exe -e /usr/bin/bash -c …` (Linux bash through WSL).
 *   3. Git Bash at `C:\\Program Files\\Git\\bin\\bash.exe`.
 *   4. `bash` on PATH.
 *   5. None — return null; callers turn this into an actionable error.
 */
async function detectBashRunner(): Promise<BashRunner | null> {
    const override = process.env.NUSHELL_MCP_BASH_PATH
    if (override) {
        const isWsl = /(^|[\\/])wsl(\.exe)?$/i.test(override)
        const argv = isWsl
            ? [override, "-e", "/usr/bin/bash", "-c"]
            : [override, "-c"]
        if (await probeRunner(argv)) {
            return { argv, label: isWsl ? "wsl (override)" : "bash (override)" }
        }
    }

    const wsl = Bun.which("wsl.exe") ?? "C:\\Windows\\System32\\wsl.exe"
    if (await Bun.file(wsl).exists()) {
        const argv = [wsl, "-e", "/usr/bin/bash", "-c"]
        if (await probeRunner(argv)) return { argv, label: "wsl" }
    }

    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe"
    if (await Bun.file(gitBash).exists()) {
        const argv = [gitBash, "-c"]
        if (await probeRunner(argv)) return { argv, label: "git-bash" }
    }

    const bash = Bun.which("bash")
    if (bash) {
        const argv = [bash, "-c"]
        if (await probeRunner(argv)) return { argv, label: "bash" }
    }

    return null
}

function getBashRunner(): Promise<BashRunner | null> {
    if (!bashRunnerProbe) bashRunnerProbe = detectBashRunner()
    return bashRunnerProbe
}

// Bash- and shell-internal variables that we strip even when they appear to
// have changed across baseline and after runs. These vary with every shell
// invocation (PWD, RANDOM, SECONDS) or carry no user-meaningful payload.
const BASH_INTERNALS = new Set([
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "PS1",
    "PS2",
    "PS4",
    "BASH",
    "BASH_VERSION",
    "BASH_VERSINFO",
    "BASHOPTS",
    "SHELLOPTS",
    "BASH_ENV",
    "BASH_SOURCE",
    "BASH_LINENO",
    "BASH_ARGC",
    "BASH_ARGV",
    "BASH_EXECUTION_STRING",
    "BASH_SUBSHELL",
    "BASH_REMATCH",
    "BASH_COMMAND",
    "FUNCNAME",
    "GROUPS",
    "HISTCMD",
    "HISTFILE",
    "HISTSIZE",
    "HISTFILESIZE",
    "LINENO",
    "MACHTYPE",
    "PIPESTATUS",
    "PPID",
    "RANDOM",
    "SECONDS",
])

/**
 * Sentinel separating any leaked prelude output from the env-0 dump that
 * follows. Has to be unguessable enough that no plausible user-written value
 * happens to contain it — the random suffix is fixed at build time, but it
 * doesn't need to vary per call since we control everything between
 * sentinel emission and stdout capture.
 */
const ENV_SENTINEL = "__NUSHELL_MCP_ENV_BOUNDARY_a7f3e92b__"

/** Parse NUL-separated `KEY=VAL` records from `env -0` output. NUL is the
 * one byte that cannot legally appear inside an env-var value, so this
 * survives values with newlines, equals signs, and other shell metachars
 * that line-based parsing would mangle. */
function parseEnv0(text: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const record of text.split("\0")) {
        if (!record) continue
        const eq = record.indexOf("=")
        if (eq <= 0) continue
        const k = record.slice(0, eq)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue
        result[k] = record.slice(eq + 1)
    }
    return result
}

/**
 * Run one prelude+env-dump cycle through the bash runner and return the
 * resulting env. Prelude stdout is routed to /dev/null so it cannot bleed
 * into our env-var parsing; prelude stderr is preserved and surfaced if the
 * prelude exits non-zero. After the prelude runs (in the *current* shell —
 * curly-brace group, not a subshell — so exports survive), a sentinel is
 * printed, then `env -0` dumps the env. We slice from after the sentinel.
 */
async function dumpEnv(
    runner: BashRunner,
    prelude: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, string>> {
    const composed = prelude
        ? `{ ${prelude}\n} >/dev/null || exit\nprintf '%s\\n' '${ENV_SENTINEL}'\nenv -0`
        : `printf '%s\\n' '${ENV_SENTINEL}'\nenv -0`
    const proc = Bun.spawn([...runner.argv, composed], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    })
    active.add(proc)

    // Race the drain against an explicit timeout promise. We can't rely on
    // `proc.kill()` + drain to short-circuit, because `bash -c "sleep N"`
    // forks `sleep` as a child that keeps the stdout pipe open even after
    // bash itself dies. `Promise.race` lets us throw without waiting for
    // the pipe to drain to EOF, which can otherwise hang for the full
    // child-process lifetime.
    const drain: Promise<[string, string]> = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ])
    // Swallow late drain rejections so they don't surface as
    // unhandled-rejection warnings after a timeout race.
    drain.catch(() => {})

    let timerId: ReturnType<typeof setTimeout> | undefined
    const timeoutErr = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
            try {
                proc.kill("SIGKILL")
            } catch {
                /* already gone */
            }
            reject(
                new Error(`bashEnv prelude timed out after ${timeoutMs}ms`),
            )
        }, timeoutMs)
    })

    try {
        const [stdout, stderr] = await Promise.race([drain, timeoutErr])
        await proc.exited
        if (proc.exitCode !== 0) {
            throw new Error(
                `bashEnv prelude failed (exit ${proc.exitCode}): ${stderr.trim() || "(no stderr)"}`,
            )
        }
        const idx = stdout.indexOf(ENV_SENTINEL)
        if (idx === -1) {
            throw new Error(
                "bashEnv: env sentinel missing from output — bash runtime may not support `env -0` or `printf`",
            )
        }
        // Skip sentinel plus the trailing newline from `printf '%s\n'`.
        const envText = stdout.slice(idx + ENV_SENTINEL.length + 1)
        return parseEnv0(envText)
    } finally {
        if (timerId !== undefined) clearTimeout(timerId)
        active.delete(proc)
    }
}

export interface BashEnvResult {
    /** Vars set or changed by the script, minus shell internals. */
    vars: Record<string, string>
    /** Which runner serviced the call (`"wsl"`, `"git-bash"`, etc.). */
    runner: string
}

/**
 * Run a bash snippet through the detected runtime and return the env-delta
 * (vars whose values are new or different relative to a baseline `env` run).
 *
 * Two subprocesses are spawned per call: one to capture the baseline, one to
 * run the user script and capture the after-state. Spending two spawns is the
 * cost of robustness — WSL in particular injects a non-trivial Linux env that
 * we cannot statically predict.
 */
export interface LoadBashEnvOptions {
    /** Per-call timeout in ms (default `DEFAULT_TIMEOUT_MS`). Applies to each of
     * the two subprocess spawns independently. */
    timeoutMs?: number
}

export async function loadBashEnv(
    script: string,
    opts: LoadBashEnvOptions = {},
): Promise<BashEnvResult> {
    const runner = await getBashRunner()
    if (!runner) {
        throw new Error(
            "No bash runtime found. Set NUSHELL_MCP_BASH_PATH, install WSL, " +
                "install Git Bash, or add bash to PATH.",
        )
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    // Run baseline (no prelude) and after-script in parallel — the baseline
    // has no side effects and the after-script's side effects don't depend on
    // baseline order, so wall-clock cost is roughly one subprocess instead of
    // two.
    const [before, after] = await Promise.all([
        dumpEnv(runner, "", timeoutMs),
        dumpEnv(runner, script, timeoutMs),
    ])

    const vars: Record<string, string> = {}
    for (const [k, v] of Object.entries(after)) {
        if (BASH_INTERNALS.has(k)) continue
        if (before[k] === v) continue
        vars[k] = v
    }
    return { vars, runner: runner.label }
}

// --- Public execution surface ----------------------------------------------

/**
 * Run raw Nushell code via `nu -c`, with no structured-output wrapping. If
 * `opts.input` is provided, the code is wrapped in a minimal `do { }` block
 * that pipes the parsed input as `$in` — preserving raw mode's "no NUON
 * capture" property while still honoring the input parameter.
 */
export async function runRaw(
    code: string,
    opts: RunOptions = {},
): Promise<RawResult> {
    if (opts.input === undefined) {
        return spawnNu(["-c", code], opts)
    }
    // With input we still avoid the NUON/type wrap, but we have to write a
    // tiny script: `nu -c` can't both read NU_MCP_INPUT and accept user code
    // that references `$in` without a wrapper.
    const id = randomBytes(6).toString("hex")
    const scriptPath = join(tmpdir(), `nushell-mcp-${id}.nu`)
    await Bun.write(
        scriptPath,
        `let __nu_mcp_in = ($env.NU_MCP_INPUT | from nuon)\n$__nu_mcp_in | do {\n${code}\n}\n`,
    )
    const env = { ...opts.env, NU_MCP_INPUT: opts.input }
    try {
        return await spawnNu([scriptPath], { ...opts, env })
    } finally {
        await unlink(scriptPath).catch(() => {})
    }
}

export interface PersistOptions {
    /**
     * Capture `$env` after the pipeline and replay it before subsequent calls
     * with the same `persistKey`. Off by default; opt in only when you want
     * cross-call carryover.
     */
    persistEnv?: boolean
    /**
     * Bucket name for `persistEnv`. Defaults to `"default"`. Restricted to
     * `[A-Za-z0-9_-]+` so it can be used as a filename safely.
     */
    persistKey?: string
    /**
     * When `persistEnv` is on, also treat the persisted `$env.PWD` as the
     * call's default cwd (unless the caller passed `cwd` explicitly). Lets
     * `cd foo` survive across calls. Off by default; opt-in.
     */
    persistCwd?: boolean
}

export interface BashBridgeOptions {
    /**
     * Bash script evaluated before the user pipeline runs. Variables it
     * exports (new or changed relative to a baseline `env` snapshot) are
     * merged into nu's env for this call. Runner probe order: WSL, then Git
     * Bash, then `bash` on PATH; override via `NUSHELL_MCP_BASH_PATH`.
     */
    bashEnv?: string
}

export interface CaptureOptions {
    /**
     * Skip NUON/`describe` capture. The pipeline still runs and its value is
     * still rendered to stdout, but the returned `nuon` and `resultType` are
     * `null`. `input`, `persistEnv`, `persistCwd`, and `bashEnv` are still
     * honored — only the post-pipeline value-capture wrap is omitted.
     */
    noCapture?: boolean
}

export interface PipelineOptions
    extends RunOptions,
        PersistOptions,
        BashBridgeOptions,
        CaptureOptions {}

/** Run a Nushell pipeline and recover its final value as NUON. */
export async function runPipeline(
    pipeline: string,
    opts: PipelineOptions = {},
): Promise<PipelineResult> {
    const id = randomBytes(6).toString("hex")
    const scriptPath = join(tmpdir(), `nushell-mcp-${id}.nu`)
    const nuonPath = join(tmpdir(), `nushell-mcp-${id}.nuon`)
    const typePath = join(tmpdir(), `nushell-mcp-${id}.type`)
    const hasInput = opts.input !== undefined
    // nu reads forward-slash paths fine on Windows; embedding backslashes in
    // the single-quoted nu string literal would risk escape-sequence surprises.
    const fwd = (p: string) => p.replaceAll("\\", "/")

    // --- Persistence setup ------------------------------------------------
    let persistLoadPath: string | undefined
    let persistSavePath: string | undefined
    let effectiveCwd = opts.cwd
    if (opts.persistEnv) {
        await ensurePersistDir()
        const key = sanitizeKey(opts.persistKey)
        const path = persistPath(key)
        persistLoadPath = path
        persistSavePath = path
        if (opts.persistCwd && !opts.cwd) {
            const pwd = await readPersistedPwd(key)
            if (pwd) effectiveCwd = pwd
        }
    }

    // --- Bash bridge ------------------------------------------------------
    let bridgeEnv: Record<string, string> = {}
    if (opts.bashEnv !== undefined && opts.bashEnv.length > 0) {
        const result = await loadBashEnv(opts.bashEnv, {
            timeoutMs: opts.timeoutMs,
        })
        bridgeEnv = result.vars
    }

    // --- Compose & write script ------------------------------------------
    const capture = opts.noCapture
        ? undefined
        : { nuonPath: fwd(nuonPath), typePath: fwd(typePath) }
    await Bun.write(
        scriptPath,
        buildScript({
            pipeline,
            hasInput,
            capture,
            persist: opts.persistEnv
                ? {
                      loadPath: fwd(persistLoadPath!),
                      savePath: fwd(persistSavePath!),
                  }
                : undefined,
        }),
    )

    // Layer env vars from least to most authoritative:
    //   bashEnv-captured  →  caller's explicit env  →  server-controlled.
    // Server-controlled vars come last so the user pipeline cannot redirect
    // our reads/writes by exporting a same-named var. They're snapshotted
    // into local `let` bindings inside the script too (see buildScript step
    // 1), so even mid-pipeline $env mutation can't break them.
    const env: Record<string, string> = {
        ...bridgeEnv,
        ...(opts.env ?? {}),
    }
    if (hasInput) env.NU_MCP_INPUT = opts.input!
    if (opts.persistEnv) {
        env.NU_MCP_PERSIST_LOAD = fwd(persistLoadPath!)
        env.NU_MCP_PERSIST_SAVE = fwd(persistSavePath!)
    }
    if (capture) {
        env.NU_MCP_NUON_PATH = capture.nuonPath
        env.NU_MCP_TYPE_PATH = capture.typePath
    }

    try {
        const raw = await spawnNu([scriptPath], {
            cwd: effectiveCwd,
            env,
            cleanEnv: opts.cleanEnv,
            timeoutMs: opts.timeoutMs,
        })
        const [nuon, resultType] = await Promise.all([
            readIfExists(nuonPath),
            readIfExists(typePath),
        ])
        return {
            ...raw,
            nuon: nuon?.replace(/\s+$/, "") ?? null,
            resultType: resultType?.trim() ?? null,
        }
    } finally {
        await Promise.allSettled([
            unlink(scriptPath),
            unlink(nuonPath),
            unlink(typePath),
        ])
    }
}

/** Terminate every nu process this server currently has in flight. */
export function killAll(): number {
    let killed = 0
    for (const proc of active) {
        proc.kill()
        killed++
    }
    return killed
}

// --- Installed-version detection -------------------------------------------

let nuVersionPromise: Promise<string> | null = null

/**
 * The version string of the installed `nu`, detected at runtime and memoized.
 * Nothing in this server hardcodes a Nushell version — documentation and
 * execution always reflect whatever `nu` is actually on the machine.
 */
export function getNuVersion(): Promise<string> {
    if (!nuVersionPromise) {
        nuVersionPromise = runRaw("version | get version", { timeoutMs: 10_000 })
            .then(r => (r.exitCode === 0 ? r.stdout.trim() : "unknown"))
            .catch(() => "unknown")
    }
    return nuVersionPromise
}

// --- Documentation queries -------------------------------------------------
//
// Both queries source their content from nushell's built-in `help`/`scope`
// system rather than the online docs corpus, so the results always match the
// installed `nu`. See README "Documentation source" for the rationale. User
// input is passed via environment variables, never interpolated into nu
// source, so the nu code below is a fixed constant with no injection surface.

export interface DocMatch {
    name: string
    category: string | null
    command_type: string | null
    description: string | null
}

// The query is tokenized on whitespace; a command scores one point per token
// that appears in its name, description, or search terms (OR semantics). This
// keeps recall high for multi-word queries — "parse json" still surfaces both
// `parse` and `from json` — while `sort-by score` floats fuller matches up.
const SEARCH_NU = `
let q = $env.NU_MCP_QUERY
let cat = $env.NU_MCP_CATEGORY
let lim = ($env.NU_MCP_LIMIT | into int)
let terms = ($q | str downcase | split row ' ' | where ($it | is-not-empty))
let base = (help commands | select name category command_type description search_terms)
let scored = ($base | each {|row|
    let hay = ([$row.name ($row.description | default '') ($row.search_terms | default '')] | str join ' ' | str downcase)
    let score = ($terms | where {|t| $hay | str contains $t } | length)
    $row | insert score $score
} | where score > 0 | sort-by score --reverse)
let filtered = (if ($cat | is-empty) { $scored } else { $scored | where category == $cat })
$filtered | select name category command_type description | first $lim | to json --raw
`

export interface SearchDocsOptions {
    category?: string
    limit?: number
}

export interface SearchDocsResult {
    count: number
    matches: DocMatch[]
    /** The installed Nushell version these results were drawn from. */
    nushellVersion: string
}

/** Search every installed command by name, description, and search terms. */
export async function searchDocs(
    query: string,
    opts: SearchDocsOptions = {},
): Promise<SearchDocsResult> {
    const limit = opts.limit ?? 50
    const [raw, nushellVersion] = await Promise.all([
        runRaw(SEARCH_NU, {
            timeoutMs: 15_000,
            env: {
                NU_MCP_QUERY: query,
                NU_MCP_CATEGORY: opts.category ?? "",
                NU_MCP_LIMIT: String(limit),
            },
        }),
        getNuVersion(),
    ])
    if (raw.exitCode !== 0) {
        throw new Error(raw.stderr.trim() || "nu documentation search failed")
    }
    const matches = JSON.parse(raw.stdout.trim() || "[]") as DocMatch[]
    return { count: matches.length, matches, nushellVersion }
}

const COMMAND_NU = `
let n = $env.NU_MCP_NAME
let matches = (scope commands | where name == $n)
let info = (if ($matches | is-empty) { null } else {
    $matches | first | select name category description signatures examples search_terms extra_description
})
let help_text = (try { help $n } catch { $"No help text available for: ($n)" })
{ found: (not ($matches | is-empty)), help: $help_text, info: $info } | to json --raw
`

export interface CommandDoc {
    found: boolean
    /** The formatted `help <name>` text: usage, flags, parameters, examples. */
    help: string
    /** Structured command metadata (signatures, examples), or `null` if unknown. */
    info: unknown
    /** The installed Nushell version this help was drawn from. */
    nushellVersion: string
    /** When the command was not found, the closest matching command names. */
    suggestions?: string[]
}

/**
 * Find command names close to a query that isn't an exact command. Matching
 * is separator-insensitive so a jammed-together guess like "strjoin" still
 * finds "str join", and falls back to a shared-prefix score for typos.
 */
async function suggestCommands(query: string): Promise<string[]> {
    const raw = await runRaw("help commands | get name | to json --raw", {
        timeoutMs: 15_000,
    })
    if (raw.exitCode !== 0) return []
    const names = JSON.parse(raw.stdout.trim() || "[]") as string[]
    const flatten = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "")
    const q = flatten(query)

    return names
        .map(name => {
            const flat = flatten(name)
            let score = 0
            if (flat === q) score = 100
            else if (flat.includes(q) || q.includes(flat)) score = 50
            else {
                let prefix = 0
                while (
                    prefix < flat.length &&
                    prefix < q.length &&
                    flat[prefix] === q[prefix]
                )
                    prefix++
                score = prefix >= 3 ? prefix : 0
            }
            return { name, score }
        })
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(entry => entry.name)
}

/** Fetch full help for one command: formatted text plus structured metadata. */
export async function getCommandDoc(name: string): Promise<CommandDoc> {
    const [raw, nushellVersion] = await Promise.all([
        runRaw(COMMAND_NU, { timeoutMs: 15_000, env: { NU_MCP_NAME: name } }),
        getNuVersion(),
    ])
    if (raw.exitCode !== 0) {
        throw new Error(raw.stderr.trim() || "nu documentation lookup failed")
    }
    const doc = JSON.parse(raw.stdout.trim()) as Omit<
        CommandDoc,
        "nushellVersion" | "suggestions"
    >
    // On a miss, point the model at near matches instead of a dead end.
    const suggestions = doc.found ? undefined : await suggestCommands(name)
    return { ...doc, nushellVersion, suggestions }
}
