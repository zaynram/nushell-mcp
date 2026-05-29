import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface NuMcpVars {
    NU_PATH: string
    CONFIG_PATH: string
    TIMEOUT_MS: number
}

const vars = {
    NU_PATH: process.env.NUSHELL_MCP_NU_PATH ?? Bun.which('nu') ?? 'nu',
    CONFIG_PATH:
        process.env.NUSHELL_MCP_CONFIG_PATH ??
        [
            join(import.meta.dir, '..', 'config', 'config.nu'),
            join(import.meta.dir, 'config.nu'),
        ].find(existsSync),
    TIMEOUT_MS: Number.parseInt(process.env.NUSHELL_MCP_TIMEOUT_MS ?? '30000'),
}

if (!vars.CONFIG_PATH)
    throw Error(`Unable to resolve configuration path (config.nu)`)

export default vars as NuMcpVars
