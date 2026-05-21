#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from "@modelcontextprotocol/sdk/types.js"

interface CommandArguments {
    text: string[]
    cwd?: string
    env?: Record<string, string>
    cleanEnv?: boolean
    timeoutMs?: number
    [key: string]: unknown
}

const isWin: boolean = process.platform === "win32"
const defaultShell = {
    win32:
        Bun.which("pwsh.exe") ??
        Bun.which("powershell.exe") ??
        Bun.which("cmd.exe") ??
        "cmd.exe",
    linux: Bun.which("bash.exe") ?? "bash.exe",
}

const DEFAULT_TIMEOUT_MS = Number(process.env.TERMINAL_MCP_TIMEOUT_MS ?? 30_000)

// Resolved once at startup. `exit` terminates the session in every shell the
// table above can yield (pwsh, powershell, cmd, bash), which is what lets each
// tool call run one-shot instead of deadlocking on a shell that never dies.

const shellPath: string =
    process.env.TERMINAL_MCP_SHELL_PATH ??
    (isWin ? defaultShell.win32 : defaultShell.linux)

class TerminalServer {
    private mcp: McpServer

    // The low-level protocol server backing the McpServer. We register raw
    // request handlers on it directly rather than using McpServer's tool API.
    private get server() {
        return this.mcp.server
    }

    // Subprocesses currently in flight. Used so kill_processes / SIGINT can
    // terminate work this server spawned -- nothing else on the machine.
    private active = new Set<Bun.Subprocess>()

    constructor() {
        this.mcp = new McpServer(
            { name: "winterm-mcp", version: "1.0.0" },
            { capabilities: { tools: {} } },
        )
        this.server.onerror = err => console.error("[MCP Error]", err)
        this.setupToolHandlers()

        process.on("SIGINT", async () => {
            await this.cleanup()
            process.exit(0)
        })
    }

    /**
     * Run one batch of commands in a fresh shell and return its output.
     *
     * The shell is interactive (so a real PTY is attached and programs see
     * isTTY = true), but we append an `exit` line so it terminates as soon as
     * the command(s) finish -- this is what makes each call "one-shot" and
     * lets us simply `await proc.exited` instead of deadlocking on a shell
     * that would otherwise live forever.
     */
    private async runCommand(args: CommandArguments) {
        const lines = Array.isArray(args.text) ? args.text : [args.text]
        if (lines.length === 0)
            throw new McpError(
                ErrorCode.InvalidParams,
                "`text` must not be empty",
            )

        const env = args.cleanEnv ? args.env : { ...process.env, ...args.env }
        const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS

        // Per-call output buffer -- no shared state, so concurrent tool calls
        // can never interleave each other's output.
        const decoder = new TextDecoder()
        let output = ""
        let resolveEof: () => void
        const ptyEof = new Promise<void>(resolve => {
            resolveEof = resolve
        })

        const terminal = new Bun.Terminal({
            data: (_term, data) => {
                output += decoder.decode(data, { stream: true })
            },
            // PTY stream closed (EOF) -- all output has now been delivered.
            exit: () => resolveEof(),
        })

        const proc = Bun.spawn([shellPath], {
            terminal,
            cwd: args.cwd,
            env,
        })
        this.active.add(proc)

        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true
            proc.kill()
        }, timeoutMs)

        try {
            terminal.write(lines.join("\n") + "\nexit\n")
            await proc.exited
            // Give the PTY a moment to flush any trailing bytes after exit.
            await Promise.race([ptyEof, Bun.sleep(200)])
            output += decoder.decode()

            const code = proc.exitCode
            const trailer = timedOut
                ? `\n[timed out after ${timeoutMs}ms -- process killed]`
                : code !== 0 && code !== null
                  ? `\n[exit code ${code}]`
                  : ""

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            (output || "(command produced no output)") +
                            trailer,
                    },
                ],
                isError: timedOut || (code !== 0 && code !== null),
            }
        } finally {
            clearTimeout(timer)
            this.active.delete(proc)
            terminal.close()
        }
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "run_terminal_command",
                    description:
                        `Run one or more commands in a fresh ${shellPath} ` +
                        "shell and return its output. Each call uses a brand-new " +
                        "shell that exits when the commands finish.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            text: {
                                type: "array",
                                description:
                                    "Command lines to run, in order, in the shell.",
                                items: { type: "string" },
                            },
                            cwd: {
                                type: "string",
                                description:
                                    "Working directory to spawn the shell in.",
                            },
                            env: {
                                type: "object",
                                description:
                                    "Additional environment variables for this command.",
                                additionalProperties: { type: "string" },
                            },
                            cleanEnv: {
                                type: "boolean",
                                description:
                                    "Do not merge the server's environment; use only `env`.",
                                default: false,
                            },
                            timeoutMs: {
                                type: "number",
                                description: `Kill the command after this many milliseconds (default ${DEFAULT_TIMEOUT_MS}).`,
                            },
                        },
                        required: ["text"],
                    },
                },
                {
                    name: "kill_processes",
                    description:
                        "Terminate all commands this server currently has running.",
                    inputSchema: {
                        type: "object",
                        properties: {},
                    },
                },
            ],
        }))

        this.server.setRequestHandler(CallToolRequestSchema, async request => {
            switch (request.params.name) {
                case "run_terminal_command":
                    return await this.runCommand(
                        (request.params.arguments ?? {}) as CommandArguments,
                    )

                case "kill_processes": {
                    let killed = 0
                    for (const proc of this.active) {
                        proc.kill()
                        killed++
                    }
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `terminated ${killed} running command(s)`,
                            },
                        ],
                    }
                }

                default:
                    throw new McpError(
                        ErrorCode.MethodNotFound,
                        `unknown tool: ${request.params.name}`,
                    )
            }
        })
    }

    private async cleanup() {
        for (const proc of this.active) proc.kill()
        this.active.clear()
        await this.server.close()
    }

    async run() {
        const transport = new StdioServerTransport()
        await this.server.connect(transport)
        console.error(`winterm-mcp running on stdio (shell: ${shellPath})`)
    }
}

const server = new TerminalServer()
server.run().catch(console.error)
