/**
 * Nushell subprocess layer.
 *
 * Every capability the server exposes ultimately runs the `nu` binary in a
 * fresh, one-shot process (see README "Session model" for why one-shot). This
 * module owns process spawning, timeout/cancellation, version detection, the
 * documentation queries, and the bash environment bridge. Cross-call session
 * state lives in the REPL pool (`nuMcpPool.ts`), not here. `index.ts` only
 * wires these functions to MCP tools.
 */
import { randomBytes } from "node:crypto"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    active,
    addActive,
    removeActive,
} from "./active.js"
import {
    type ListCommandEntry,
    getNuMcpClient,
    parseListCommandsOutput,
} from "./nuMcpClient.js"
import { getReplPool } from "./nuMcpPool.js"

/** Absolute path to the `nu` executable. Override with `NUSHELL_MCP_NU_PATH`. */
export const NU_PATH: string =
    process.env.NUSHELL_MCP_NU_PATH ?? Bun.which("nu") ?? "nu"

/** Default per-call timeout in ms. Override with `NUSHELL_MCP_TIMEOUT_MS`. */
export const DEFAULT_TIMEOUT_MS: number = Number(
    process.env.NUSHELL_MCP_TIMEOUT_MS ?? 30_000,
)

// Re-export from active.ts so existing imports from nu.ts continue to work.
export type { ActiveRole } from "./active.js"

/**
 * Test-only accessor exposing the role tags of currently-tracked
 * subprocesses. Underscore prefix flags this as not part of the stable
 * surface — consumers outside tests should use `killAll` / `abortExec`.
 * Re-exported from `active.ts` to avoid breaking existing test imports.
 */
export { _getActiveRoles } from "./active.js"

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
    /**
     * Label of the bash runner used for `bashEnv` (e.g. `"wsl"`,
     * `"git-bash"`, `"bash"`, `"bash (override)"`). `undefined` when no
     * `bashEnv` was provided for this call.
     */
    bashRunner?: string
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
    addActive(proc, "exec")

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
        removeActive(proc)
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
}

/**
 * Build the nu script for one-shot pipeline execution. Two optional features:
 *
 *   1. Snapshot capture paths into immutable `let`s so the user pipeline
 *      cannot redirect our reads/writes via $env mutation.
 *   2. Run the user pipeline inside `do { }`. Input (if any) flows in as
 *      `$env.NU_MCP_INPUT | from nuon | do { ... }`.
 *   3. (capture) Save `describe` output and best-effort NUON via the
 *      snapshotted paths.
 *   4. Re-emit `$__nu_mcp_value` so nu renders the table to stdout.
 *
 * Paths come from env vars rather than nu string literals because (a) nu has
 * first-class env access (`$env.X`) and (b) it eliminates a quote-injection
 * surface if a temp path ever contained an apostrophe.
 */
function buildScript(o: ScriptOptions): string {
    const lines: string[] = []

    if (o.capture) {
        lines.push(`let __nu_mcp_nuon_path = $env.NU_MCP_NUON_PATH`)
        lines.push(`let __nu_mcp_type_path = $env.NU_MCP_TYPE_PATH`)
    }

    const lead = o.hasInput
        ? `$env.NU_MCP_INPUT | from nuon | do {`
        : `do {`
    lines.push(`let __nu_mcp_value = (${lead}`)
    lines.push(o.pipeline)
    lines.push(`})`)

    if (o.capture) {
        lines.push(`$__nu_mcp_value | describe | save --force --raw $__nu_mcp_type_path`)
        lines.push(`try { $__nu_mcp_value | to nuon --serialize | save --force --raw $__nu_mcp_nuon_path }`)
    }

    lines.push(`$__nu_mcp_value`)
    return lines.join("\n") + "\n"
}

// --- Bucket key validation -------------------------------------------------

const BUCKET_KEY_RE = /^[A-Za-z0-9_-]+$/

/**
 * Validate and normalize a REPL bucket key. Restricted to `[A-Za-z0-9_-]+` so
 * the key is a safe identifier wherever buckets are addressed by name.
 * Exported for `NuMcpPool` and the `nu_repl_*` tool registrations.
 */
