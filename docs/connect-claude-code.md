# Connect Claude Code

Claude Code is the smoothest agent to point at a Hearth project, because the
editor wires it up for you. This page covers both paths: the one-click Agent
panel, and manual setup for a terminal outside the editor. Either way, what
Claude Code gets is the whole engine as typed, permission-checked commands —
plus the per-project skill that teaches it *how* to use them well. Hearth
never runs a model or holds an API key; you're running your own `claude` CLI
against your own subscription. See
[agent-panel.md](./agent-panel.md#why-a-terminal-not-a-custom-chat-ui) for why
that distinction matters.

## The one-click path (Agent panel)

In the desktop app or `npm run dev`, open a project and go to the **Agent**
panel:

1. Pick a **permission mode** (defaults to Safe edit; see
   [Permission modes](#permission-modes)).
2. Click **Start agent**. The panel merge-writes a `hearth` entry into the
   project's `.mcp.json` at that mode, backfills the project skill if it's
   missing, and spawns your real `claude` binary in an embedded terminal with
   its working directory set to the project.
3. Claude Code discovers `.mcp.json` on its own, asks you to approve the
   `hearth` server the first time, and handles its own login if needed — all
   inside the terminal.

If `claude` isn't on your `PATH`, the panel shows **Install Claude Code**
instead, which runs the official installer visibly in the terminal (nothing
hidden), then re-detects. Full panel behavior — the activity timeline,
Checkpoint / Review / Revert, the external-change model — is in
[agent-panel.md](./agent-panel.md).

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
`.claude/skills/` teach the working loop —
snapshot → inspect → edit → validate → playtest → diff — and the game-craft
recipes on top of it.

## Permission modes

The MCP server enforces a permission grant per session; a denied tool call
returns a structured `PERMISSION_DENIED` naming the missing mode, which the
agent can relay to you rather than retrying. The panel's 4-tier picker maps
onto the server's real `--mode` tokens:

| Panel label | `--mode` value | Grants |
| --- | --- | --- |
| Read-only | `read-only` | Inspect, validate, diff, run non-mutating playtests |
| Safe edit | `safe-edit` | Scenes, entities, components, tilemaps, snapshots |
| Full (no build) | `safe-edit,code-edit,asset-edit` | Above, plus scripts and assets — not build/export |
| All (incl. build) | `all` | Everything, including build/export |

See [mcp.md](./mcp.md#choosing-modes-per-session) for the full mode reference.

## Connecting other agents

Codex has its own detection and launcher in the panel plus a manual config —
see [connect-codex.md](./connect-codex.md). For OpenCode with local models via
Ollama, see [connect-opencode.md](./connect-opencode.md); for the Hermes model
family, [connect-hermes.md](./connect-hermes.md); and for any other MCP client
or shell-native CLI, [connect-any-agent.md](./connect-any-agent.md).
