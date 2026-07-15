# Connect Any MCP Client or CLI Agent

Hearth's agent surface is deliberately standard: a **stdio MCP server** (70
typed tools) and a **CLI** that mirror the same command registry one-to-one.
Any agent that can either launch a stdio MCP server or run a shell command can
drive Hearth — you don't need a Hearth-specific integration. This page is the
catch-all: the canonical config shape, per-client file locations, and the
plain-CLI fallback for a shell-only agent.

Named guides exist for the common cases:
[Claude Code](./connect-claude-code.md), [Codex](./connect-codex.md),
[OpenCode + Ollama](./connect-opencode.md), and
[Hermes](./connect-hermes.md). The editor's Agent panel auto-detects and
auto-wires all four of those directly — pick one from the launcher dropdown
and it writes the `hearth` MCP entry into that tool's own config format for
you. This page is for everything else: any other MCP client, or a
shell-native agent driven from the panel's plain terminal launcher.

## Get the server

Grab the standalone `hearth-mcp.mjs` (and `hearth-cli.mjs`) — both need only
Node 20+ — from the
[latest release](https://github.com/echoo19/hearth/releases/latest), or use
`packages/mcp-server/dist/main.js` (and `packages/cli/dist/main.js`) from a
source checkout. The server always launches the same way:

```
node /abs/path/to/hearth-mcp.mjs --project /abs/path/to/my-game --mode safe-edit
```

## The canonical MCP config

Most MCP clients — Claude Desktop, Cursor, Cline, Windsurf, and others — read
the same `mcpServers` shape. Register Hearth as:

```json
{
  "mcpServers": {
    "hearth": {
      "command": "node",
      "args": ["/abs/path/to/hearth-mcp.mjs", "--project", "/abs/path/to/my-game", "--mode", "safe-edit"],
      "env": {}
    }
  }
}
```

Change `--mode` to set the permission grant: `read-only`, `safe-edit`,
`safe-edit,code-edit,asset-edit` (everything but build), or `all`. A denied
tool call returns a structured `PERMISSION_DENIED` naming the missing mode —
see [mcp.md](./mcp.md#choosing-modes-per-session).

### Per-client config locations

Formats drift between client versions, so treat the "verify" rows as "check
the client's current docs" — but the `mcpServers` block itself is the same
everywhere it's used.

| Client | Config file (macOS) | Notes |
| --- | --- | --- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` shape above |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) | `mcpServers` shape above |
| Cline (VS Code) | extension globalStorage `.../cline_mcp_settings.json` | `mcpServers`; easiest via the extension's MCP UI. Exact path varies by VS Code build — verify |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers`; verify against current docs |
| Continue | `~/.continue/config.yaml` (or older `config.json`) | Format changed between versions — verify |
| Zed | `~/.config/zed/settings.json` | Uses `context_servers`, **not** `mcpServers`, with the command nested — verify Zed's current schema |

If your client isn't listed, look for where it configures "MCP servers" or
"context servers" and drop in the `command`/`args` from above. It's a
subprocess-over-stdio server; there's no port, URL, or network transport to
configure.

## Shell-only agents: the plain CLI loop

An agent that only gets a shell (no MCP support at all) still drives Hearth
fully through the `hearth` CLI — same commands, same `--json` result envelope
the MCP tools return. Give it this loop:

```bash
hearth snapshot                     # checkpoint the session for review
hearth inspect scene "Level 1" --json   # see what's there
hearth create entity "Level 1" Gem --position 620,300 --tags coin \
  --components '{"SpriteRenderer":{"shape":"diamond","color":"#9b59b6"}}'
hearth attach script "Level 1" Gem scripts/coin-pickup.lua
hearth validate --json              # schema + reference checks
hearth test                         # deterministic headless playtests
hearth diff                         # human-readable structural diff
hearth revert --confirm             # undo the whole session, if needed
```

Add a `--allow <mode>` flag to gate what the CLI session may do
(`--allow read-only` up to `--allow all`), mirroring the MCP `--mode`. Alias
`hearth` to `node /abs/path/to/hearth-cli.mjs` if you're using the standalone
file. Full command reference: [cli.md](./cli.md).

## First thing in a session

Whatever the client, have the agent call **`get_agent_instructions`** (MCP) or
read `AGENTS.md` (shell) first — it returns the project's house rules and the
active permission modes. The working loop and game-craft recipes live in the
project skills under `.claude/skills/`, which the editor backfills into any
project that doesn't have them yet.

## See also

- [mcp.md](./mcp.md) — the full tool list, naming, and result envelope
- [cli.md](./cli.md) — every command and the `--json` envelope
- [agents.md](./agents.md) — how agents should operate on a Hearth project, and why
