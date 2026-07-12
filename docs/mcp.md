# MCP Guide

Hearth ships `hearth-mcp` (`packages/mcp-server`), a stdio MCP server that
exposes the engine command layer as 69 typed tools (67 command tools, plus
`screenshot` and `get_agent_instructions`, neither of which wraps a core
command). The engine's own command registry has 70 commands total — three
(`setEntityEnabled`, `setEntityTags`, `setAssetMetadata`) are CLI-only
housekeeping verbs with no MCP wrapper. The full reference (flags,
registration snippets, permission table, complete tool list) lives in
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
`validate_project`, `create_scene`, `duplicate_scene` (fresh entity ids;
optionally clones playtests targeting the source scene, retargeted to the
copy — see [cli.md](./cli.md#command-tour)), `create_entity`,
`duplicate_entity` (deep-copies an entity and its full descendant subtree
with fresh ids in one call, offset from the original), `add_component`,
`set_component_property` (strict dot-path validation with a did-you-mean
suggestion on an unknown segment), `set_properties` (batch: multiple
dot-path properties on one entity in a single undo step, all-or-nothing
validated — see [cli.md](./cli.md#command-tour)), `paint_tiles`,
`fill_tilemap_rect`, `resize_tilemap` (batched Tilemap edits — see
[cli.md](./cli.md#tilemap-editing)), `create_script`, `edit_script`,
`format_script` (reformat a script, or every script with `all: true`, to
Hearth house style — StyLua/Prettier — see
[cli.md](./cli.md#the-script-group)), `check_script` (syntax-check source
or an existing script file without saving — read-only, a pre-flight
before `edit_script`), `attach_script`, `search_scripts` (plain-text or
regex search across script source, read-only — see
[cli.md](./cli.md#the-script-group)), `replace_in_scripts` (find-and-replace
across script files; always run with `dryRun: true` first to preview
per-file match counts, results are written verbatim without reformatting
— see [cli.md](./cli.md#the-script-group)),
`import_asset`, `import_assets` (bulk/atomic multi-file import, `skipped`
per-file reasons — see [cli.md](./cli.md#command-tour)), `create_sprite_asset`,
`create_tile_asset`, `create_sound`, `create_animation_asset`,
`slice_spritesheet` (frame grid over an
imported spritesheet — takes numeric `frameWidth`/`frameHeight` rather
than the CLI's `--frame-size WxH` string), `remove_asset` (unregisters an
asset; the CLI's `delete asset` wraps this same tool), `create_animation_from_sheet`
(an animation asset from named sheet frames — see
[assets.md](./assets.md)), `set_tile_autotile` (bind a Tilemap tile char to
a blob47 autotile rule, or clear one — see
[editor.md](./editor.md#autotile)), `create_state_machine_asset`,
`update_state_machine_asset` (author an animation state machine asset's
full document — params/states/transitions — see
[scripting.md](./scripting.md#animation-state-machines)), `create_prefab`,
`instantiate_prefab`, `update_prefab`, `sync_prefab_instances`,
`revert_prefab_override` (live-linked prefab authoring, merge sync, and
per-field/instance revert — see [prefabs.md](./prefabs.md)), `undo`, `redo`,
`list_history` (disk-backed
undo/redo, independent of `snapshot_project`/`revert_project`'s single
diff baseline — see [cli.md](./cli.md#command-tour)), `list_journal`
(the command journal backing `hearth log` and the editor's Agent panel
timeline — see [cli.md](./cli.md#command-journal)), `snapshot_project`,
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
