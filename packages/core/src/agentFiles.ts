/**
 * Agent integration files generated into every new Hearth project.
 * These teach coding agents (Claude Code, Codex, any MCP client) how to work
 * on the project safely through structured engine operations.
 */
import { HEARTH_VERSION } from './schema/project.js';
import { CTX_API } from './ctxApi.js';

/** Render the ctx API reference for AGENTS.md, generated from CTX_API. */
function renderCtxReference(): string {
  return CTX_API.map((e) => {
    // Methods: full dot path + the signature's parameter/return part.
    const shown = e.kind === 'method' ? `ctx.${e.path}${e.signature.slice(e.signature.indexOf('('))}` : `ctx.${e.path}`;
    return `- \`${shown}\` — ${e.description}`;
  }).join('\n');
}

export function generateAgentsMd(projectName: string): string {
  return `# Working on "${projectName}" (a Hearth project)

This directory is a **Hearth** game project. Hearth is an open-source,
agent-native 2D game engine: the entire editor/runtime is exposed through a
structured CLI (\`hearth\`) and an MCP server (\`hearth-mcp\`) so coding agents
can inspect, modify, test, and build this game through safe engine
operations instead of hand-editing JSON.

> **Best-practices skill.** Hearth ships a coding-agent skill teaching the
> end-to-end workflows below — project setup, ctx scripting, prefabs,
> autotiling, playtest-driven verification, and export. It lives at
> \`skills/hearth/SKILL.md\` in the Hearth engine repo; Claude Code users can
> install it so the agent knows how to drive every command. This file is the
> per-project quick reference; the skill is the deeper playbook.

## Golden rules

1. **Do not guess the project structure.** Inspect first:
   - \`hearth inspect project --json\`
   - \`hearth inspect scenes --json\`
   - \`hearth inspect scene <scene> --json\`
   - \`hearth inspect entity <scene> <entity> --json\`
   - \`hearth inspect components --json\` (all component types + default values)
2. **Prefer structured commands over editing project JSON by hand.**
   The CLI validates every change against schemas. Direct edits to
   \`hearth.json\`, \`scenes/*.scene.json\`, or \`assets.json\` can corrupt the
   project (\`hearth set-settings\` updates build/loading settings, the
   initial scene, and input mappings safely). Scripts are **Lua by default**
   (\`.js\` also supported) and are normal code: edit \`scripts/*.lua\` /
   \`scripts/*.js\` freely (or via \`hearth create script\` / \`hearth edit-script\`).
3. **Snapshot before you change anything:** \`hearth snapshot\`.
   Then the human can review your work with \`hearth diff\` (or the editor's
   Diff panel), and \`hearth revert --confirm\` can undo it.
4. **Validate after changes:** \`hearth validate --json\`. Fix errors you introduced.
5. **Playtest your work:** \`hearth playtest <name>\` runs headless scripted
   tests; \`hearth run <scene> --frames 120\` smoke-runs a scene and reports
   script errors. Run reports include \`audioEvents\` (every audio play/stop
   with its frame and asset id), so you can verify sound behavior headlessly.
6. **Do not delete assets or scenes unless explicitly asked.**
7. **Summarize your changes** when done: which scenes, entities, components,
   scripts, and assets you touched (\`hearth diff --json\` gives you the list).

## Typical workflow

\`\`\`bash
hearth snapshot                        # checkpoint for diff/review
hearth inspect project --json          # learn the project
hearth inspect scene level_1 --json    # learn the scene
hearth create entity level_1 Coin --components '{"SpriteRenderer":{"shape":"circle","color":"#f1c40f"}}'
hearth set level_1 Coin Transform.position.x 200
hearth create sound pickup --preset coin       # deterministic WAV (presets: coin, jump, hit, laser, powerup, explosion, blip)
hearth create script coin-spin                 # Lua by default (--language js for JavaScript)
hearth attach script level_1 Coin scripts/coin-spin.lua
hearth validate --json                 # must pass
hearth run level_1 --frames 120 --json # no script errors
hearth diff                            # review what changed
hearth export web --zip                # playable static build, itch.io-ready (needs --allow build)
hearth export desktop --allow build    # native macOS/Windows/Linux app, zipped per platform
\`\`\`

Ship: \`export web\` for a browser build (add \`--zip\` for itch.io); \`export
desktop\` wraps the same build in an Electron shell and zips one app per
platform (macOS is ad-hoc signed by default; \`HEARTH_MAC_IDENTITY\`/
\`HEARTH_APPLE_ID\`/\`HEARTH_APPLE_PASSWORD\`/\`HEARTH_TEAM_ID\` env vars sign
and notarize a real release). \`buildSettings.icon\` (a sprite asset id, set
via \`hearth set-settings --build-settings '{"icon":"ast_x"}'\`) becomes the
desktop app icon; leave it \`null\` for the bundled default.

## Project layout (do not restructure)

- \`hearth.json\`: project manifest (scenes list, input mappings, build settings)
- \`scenes/*.scene.json\`: scene files (entities + components)
- \`assets.json\`: asset index; \`assets/\`: asset files, including \`assets/prefabs/*.prefab.json\` (reusable entity-subtree templates)
- \`scripts/*.lua\` (and \`*.js\`): behavior scripts (Lua by default; \`hearth inspect api --json\` documents the ctx API)
- \`playtests/*.playtest.json\`: headless playtest definitions
- \`.hearth/\`: engine state (baseline snapshots, agent config); don't edit manually

## Prefabs

Reusable entity templates: \`hearth prefab create <scene> <entity> <name>\`
serializes an entity's full subtree into a prefab asset; \`hearth prefab
place <prefab> <scene>\` instantiates it as a fresh entity subtree;
\`hearth prefab update <prefab> <scene> <entity>\` pushes edits on a tracked
instance back onto the asset; \`hearth prefab sync <prefab>\` rebuilds every
tracked instance from the current payload, keeping each instance's id,
name, position, and enabled state, but **replacing its whole descendant
subtree** (any child you added by hand to one instance is lost on sync).
Scripts spawn prefabs at runtime with \`ctx.scene.spawnPrefab(name, opts?)\`
(returns \`nil\`/\`null\` if the name is unknown; destroying the returned
root does not cascade to its children).

## Scripting quick reference

Scripts are **Lua by default** (\`hearth create script <name>\`; add
\`--language js\` for JavaScript). A Lua script returns a table of lifecycle
hooks — \`onStart(ctx)\`, \`onUpdate(ctx, dt)\`, \`onCollision(ctx, other)\`, and
\`onUiEvent(ctx, event)\` (pointer/focus events on this entity's interactive
\`UIElement\`; \`event.type\` is
\`click|press|release|enter|exit|drag|change|focus|blur\`, with a
\`value\` field on \`change\` — the slider/toggle's new value):

\`\`\`lua
local script = {}

function script.onStart(ctx)
end

function script.onUpdate(ctx, dt)
  ctx.transform.position.x = ctx.transform.position.x + 100 * dt
end

return script
\`\`\`

**Call ctx with a dot, not a colon**: \`ctx.log("hi")\`, \`ctx.scenes.load("Level")\` —
never \`ctx:log("hi")\`. JS scripts \`export default\` an object with the same
hooks and receive the identical \`ctx\`.

The full ctx API (\`hearth inspect api --json\` returns this machine-readable,
with Lua and JS examples per entry):

${renderCtxReference()}

Scene switching makes user-built menus/start screens (e.g. a Start button —
an interactive \`UIElement\` — whose script loads the level):

\`\`\`lua
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "click" then
    ctx.scenes.load("Level")
  end
end

return script
\`\`\`

Save data persists across scene switches (and across browser sessions in
exported games):

\`\`\`lua
local best = ctx.load("bestScore") or 0
if score > best then
  ctx.save("bestScore", score)
end
\`\`\`

\`ctx.random\` (and Lua's \`math.random\`) is seeded and deterministic — the
same seed produces the same sequence, so playtests are reproducible. Never
use wall-clock time or \`Math.random\` for gameplay.

Input actions are defined in \`hearth.json\` under \`inputMappings.actions\`
(\`hearth inspect project --json\` shows them; \`hearth set-input <action> <keys...>\` changes them).

Component notes: \`UIElement\` makes an entity screen-space UI (anchor +
offset, camera-independent; visuals come from Text/SpriteRenderer;
\`interactive: true\` enables onUiEvent). \`Collider\` polygons must be convex
with at least 3 points — split concave shapes across multiple entities.
\`AudioSource\` with \`autoplay: true\` plays its asset on scene start.

## MCP

If you are connected via MCP instead of the CLI, the same operations are
exposed as tools (\`get_project_info\`, \`inspect_scene\`, \`create_entity\`,
\`set_component_property\`, \`set_properties\`, \`check_script\`,
\`create_sound\`, \`run_playtest\`, \`get_diff\`, \`export_web\`,
\`export_desktop\`, ...). Call \`get_agent_instructions\` for this document.
(\`hearth init --template\` is pre-project, so it has no MCP tool — it's a
CLI-only step before a session exists.)

Generated by Hearth ${HEARTH_VERSION}.
`;
}

