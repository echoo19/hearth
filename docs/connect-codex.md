# Connect Codex

[Codex](https://github.com/openai/codex) is OpenAI's coding-agent CLI, and it
speaks stdio MCP, so it reads the exact same Hearth command surface Claude
Code does — the same 70 typed tools, the same `CommandResult` envelope, the
same permission modes. This page covers launching it from the editor and
wiring it up manually.

## From the Agent panel

If `codex` is on your `PATH`, the editor's **Agent** panel detects it, and
picking **Codex** from the launcher dropdown then clicking **Start agent**
does the whole setup for you:

1. The panel runs `codex mcp get hearth` first; if Codex already has a
   `hearth` entry pointed at this project and mode, nothing is rewritten.
2. Otherwise it runs `codex mcp add hearth -- node <mcp path> --project
   <project path> --mode <mode>` for you — Codex's own writer for its TOML
   config, not a hand-merge — which lands as a clean `[mcp_servers.hearth]`
   table in `~/.codex/config.toml`.
3. It backfills the project's `.claude/skills/` if they're missing, then
   spawns `codex` in the embedded terminal, working directory set to your
   project. The `hearth` CLI is already on that terminal's `PATH` (Hearth
   writes a small shim into every embedded session), and Codex handles its
   own login in the terminal exactly as it would in any shell.

Codex's config is **global**, not per-project — `~/.codex/config.toml` holds
one `hearth` entry, and it's rewritten to point at whichever project you most
recently prepared. In practice that's always the project you're launching
from, since prepare runs immediately before Codex spawns; just know that
opening a different project and starting Codex there repoints the same
global entry.

If you'd rather not use the panel, the manual steps below produce the exact
same config by hand.

## Manual setup

The steps below are what the panel's prepare step does for you automatically
(and the fallback if you're driving Codex outside the editor entirely). Grab
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
