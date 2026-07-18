# Connect Codex

[Codex](https://github.com/openai/codex) is OpenAI's coding-agent CLI, and it
speaks stdio MCP, so it reads the exact same Hearth command surface Claude
Code does: the same 70 typed tools, the same `CommandResult` envelope, the
same permission modes. This page covers launching it from the editor and
wiring it up manually.

## From the Agent panel

Open a project, focus the **Agent** panel, and type `codex`. The shell starts at
the project root with `hearth` already on PATH; Codex owns its normal login and
update flow. Hearth does not detect Codex or rewrite its global config.

New projects already include `AGENTS.md` and the Hearth skills, so the CLI path
works immediately. To add typed MCP tools, register the server once using the
manual steps below. Codex's MCP config is global, so remember that a `hearth`
entry containing one absolute project path must be updated when you switch
projects.

## Manual setup

Grab
the standalone `hearth-mcp.mjs` (Node 20+) from the
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
server is, so no remote/URL transport is involved.

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

- [connect-claude-code.md](./connect-claude-code.md): Claude Code setup
- [connect-any-agent.md](./connect-any-agent.md): any other MCP client
- [mcp.md](./mcp.md): the full tool list and envelope
