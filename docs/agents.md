# Agent Workflow Guide

How coding agents (Claude Code, Codex, or any MCP client) should work on
Hearth game projects. Humans: this is also the best explanation of *why*
Hearth is shaped the way it is.

## The philosophy

Hearth doesn't put an AI in the engine. Instead it makes the engine
**legible and controllable from outside**: every editor operation is a
structured, schema-validated, permission-checked command available over CLI
and MCP. Agents get real operations instead of guessing at file formats;
humans stay in charge through the visual editor, permissions, playtests, and
reviewable diffs.

## Two transports, one engine

- **CLI**: `hearth <command> --json` (see [cli.md](./cli.md)). Best when the
  agent already lives in a shell (Claude Code, Codex CLI).
- **MCP**: `hearth-mcp --project <path>` over stdio (see
  [mcp.md](./mcp.md)). Best for MCP-native clients; 62 command tools
  (plus `screenshot` and `get_agent_instructions`) wrapping the same core
  commands.

Both call the identical core command layer. Pick either; never mix in
hand-edits of `hearth.json`/`*.scene.json`/`assets.json`.

## The loop every agent should run

```
snapshot  →  inspect  →  change (commands)  →  validate  →  playtest  →  diff
```

1. **Snapshot** (`hearth snapshot` / `snapshot_project`) so the human can
   diff and revert your entire session.
2. **Inspect before editing**: `inspect project`, `inspect scene`,
   `inspect components`. Do not assume entity names, ids, or component
   properties; read them.
3. **Change through commands.** Create entities with components inline;
   set properties by dot path (`Transform.position.x`); create procedural
   placeholder sprites so the game is playable before art exists.
4. **Validate** (`hearth validate --json`) and fix every error you
   introduced. Warnings are advisory but read them.
5. **Playtest**: `hearth run <scene> --frames 120` catches script crashes;
   `hearth playtest --all` runs scripted assertions. Create playtests for
   behavior you add (`create playtest`): steps cover waits, key presses,
   pointer clicks, and assertions (including `assertScene`), and they're
   deterministic (fixed timestep, scripted input, seeded RNG — a playtest
   can set its own `seed`), so they're trustworthy. Run reports include
   `audioEvents` (every play/stop with frame and asset id), `sceneEvents`,
   and `finalScene`, so sound and scene switching are checkable headlessly
   too.
6. **Diff** (`hearth diff --json`) and summarize the changes for the human:
   scenes/entities/components/scripts/assets touched. The human sees the
   same diff in the editor's Changes panel (opened via the toolbar's
   Review button) and can revert.

**Scripting iteration**: `check_script`/`check-script` before
`edit_script`/`edit-script` as a pre-flight — it catches syntax errors
without writing anything. `edit_script` formats automatically (StyLua/
Prettier house style) unless you pass `format: false` or the project has
`codeStyle.formatOnSave` off, so you don't need a separate format step.
If the human has the editor open and playing while you work, your script
edits hot-reload into the running game and your property writes
(`set_component_property`/`set_properties`) apply live — no need to ask
them to Stop/Play for most changes; see
[scripting.md](./scripting.md#hot-reload-during-play) and
[editor.md](./editor.md#live-iteration-during-play) for exactly what
does and doesn't carry over. For cross-file work, `search_scripts` finds
matches read-only; `replace_in_scripts` always takes a `dryRun: true`
pass first to preview per-file counts before writing for real — see
[cli.md](./cli.md#the-script-group).

## Permission modes

Sessions carry a grant; commands declare a requirement. Defaults allow
everything except `build`.

| Mode | Unlocks |
| --- | --- |
| `read-only` | inspect, validate, diff, run scenes/playtests (always implied) |
| `safe-edit` | scene/entity/component CRUD, project settings (`updateSettings`: buildSettings incl. loading visuals, initial scene, input mappings), snapshot/revert, playtest defs |
| `code-edit` | create/edit/attach scripts (Lua by default, `--language js` for JavaScript) |
| `asset-edit` | import + procedural asset creation (sprites, tiles, sounds), metadata |
| `build` | web export (`exportWeb`) + portable project builds (`buildProject`) |

A human can run an agent read-only to get analysis with a guarantee of no
mutation, or grant `safe-edit` only to keep the agent out of code.

## What agents must not do

- Don't hand-edit project JSON. Schemas are strict, commands exist for
  everything, and unknown component types are rejected.
- Don't delete scenes/assets unless explicitly asked (asset removal refuses
  while references exist; file deletion is opt-in).
- Don't restructure the project layout.
- Don't leave validation failing.
- Don't skip the snapshot; an unreviewable session is a failed session.

## Project-embedded instructions

`hearth init` generates **AGENTS.md** (full instructions: golden rules, a
Lua-first scripting quick reference, and a `ctx` API reference rendered from
the same `CTX_API` table that powers `hearth inspect api`), **CLAUDE.md**
(pointer), and `.hearth/agent-config.json` (machine-readable: binary names,
recommended first commands, permission defaults) in every project. The MCP
server serves the same content via the `get_agent_instructions` tool, so an
agent that connects cold can bootstrap itself.

## Discovering capabilities

- `hearth commands --json`: the full engine command registry (name,
  description, permission, mutates).
- `hearth inspect components --json`: every component type with docs and
  default values.
- `hearth inspect api --json`: the complete script `ctx` API — every
  member with its signature, description, and a Lua + JS example.
- MCP `tools/list`: same registry as typed tools.

If a capability isn't in the registry, it doesn't exist. Ask the human
instead of improvising (e.g. there is no pathfinding command yet; it's on
the [roadmap](./roadmap.md)). `screenshot` (CLI and MCP) is the one
deliberate exception — it doesn't wrap a registry command since it needs
headless Chromium, a Node-only dependency the browser-safe core can't take
on — see [cli.md](./cli.md#command-tour).
