# Development Setup

## Prerequisites

- **Node.js** >= 22
- **PixInsight** >= 1.9.4 (this fork targets the V8 PJSR runtime; see
  [the port notes](pixinsight-1.9.4-v8-port.md))
- **Claude Desktop** or **Claude Code** (for testing the MCP server)
- **macOS** (primary development platform; Linux/Windows adaptations noted where different)

## PixInsight Path

Default installation paths:

| OS | Path |
|---|---|
| macOS | `/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight` |
| Linux | `/opt/PixInsight/bin/PixInsight` (typical) |
| Windows | `C:\Program Files\PixInsight\bin\PixInsight.exe` |

## Project Setup

```bash
# Clone
git clone https://github.com/aescaffre/pixinsight-mcp.git
cd pixinsight-mcp

# Install dependencies
npm install

# Create the bridge directories
npm run setup-bridge
```

## Running PixInsight in Automation Mode

```bash
# macOS
/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight \
  -n --automation-mode

# With a slot number (for IPC)
/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight \
  -n=1 --automation-mode
```

## Starting PixInsight and the watcher

One command does the whole thing — it starts PixInsight in automation mode,
loads the watcher, and waits until the watcher actually answers:

```bash
npm run launch          # node scripts/pi-launch.mjs
npm run launch -- --restart
npm run launch -- --windowed    # show the UI; see the warning below
```

Automation mode is the default for a reason. In windowed mode a PJSR error
opens a modal dialog that nothing on the Node side can dismiss: PixInsight sits
at 0% CPU looking healthy while every bridge call times out with no explanation.
Use `--windowed` only when you want to watch the processing happen.

You rarely need to run this by hand. The MCP server starts PixInsight itself
when nothing is listening.

Check the state at any time:

```bash
npm run doctor          # install, modules, bridge, watcher, live round trip
```

## Configuring an MCP client

The server is `agents/mcp/server.mjs`. There is no build step — it runs from
source.

Claude Code:

```bash
claude mcp add pixinsight node /absolute/path/to/pixinsight-mcp/agents/mcp/server.mjs
```

Claude Desktop, in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pixinsight": {
      "command": "node",
      "args": ["/absolute/path/to/pixinsight-mcp/agents/mcp/server.mjs"]
    }
  }
}
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--target "M81"` | Classify the target up front, so quality-gate thresholds match its type |
| `--tools SET` | Serve one agent's tool set instead of all of them |
| `--no-auto-launch` | Fail rather than starting PixInsight; you start it yourself |

The server refuses to start when PixInsight or an XTerminator module is missing,
rather than serving tools that cannot work. Once running, `pixinsight_status`
reports the backend state and how to recover from it.

## Testing the Bridge Manually

You can test the file bridge without the MCP server:

### Write a test command:
```bash
cat > ~/.pixinsight-mcp/bridge/commands/test.json << 'EOF'
{
  "id": "test-001",
  "timestamp": "2025-01-01T00:00:00Z",
  "tool": "list_open_images",
  "process": "__internal__",
  "parameters": {}
}
EOF
```

### Check for result:
```bash
# Wait a moment for the watcher to process it
sleep 1
cat ~/.pixinsight-mcp/bridge/results/test-001.json
```

## Troubleshooting

### MCP server not connecting
- Run `npm run doctor` first; the server refuses to start on the same problems.
- Check Claude Desktop logs: `~/Library/Logs/Claude/`
- Ensure `node` is in PATH, or use an absolute path in the config.

### Watcher not picking up commands
- `npm run doctor` separates the cases: PixInsight not running, watcher never
  loaded, watcher busy inside a long process.
- A watcher that never loaded is almost always a PJSR error. Run
  `npm run lint:pjsr`, which catches the three that produce no message at all.
- Startup output the Process Console would have shown is written to
  `~/.pixinsight-mcp/bridge/logs/watcher-startup.log`.

### PixInsight process errors
- Check `~/.pixinsight-mcp/bridge/logs/` for detailed logs
- Open PixInsight's Process Console for script errors
- Verify file paths are absolute and files exist
