# MCP Guide

Hearth ships `hearth-mcp` (`packages/mcp-server`), a stdio MCP server that
exposes the engine command layer as 48 typed tools (46 command tools, plus
`screenshot` and `get_agent_instructions`, neither of which wraps a core
command). The full reference (flags, registration snippets, permission
table, complete tool list) lives in
[`packages/mcp-server/README.md`](../packages/mcp-server/README.md).

## Quick start (Claude Code)

```bash
npm install && npm run build:packages    # once, in the hearth repo

claude mcp add hearth -- node /abs/path/to/hearth/packages/mcp-server/dist/main.js \
  --project /abs/path/to/my-game
```

Then in a session: call `get_agent_instructions` first. It returns the
project's AGENTS.md plus your active permission modes.

## Tool naming

Each MCP tool wraps exactly one core command, named in snake_case (a handful
of housekeeping commands are CLI-only): `get_project_info`,
`list_scenes`, `inspect_scene`, `inspect_entity`, `list_components`,
`validate_project`, `create_scene`, `create_entity`, `add_component`,
`set_component_property`, `create_script`, `edit_script`, `attach_script`,
`import_asset`, `create_sprite_asset`, `create_tile_asset`, `create_sound`,
`create_animation_asset`, `slice_spritesheet` (frame grid over an
imported spritesheet — takes numeric `frameWidth`/`frameHeight` rather
than the CLI's `--frame-size WxH` string), `create_animation_from_sheet`
(an animation asset from named sheet frames — see
[assets.md](./assets.md)), `undo`, `redo`, `list_history` (disk-backed
undo/redo, independent of `snapshot_project`/`revert_project`'s single
diff baseline — see [cli.md](./cli.md#command-tour)), `snapshot_project`,
`get_diff`, `revert_project`, `create_playtest`, `run_playtest`,
`run_scene`, `update_settings` (build settings, initial scene, and every
input mapping — actions, gamepad buttons/axes, virtual axes, deadzone;
see [input.md](./input.md)), `inspect_api` (the script `ctx` reference),
`inspect_path` (grid A\* pathfinding over solid scene geometry — same
query `ctx.scene.findPath` and `hearth inspect path` run, see
[cli.md](./cli.md#pathfinding)), `build_project`,
`export_web`, `get_agent_instructions`, … Every result is the standard `CommandResult`
JSON envelope in the tool output (with `isError` set on failure), so MCP
agents and CLI agents read identical structures.

`screenshot` is the one exception: it doesn't wrap a core command (capturing
requires headless Chromium, a Node/Playwright-only dependency core can't
take on). It still requires the `build` permission mode exactly like
`export_web`, takes the same options as the CLI's `hearth screenshot`
(`scene`, `frame`, `seed`, `width`, `height`, `debug`, `out`), and returns
screenshot metadata (path, width, height, frame, scene) as JSON — read the
PNG file yourself to see it. It needs a real Chromium install on the host
(Google Chrome, Microsoft Edge, `CHROMIUM_PATH`, or `npx playwright install
chromium`); see [cli.md](./cli.md#command-tour) for the full requirement.

## Choosing modes per session

- Analysis/review agent: `--mode read-only`
- Level design agent (no code): default minus code-edit → `--mode safe-edit,asset-edit`
- Full dev agent: default (`read-only,safe-edit,code-edit,asset-edit`)
- Release agent: `--mode all` (adds `build`)

Denied calls return structured `PERMISSION_DENIED` errors that name the
missing mode, so an agent can relay that to the human rather than retrying.

## One server, one project

Each `hearth-mcp` process serves a single project root, given at launch.
Working on several games at once = register several servers with different
names. The server never executes shell commands and never touches files
outside the project directory.
