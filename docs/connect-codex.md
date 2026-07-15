# Connect Codex

[Codex](https://github.com/openai/codex) is OpenAI's coding-agent CLI, and it
speaks stdio MCP, so it reads the exact same Hearth command surface Claude
Code does — the same 70 typed tools, the same `CommandResult` envelope, the
same permission modes. This page covers launching it from the editor and
wiring it up manually.

## From the Agent panel

If `codex` is on your `PATH`, the editor's **Agent** panel detects it and
offers a **Start agent: Codex** action that spawns `codex` in the embedded
terminal, working directory set to your project. Codex handles its own login
and configuration in the terminal exactly as it would in any shell.

Codex configures MCP servers through a TOML file rather than the `.mcp.json`
Claude Code reads, so wire the `hearth` server into Codex's own config once
(below) and it's available to every Codex session in that project. (First-class
one-command MCP wiring from the panel for Codex is still being built out; until
then the config step here is the reliable path.)

## Manual setup

Grab the standalone `hearth-mcp.mjs` (Node 20+) from the
[latest release](https://github.com/echoo19/hearth/releases/latest), or use
`packages/mcp-server/dist/main.js` from a source checkout.

### With `codex mcp add`

```bash
codex mcp add hearth \
  -- node /abs/path/to/hearth-mcp.mjs --project /abs/path/to/my-game --mode safe-edit
```

Everything after `--` is the server command exactly as Hearth launches it.

### By hand in `~/.codex/config.toml`

Codex stores MCP servers under `[mcp_servers.<name>]` (note: plural,
underscore) in `~/.codex/config.toml`:

```toml
[mcp_servers.hearth]
command = "node"
args = ["/abs/path/to/hearth-mcp.mjs", "--project", "/abs/path/to/my-game", "--mode", "safe-edit"]
# startup_timeout_sec = 10   # optional, default 10
# tool_timeout_sec = 60      # optional, default 60
# enabled = true             # set false to disable without deleting
```

Codex only supports local stdio MCP servers, which is exactly what Hearth's
server is — so no remote/URL transport is involved.

## First thing in a session

Have Codex call **`get_agent_instructions`** first. It returns the project's
`AGENTS.md` house rules and the active permission modes. Codex reads
`AGENTS.md` natively as well, so the house rules land in its context either
way. The working loop and game-craft recipes live in the project skills under
`.claude/skills/`.

## Permission modes

Set the mode in the `--mode` argument you registered (change it and restart
Codex to take effect):

| `--mode` value | Grants |
| --- | --- |
| `read-only` | Inspect, validate, diff, run non-mutating playtests |
| `safe-edit` | Scenes, entities, components, tilemaps, snapshots |
| `safe-edit,code-edit,asset-edit` | Above, plus scripts and assets — not build/export |
| `all` | Everything, including build/export |

A denied call returns a structured `PERMISSION_DENIED` naming the missing
mode. See [mcp.md](./mcp.md#choosing-modes-per-session) for the full reference.

## See also

- [connect-claude-code.md](./connect-claude-code.md) — the one-click path
- [connect-any-agent.md](./connect-any-agent.md) — any other MCP client
- [mcp.md](./mcp.md) — the full tool list and envelope
