/**
 * Nushell subprocess layer.
 *
 * Every capability the server exposes ultimately runs the `nu` binary in a
 * fresh, one-shot process (see README "Session model" for why one-shot). This
 * module owns process spawning, timeout/cancellation, version detection, and
 * the documentation queries; `index.ts` only wires these functions to MCP
 * tools.
 */
import { randomBytes } from "node:crypto"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Absolute path to the `nu` executable. Override with `NUSHELL_MCP_NU_PATH`. */
export const NU_PATH: string =
    process.env.NUSHELL_MCP_NU_PATH ?? Bun.which("nu") ?? "nu"

/** Default per-call timeout in ms. Override with `NUSHELL_MCP_TIMEOUT_MS`. */
export const DEFAULT_TIMEOUT_MS: number = Number(
    process.env.NUSHELL_MCP_TIMEOUT_MS ?? 30_000,
)

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

/** Run raw Nushell code via `nu -c`, with no structured-output wrapping. */
export function runRaw(code: string, opts: RunOptions = {}): Promise<RawResult> {
    return spawnNu(["-c", code], opts)
}

/** Read a temp file's text, or `null` if `nu` never created it. */
async function readIfExists(path: string): Promise<string | null> {
    const file = Bun.file(path)
    return (await file.exists()) ? file.text() : null
}

export interface PipelineOptions extends RunOptions {
    /**
     * A value to feed into the pipeline as `$in`, given as NUON or JSON text
     * (`from nuon` accepts both). Lets the model transform data it already
     * holds without embedding it as a literal.
     */
    input?: string
}

/**
 * Wrap a user pipeline so a single `nu` invocation yields THREE things:
 *   - a rendered table on stdout (human-readable),
 *   - the final value as NUON in `<nuonPath>` (machine-readable, concise),
 *   - the value's `describe` type in `<typePath>`.
 *
 * The pipeline runs inside `do { }` for its own scope; when `input` is given
 * it is parsed with `from nuon` and piped in as `$in`. `describe` always
 * succeeds, so the type file is always written; `to nuon --serialize` is
 * wrapped in `try` as a last-resort guard.
 */
const wrap = (
    pipeline: string,
    nuonPath: string,
    typePath: string,
    hasInput: boolean,
): string => {
    const prelude = hasInput
        ? `let __nu_mcp_in = ($env.NU_MCP_INPUT | from nuon)\n`
        : ""
    const subject = hasInput ? "$__nu_mcp_in | do {" : "do {"
    return (
        prelude +
        `let __nu_mcp_value = (${subject}\n${pipeline}\n})\n` +
        `$__nu_mcp_value | describe | save --force --raw '${typePath}'\n` +
        `try { $__nu_mcp_value | to nuon --serialize | save --force --raw '${nuonPath}' }\n` +
        `$__nu_mcp_value\n`
    )
}

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

    await Bun.write(
        scriptPath,
        wrap(pipeline, fwd(nuonPath), fwd(typePath), hasInput),
    )
    const env = hasInput
        ? { ...opts.env, NU_MCP_INPUT: opts.input as string }
        : opts.env
    try {
        const raw = await spawnNu([scriptPath], { ...opts, env })
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