export function sanitizeKey(key: string | undefined): string {
    const k = key ?? "default"
    if (!BUCKET_KEY_RE.test(k)) {
        throw new Error(
            `bucket key must match ${BUCKET_KEY_RE} (got ${JSON.stringify(k)})`,
        )
    }
    return k
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
        // The user explicitly opted in to this path — don't silently fall
        // through to auto-detection. A misconfigured override should be
        // loud, not hidden behind a working fallback runner.
        throw new Error(
            `NUSHELL_MCP_BASH_PATH=${override} did not pass probe — runner unusable. ` +
            `Restart the nushell-mcp server after unsetting or correcting the env var ` +
            `(the probe is memoized for the lifetime of the server process). ` +
            `Without an override, auto-detection tries WSL → Git Bash → bash on PATH.`,
        )
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

/**
 * Test-only: clear the memoized bash-runner probe so the next call to
 * `getBashRunner()` re-runs detection with the current environment.
 * Underscore prefix flags this as outside the stable surface — only
 * tests should call it.
 */
export function _resetBashRunnerProbe(): void {
    bashRunnerProbe = null
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
    addActive(proc, "bash")

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
        removeActive(proc)
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
     * `null`. `input` and `bashEnv` are still honored — only the
     * post-pipeline value-capture wrap is omitted.
     */
    noCapture?: boolean
}

export interface PipelineOptions
    extends RunOptions,
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

    // --- Bash bridge ------------------------------------------------------
    let bridgeEnv: Record<string, string> = {}
    let bashRunner: string | undefined
    if (opts.bashEnv !== undefined && opts.bashEnv.length > 0) {
        const result = await loadBashEnv(opts.bashEnv, {
            timeoutMs: opts.timeoutMs,
        })
        bridgeEnv = result.vars
        bashRunner = result.runner
    }

    // --- Compose & write script ------------------------------------------
    const capture = opts.noCapture
        ? undefined
        : { nuonPath: fwd(nuonPath), typePath: fwd(typePath) }
    await Bun.write(
        scriptPath,
        buildScript({ pipeline, hasInput, capture }),
    )

    // Layer env vars from least to most authoritative:
    //   bashEnv-captured  →  caller's explicit env  →  server-controlled.
    // Server-controlled capture-paths come last and are snapshotted into
    // local `let` bindings inside the script (see buildScript), so
    // mid-pipeline $env mutation can't redirect them.
    const env: Record<string, string> = {
        ...bridgeEnv,
        ...(opts.env ?? {}),
    }
    if (hasInput) env.NU_MCP_INPUT = opts.input!
    if (capture) {
        env.NU_MCP_NUON_PATH = capture.nuonPath
        env.NU_MCP_TYPE_PATH = capture.typePath
    }

    try {
        const raw = await spawnNu([scriptPath], {
            cwd: opts.cwd,
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
            bashRunner,
        }
    } finally {
        await Promise.allSettled([
            unlink(scriptPath),
            unlink(nuonPath),
            unlink(typePath),
        ])
    }
}

/**
 * Abort only in-flight `nu_exec` (exec-role) subprocesses. Leaves REPL
 * pool children and the doc singleton alone — those are persistent state
 * the caller would not expect a "cancel my pipeline" button to nuke.
 *
 * Plan B Cycle 12.
 */
export function abortExec(): number {
    let aborted = 0
    for (const [proc, role] of active) {
        // Kill both "exec" (nu pipelines) and "bash" (bashEnv runner) — a
        // nu_exec call with a bashEnv snippet can be blocked in the bash
        // pre-step, and the user invoking nu_exec_abort expects everything
        // related to in-flight nu_exec to die (Copilot 3295712499 /
        // 3295712510 — was previously only killing "exec", diverging from
        // the documented semantics in active.ts).
        if (role !== "exec" && role !== "bash") continue
        try {
            proc.kill()
        } catch {
            // Already gone — fine.
        }
        removeActive(proc)
        aborted++
    }
    return aborted
}

/** Terminate every nu process this server currently has in flight. */
export function killAll(): number {
    let killed = 0
    // Kill the doc singleton (Plan A). NuMcpChild.kill() removes it from
    // `active` so the tail-loop below won't double-count it.
    const docClient = getNuMcpClient()
    if (docClient.isAlive()) {
        docClient.kill()
        killed++
    }
    // Nuke the REPL pool (Plan B). Each NuMcpChild.kill() inside nukeAll()
    // removes the child from `active`, so the tail-loop won't double-count.
    killed += getReplPool().nukeAll()
    // Any remaining entries in `active` are ephemeral exec/bash procs
    // (NuMcpChild instances self-remove via their own kill() path).
    for (const [proc] of active) {
        try {
            proc.kill()
        } catch {
            // Already gone — fine.
        }
        // Route through removeActive — `active.ts` is the single mutator of
        // the role-tagged registry, and this loop ran an inline
        // `active.delete(proc)` that drifted away from that invariant
        // (Copilot 3296946777).
        removeActive(proc)
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
// Both queries route through the process-wide `nu --mcp` singleton via
// `getNuMcpClient().callTool("list_commands", ...)` / `callTool("command_help",
// ...)`. There are no embedded nu scripts in this section — all query
// parameters are passed as JSON-RPC arguments, not interpolated into nu source.

export interface SearchDocsOptions {
    limit?: number
}

export type SearchDocsResult =
    | { kind: "commands"; commands: ListCommandEntry[] }
    | { kind: "help"; help: string }

const SEARCH_HELP_TEXT =
    "nu_doc_search(query?, limit?)\n" +
    "\n" +
    "  query   Substring matched against command names, descriptions,\n" +
    '          and search terms. Omit (or pass "") to see this help.\n' +
    '          Pass "*" to list every available command.\n' +
    "  limit   Maximum results to return (default 50).\n"

/**
 * Search the installed Nushell command set via the singleton's `list_commands`
 * tool. Scope is everything `nu --mcp` can see: native commands, loaded
 * plugins, aliases, and custom defs.
 *
 *   - `query` omitted / empty → returns a usage help string; no JSON-RPC call.
 *   - `query === "*"`         → `list_commands` with no `find` arg (all commands).
 *   - any other string        → `list_commands({find: query})`.
 *
 * Results are sliced to `limit` (default 50). See Plan A §3 / §4.2.
 */
export async function searchDocs(
    query?: string,
    opts: SearchDocsOptions = {},
): Promise<SearchDocsResult> {
    if (query === undefined || query === null || query === "") {
        return { kind: "help", help: SEARCH_HELP_TEXT }
    }
    const limit = opts.limit ?? 50
    const client = getNuMcpClient()
    const args = query === "*" ? {} : { find: query }
    const response = await client.callTool("list_commands", args)
    if (response.isError) {
        // nu --mcp's `list_commands` returns isError=true with this text
        // when no commands match — that's a valid empty result for callers,
        // not a real failure. Anything else IS a failure to surface.
        if (response.errorText.includes("No matching commands found")) {
            return { kind: "commands", commands: [] }
        }
        throw new Error(`list_commands failed: ${response.errorText}`)
    }
    const entries = parseListCommandsOutput(response.text)
    return { kind: "commands", commands: entries.slice(0, limit) }
}

export interface CommandDoc {
    found: boolean
    /** The formatted help text from upstream's `command_help` tool. */
    help: string
    /** When the command was not found, the closest matching command names. */
    suggestions?: string[]
}

/**
 * Fuzzy-score `query` against a list of command names; return up to 5 names
 * sorted by closeness. Matching is separator-insensitive so a jammed-together
 * guess like "strjoin" still finds "str join", with a shared-prefix tiebreak
 * for typos.
 */
function fuzzyScoreNames(query: string, names: string[]): string[] {
    const flatten = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "")
    const q = flatten(query)
    return names
        .map((name) => {
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
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((entry) => entry.name)
}

/**
 * Find command names close to a misspelled query by fetching the full command
 * list via `list_commands({})` and scoring client-side. Best-effort: returns
 * an empty array if the singleton call fails for any reason — we don't want
 * a suggestion lookup to mask the original "command not found" signal.
 */
async function suggestCommands(query: string): Promise<string[]> {
    try {
        const client = getNuMcpClient()
        const response = await client.callTool("list_commands", {})
        if (response.isError) return []
        const entries = parseListCommandsOutput(response.text)
        return fuzzyScoreNames(query, entries.map((e) => e.name))
    } catch {
        return []
    }
}

/**
 * Fetch full help for one command via upstream's `command_help` tool. On a
 * miss, generates near-match suggestions client-side from `list_commands` so
 * the model can self-correct instead of getting a dead-end error.
 */
export async function getCommandDoc(name: string): Promise<CommandDoc> {
    const client = getNuMcpClient()
    const response = await client.callTool("command_help", { name })
    if (response.isError) {
        const suggestions = await suggestCommands(name)
        return { found: false, help: response.errorText, suggestions }
    }
    return { found: true, help: response.text }
}
