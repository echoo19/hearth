# MCP Guide

Hearth ships `hearth-mcp` (`packages/mcp-server`), a stdio MCP server that
exposes the whole engine command layer as ~37 typed tools. Full reference —
flags, registration snippets, permission table, complete tool list — lives in
[`packages/mcp-server/README.md`](../packages/mcp-server/README.md).

## Quick start (Claude Code)

```bash
npm install && npm run build:packages    # once, in the hearth repo

claude mcp add hearth -- node /abs/path/to/hearth/packages/mcp-server/dist/main.js \
  --project /abs/path/to/my-game
```

Then in a session: call `get_agent_instructions` first — it returns the
project's AGENTS.md plus your active permission modes.

## Tool naming

MCP tools mirror core commands 1:1 in snake_case: `get_project_info`,
`list_scenes`, `inspect_scene`, `inspect_entity`, `list_components`,
`validate_project`, `create_scene`, `create_entity`, `add_component`,
`set_component_property`, `create_script`, `edit_script`, `attach_script`,
`import_asset`, `create_sprite_asset`, `create_tile_asset`,
`create_animation_asset`, `snapshot_project`, `get_diff`, `revert_project`,
`create_playtest`, `run_playtest`, `run_scene`, `build_project`,
`get_agent_instructions`, … Every result is the standard `CommandResult`
JSON envelope in the tool output (with `isError` set on failure), so MCP
agents and CLI agents read identical structures.

## Choosing modes per session

- Analysis/review agent: `--mode read-only`
- Level design agent (no code): default minus code-edit → `--mode safe-edit,asset-edit`
- Full dev agent: default (`read-only,safe-edit,code-edit,asset-edit`)
- Release agent: `--mode all` (adds `build`)

Denied calls return structured `PERMISSION_DENIED` errors that name the
missing mode — an agent can relay that to the human rather than retrying.

## One server, one project

Each `hearth-mcp` process serves a single project root, given at launch.
Working on several games at once = register several servers with different
names. The server never executes shell commands and never touches files
outside the project directory.
