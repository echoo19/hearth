# Connect Claude Code

Claude Code works directly from Hearth's embedded project terminal. Opening a
project gives it a normal shell at the project root, puts the `hearth` CLI on
PATH, and provides the project's instructions and skills. MCP registration is
optional and manual; use the CLI immediately, or follow the setup below when
you want Hearth's commands exposed as MCP tools. Hearth never runs a model or
holds an API key; you're running your own `claude` CLI against your own
subscription. See [agent-panel.md](./agent-panel.md) for the terminal,
Activity, Checkpoint, Review, and Restore workflow.

## From the Agent panel

Open a project and focus the **Agent** panel, then type `claude`. The embedded
shell starts at the project root, `hearth` is already on PATH, and Claude Code
owns its normal login and update flow. Hearth does not detect or install it.
New projects already contain Claude instructions and project-local skills.

Opening a project does not create an MCP configuration or change Claude Code's
settings. The shell and `hearth` CLI are ready without MCP. If you prefer MCP
tool calls, register the server explicitly using the manual path below.

## The manual path (any terminal)

Outside the editor, register the MCP server yourself. Grab the standalone
`hearth-mcp.mjs` (needs Node 20+) from the
[latest release](https://github.com/echoo19/hearth/releases/latest), or use
`packages/mcp-server/dist/main.js` from a source checkout.

```bash
claude mcp add hearth --scope project \
  -- node /abs/path/to/hearth-mcp.mjs --project /abs/path/to/my-game --mode safe-edit
```

- `--scope project` writes the shareable `.mcp.json` at the project root
  (commit it to share with a team). `--scope local` (the default) keeps it
  private to you in `~/.claude.json`; `--scope user` applies it across all
  your projects.
- Everything after `--` is the server command exactly as Hearth launches it.

That produces the canonical `.mcp.json`, which you can also hand-write:

```json
{
  "mcpServers": {
    "hearth": {
      "command": "node",
      "args": ["/abs/path/to/hearth-mcp.mjs", "--project", "/abs/path/to/my-game", "--mode", "safe-edit"]
    }
  }
}
```

Manage it with `claude mcp list`, `claude mcp get hearth`, and `claude mcp
remove hearth`.

## First thing in a session

Have Claude call **`get_agent_instructions`** before anything else. It returns
the project's `AGENTS.md` house rules plus the active permission modes, so the
agent orients itself instead of guessing. The per-project skills under
`.claude/skills/` teach the working loop
(snapshot → inspect → edit → validate → playtest → diff) and the game-craft
recipes on top of it.

## Permission modes

The MCP server enforces a permission grant per session; a denied tool call
returns a structured `PERMISSION_DENIED` naming the missing mode, which the
agent can relay to you rather than retrying. Choose the server's `--mode` when
registering MCP:

| `--mode` value | Grants |
| --- | --- |
| `read-only` | Inspect, validate, diff, run non-mutating playtests |
| `safe-edit` | Scenes, entities, components, tilemaps, snapshots |
| `safe-edit,code-edit,asset-edit` | Above, plus scripts and assets — not build/export |
| `all` | Everything, including build/export |

See [mcp.md](./mcp.md#choosing-modes-per-session) for the full mode reference.

## Connecting other agents

The same embedded terminal can run Codex, OpenCode, and Hermes. See
[connect-codex.md](./connect-codex.md), [connect-opencode.md](./connect-opencode.md)
(with local models via Ollama), and [connect-hermes.md](./connect-hermes.md).
For any other MCP client or shell-native CLI, see
[connect-any-agent.md](./connect-any-agent.md).
