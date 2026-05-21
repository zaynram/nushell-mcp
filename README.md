# Terminal MCP

A Model Context Protocol server that provides programmatic access to the terminal. This server enables AI models to interact with the Windows command line interface through a set of standardized tools.

## Features

- **Write to Terminal**: Execute commands or write text to the Windows terminal
- **Read Terminal Output**: Retrieve output from previously executed commands
- **Send Control Characters**: Send control signals (e.g., Ctrl+C) to the terminal
- **Windows-Native**: Built specifically for Windows command line interaction

## Installation

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/zaynram/terminal-mcp.git
   cd terminal-mcp
   ```

2. **Install Dependencies**:
   ```bash
   bun install
   ```

3. **Build the Project**:
   ```bash
   bun run build
   ```

4. **Configure Claude Desktop**:

Add the server config to `%APPDATA%/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "github.com/capecoma/terminal-mcp": {
      "command": "bun",
      "args": ["path/to/build/index.js"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```


## License

MIT License - see [LICENSE](LICENSE) file.