export function generateClaudeMd(projectName: string): string {
  return `# CLAUDE.md for ${projectName}

This is a Hearth game project. **Read AGENTS.md for the full agent guide.**

Quick facts:
- Use the \`hearth\` CLI (with \`--json\`) for all project operations; do not hand-edit
  \`hearth.json\`, \`scenes/*.scene.json\`, or \`assets.json\`.
- \`hearth snapshot\` before changes; \`hearth validate --json\` and \`hearth diff\` after.
- Behavior code lives in \`scripts/\`: **Lua by default** (\`.js\` also supported), edit freely.
  Lua calls ctx with a dot, not a colon: \`ctx.log("hi")\`. \`hearth inspect api --json\`
  documents the full ctx API.
- Test with \`hearth playtest <name>\` and \`hearth run <scene> --frames 120 --json\`
  (run reports include \`audioEvents\` for checking sound behavior).
- \`hearth create sound <name> --preset coin\` makes procedural sound effects;
  \`hearth export web [--single-file] [--zip]\` makes a playable web build (needs build permission).
- Never delete assets/scenes without being asked.
`;
}

export function generateAgentConfig(projectName: string, projectId: string) {
  return {
    hearthVersion: HEARTH_VERSION,
    project: projectName,
    projectId,
    instructions: 'AGENTS.md',
    cli: {
      binary: 'hearth',
      jsonFlag: '--json',
      recommendedFirstCommands: [
        'hearth inspect project --json',
        'hearth inspect scenes --json',
        'hearth validate --json',
      ],
    },
    mcp: {
      server: 'hearth-mcp',
      transport: 'stdio',
      note: 'Start with: hearth-mcp --project <this directory> [--mode read-only|safe-edit|code-edit|asset-edit|build|all]',
    },
    permissions: {
      defaultModes: ['read-only', 'safe-edit', 'code-edit', 'asset-edit'],
      buildRequiresOptIn: true,
    },
  };
}
