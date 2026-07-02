# Hearth Roadmap

v0.1.0 is the first public developer preview: the full human+agent loop works
end to end (editor ⇄ command system ⇄ CLI/MCP ⇄ runtime ⇄ playtests ⇄ diff
review). This page is the honest list of what's next and what's deliberately
missing.

## Near term (v0.2)

- **Screenshot capture for agents** — `hearth screenshot <scene>` rendering
  via the Pixi renderer in a headless browser context; agents can *see* their
  work.
- **Undo/redo in the editor** (command journal; the diff baseline already
  proves the model).
- **Sprite animation playback** — animation assets exist; the runtime needs
  an Animator behavior + SpriteRenderer frame swapping.
- **Audio playback** — `AudioSource` is schema-complete; wire Web Audio in
  the Pixi host (marked experimental in the editor until then).
- **Drag-to-reparent in the hierarchy panel**; multi-select.
- **Better collision** — circle-accurate resolution, one-way platforms,
  collision layers/masks.

## Medium term

- **Standalone web export** — bundle runtime + project into a static site
  (`buildProject` currently exports a validated portable project folder).
- **Desktop polish** — signed/notarized builds, custom app icon, auto-update.
  (Electron packaging works today — `npm run app:dist`; the Tauri shell
  remains an experimental alternative pending a Rust sidecar for the
  project server.)
- **TypeScript scripts** with a compile step and typed `ctx`.
- **Multi-instance components** (array form, `formatVersion: 2`).
- **Asset pipeline v2** — spritesheets, imported image slicing, tile
  autotiling, font assets.
- **MCP resources** — expose scenes/scripts as MCP resources (today:
  tools-only, which every client supports).
- **Prefabs** — reusable entity templates with overrides.

## Long term / research

- Multiplayer-friendly deterministic core (already fixed-timestep; needs
  input serialization + rollback investigation).
- Visual scripting that round-trips to the same command system.
- Agent-facing "explain this scene" summaries (structured scene semantics,
  not screenshots).
- Plugin/component SDK for third-party components with schema registration.

## Non-goals (for now)

- Competing with Unity/Godot on 3D, shaders, or console targets.
- Built-in AI/LLM API calls — agents connect **from outside** via MCP/CLI.
  The engine stays model-agnostic and fully usable offline.
- Cloud project storage. Projects are local files; use git.
