# @hearth/mcp-server

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that exposes a Hearth game
project as structured tools for coding agents (Claude Code, Codex, or any MCP client). It wraps the
same `HearthSession` command layer used by the `hearth` CLI, so agents inspect, modify, test, and
build a project through validated engine operations instead of hand-editing project JSON.

## Running

```bash
# From the built package
node dist/main.js --project /path/to/my-game

# From source (workspace dev script)
npm run dev -w @hearth/mcp-server -- --project /path/to/my-game

# Restrict (or widen) permission modes for the session
node dist/main.js --project /path/to/my-game --mode read-only,safe-edit
node dist/main.js --project /path/to/my-game --mode all
```

The server communicates over **stdio**, so an MCP client has to launch it; there's nothing to run
interactively. All logging goes to `stderr`; `stdout` is reserved for the JSON-RPC transport.

### CLI flags

| Flag | Required | Description |
| --- | --- | --- |
| `--project <path>` | Yes | Path to a Hearth project directory (must contain `hearth.json`). |
| `--mode <modes>` | No | Comma-separated permission modes, or `all`. Defaults to `read-only,safe-edit,code-edit,asset-edit` (core's `DEFAULT_MODES`; `build` is opt-in). |

If the project fails to load (missing `hearth.json`, invalid schema, etc.) the server prints a clear
error to `stderr` and exits with a non-zero status instead of starting.

## Registering with Claude Code

```bash
claude mcp add hearth -- node /absolute/path/to/hearth/packages/mcp-server/dist/main.js --project /absolute/path/to/my-game
```

Or via a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hearth": {
      "command": "node",
      "args": [
        "/absolute/path/to/hearth/packages/mcp-server/dist/main.js",
        "--project",
        "/absolute/path/to/my-game",
        "--mode",
        "read-only,safe-edit,code-edit,asset-edit"
      ]
    }
  }
}
```

Use absolute paths for both the server script and `--project`, since MCP clients typically launch
servers with an unrelated working directory.

## Permission modes

Modes form an escalating set of capabilities. `read-only` is always implied; a tool call whose
required mode isn't granted returns a structured `PERMISSION_DENIED` error instead of failing silently
or crashing the server.

| Mode | Grants |
| --- | --- |
| `read-only` | Inspect project, scenes, entities; validate; diff; run non-mutating playtests. |
| `safe-edit` | Create/modify/delete scenes and entities; add/remove components; set component properties; snapshot. |
| `code-edit` | Create and edit scripts; attach scripts to entities. |
| `asset-edit` | Import assets; create procedural assets; modify asset metadata. |
| `build` | Build/export the project. |

Pass `--mode all` to grant every mode, or a specific comma-separated subset (e.g.
`--mode read-only,safe-edit` for a review-only agent that may still snapshot for diffing).

## Tool result shape

Every tool (except `get_agent_instructions`) returns `JSON.stringify(result)` in `content[0].text`,
where `result` is the full core `CommandResult` envelope:

```ts
{
  success: boolean;
  command: string;
  data: unknown | null;
  errors: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  changed: { kind: string; id?: string; name?: string; path?: string; scene?: string; action: string }[];
  files: string[];       // project-relative files written by this command
  suggestions: string[]; // hints for next commands
}
```

When `success` is `false` (validation failure, permission denial, not-found, etc.) the tool result also
sets `isError: true` so MCP clients surface it as a tool error while still getting the structured detail
in `errors`.

## Tools

All tools call into the same command registry as the `hearth` CLI (see `@hearth/core`'s
`commands/registry.ts`). Descriptions below note the minimum permission mode required; `get_agent_instructions`
requires no permission (it's purely informational).

| Tool | Core command | Requires |
| --- | --- | --- |
| `get_project_info` | `inspectProject` | read-only |
| `list_scenes` | `listScenes` | read-only |
| `inspect_scene` | `inspectScene` | read-only |
| `inspect_entity` | `inspectEntity` | read-only |
| `list_components` | `inspectComponents` | read-only |
| `list_assets` | `inspectAssets` | read-only |
| `list_scripts` | `inspectScripts` | read-only |
| `read_script` | `readScript` | read-only |
| `inspect_api` | `inspectApi` | read-only |
| `inspect_path` | `inspectPath` | read-only |
| `validate_project` | `validateProject` | read-only |
| `create_scene` | `createScene` | safe-edit |
| `delete_scene` | `deleteScene` | safe-edit |
| `rename_scene` | `renameScene` | safe-edit |
| `duplicate_scene` | `duplicateScene` | safe-edit |
| `set_initial_scene` | `setInitialScene` | safe-edit |
| `create_entity` | `createEntity` | safe-edit |
| `delete_entity` | `deleteEntity` | safe-edit |
| `rename_entity` | `renameEntity` | safe-edit |
| `duplicate_entity` | `duplicateEntity` | safe-edit |
| `move_entity` | `moveEntity` | safe-edit |
| `add_component` | `addComponent` | safe-edit |
| `remove_component` | `removeComponent` | safe-edit |
| `set_component_property` | `setComponentProperty` | safe-edit |
| `set_properties` | `setProperties` | safe-edit |
| `set_input_mapping` | `setInputMapping` | safe-edit |
| `paint_tiles` | `paintTiles` | safe-edit |
| `fill_tilemap_rect` | `fillTilemapRect` | safe-edit |
| `resize_tilemap` | `resizeTilemap` | safe-edit |
| `update_settings` | `updateSettings` | safe-edit |
| `create_script` | `createScript` | code-edit |
| `edit_script` | `editScript` | code-edit |
| `format_script` | `formatScript` | code-edit |
| `check_script` | `checkScript` | read-only |
| `attach_script` | `attachScript` | code-edit |
| `search_scripts` | `searchScripts` | read-only |
| `replace_in_scripts` | `replaceInScripts` | code-edit |
| `import_asset` | `importAsset` | asset-edit |
| `create_sprite_asset` | `createSpriteAsset` | asset-edit |
| `create_tile_asset` | `createTileAsset` | asset-edit |
| `create_sound` | `createSound` | asset-edit |
| `create_animation_asset` | `createAnimationAsset` | asset-edit |
| `slice_spritesheet` | `sliceSpritesheet` | asset-edit |
| `remove_asset` | `removeAsset` | asset-edit |
| `create_animation_from_sheet` | `createAnimationFromSheet` | asset-edit |
| `create_prefab` | `createPrefab` | asset-edit |
| `instantiate_prefab` | `instantiatePrefab` | asset-edit |
| `update_prefab` | `updatePrefab` | asset-edit |
| `sync_prefab_instances` | `syncPrefabInstances` | asset-edit |
| `undo` | `undo` | safe-edit |
| `redo` | `redo` | safe-edit |
| `list_history` | `listHistory` | read-only |
| `list_journal` | `listJournal` | read-only |
| `snapshot_project` | `snapshotProject` | safe-edit |
| `get_diff` | `diffProject` | read-only |
| `revert_project` | `revertProject` | safe-edit |
| `create_playtest` | `createPlaytest` | safe-edit |
| `list_playtests` | `listPlaytests` | read-only |
| `run_playtest` | `runPlaytest` | read-only |
| `run_scene` | `runScene` | read-only |
| `build_project` | `buildProject` | build |
| `export_web` | `exportWeb` | build |
| `screenshot` | — (calls `@hearth/playtest`'s `captureScreenshot` directly; needs headless Chrome/Chromium) | build |
| `get_agent_instructions` | — (reads project `AGENTS.md`, or generates the default) | — |

All tools are registered regardless of the session's granted modes, so a client can always see the full
tool catalog via `tools/list`. Calling a tool the session doesn't have permission for returns a
`PERMISSION_DENIED` error envelope rather than hiding the tool, which gives agents (and humans watching
the transcript) a clear, actionable message instead of a mysterious missing capability.

## Development

```bash
npm run build -w @hearth/mcp-server     # compile to dist/
npm run typecheck -w @hearth/mcp-server # type-check only
npm run dev -w @hearth/mcp-server -- --project <path>  # run from source via tsx
npx vitest run packages/mcp-server      # run tests
```

Tests use the MCP SDK's `InMemoryTransport` and `Client` to exercise the server in-process against a
project built with `@hearth/core`'s `MemoryFileSystem`, with no stdio or filesystem involved.
