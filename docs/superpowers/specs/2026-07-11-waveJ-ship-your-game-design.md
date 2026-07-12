# Wave J — Ship Your Game (v0.13) — Design

**Date:** 2026-07-11
**Status:** Approved by Jake (Electron; ad-hoc signing + env hooks; 3–4 genre
starter templates; 3-platform zipped output)
**Baseline:** v0.12.0 — 70 registry commands, 67 MCP tools, `exportWeb`
static web builds, `hearth init` blank projects, editor `ExportDialog` (web
only) and `Launcher` (blank create only).

## Goal

Exports stop being web-only. A finished Hearth project becomes a
distributable game — desktop apps for macOS/Windows/Linux and an
itch.io-ready web zip — and a new project starts from a playable genre
skeleton instead of an empty scene. Everything works identically for users
(editor, CLI) and agents (CLI, MCP).

## Pillar 1 — Desktop export (Electron)

### Command surface
New registry command `exportDesktop` (**70 → 71 commands**):

```
exportDesktop {
  outDir?: string        // project-relative, default "export/desktop"
  platforms?: ("darwin-arm64"|"darwin-x64"|"win32-x64"|"linux-x64")[]
                         // default: all four
}
→ { outDir, slug, builds: [{ platform, appDir, zip, signed: "adhoc"|"identity"|"none", notarized: boolean }] }
```

Core stays browser-safe. `exportDesktop` in
`packages/core/src/commands/exportCommands.ts`:
1. Runs `validateProject` (same gate as `exportWeb`; errors abort).
2. Builds the same in-memory `WebExportBundle` + static file set `exportWeb`
   produces (refactor the bundle/file-set assembly into a shared internal
   helper so the two commands cannot drift).
3. Delegates to a new host resource
   `ctx.resources.packageDesktop(spec) → Promise<DesktopBuildResult[]>`.
   If the host does not provide it, fail with a clear
   `DESKTOP_EXPORT_UNSUPPORTED` error naming which hosts support it.
4. Journals a details-only entry (non-mutating command — no undo bucket),
   consistent with `exportWeb`.

### `@hearth/shipping` package (new, Node-only)
`packages/shipping` — the single implementation all three hosts wire in
(CLI, MCP server, editor server). Never imported by `@hearth/core` or any
browser bundle. Responsibilities:

- **Electron shell generation.** A minimal, hardened main process written
  as a template: single `BrowserWindow` sized from
  `project.buildSettings.width/height` (defaults 800×600), `contextIsolation:
  true`, `nodeIntegration: false`, no preload, no remote content, F11 /
  Cmd-Ctrl-F fullscreen toggle, quit on last window closed. Loads the
  exported `index.html` from the app's resources.
- **Packaging** via `@electron/packager`: darwin-arm64, darwin-x64,
  win32-x64, linux-x64. Electron prebuilts download on first use and cache
  (packager's standard cache); surface download progress through a
  caller-provided progress callback (CLI prints it, editor streams it).
- **Icon**: `buildSettings` gains `icon: string | null` (sprite asset id,
  default `null`), mirroring the existing `loading.image` pattern —
  editable in the editor settings UI (typed asset picker), `set-settings`
  CLI, and MCP. When set, `@hearth/shipping` converts the PNG to
  `.icns`/`.ico` with a pure-JS converter (`png2icons`); when null, use the
  bundled Hearth default icon. This is the wave's only new settings field.
- **Zipping**: one zip per platform named `<slug>-<platform>.zip` beside the
  app dirs (e.g. `ember-horde-darwin-arm64.zip`). The existing CLI
  `zipExportedDir` helper moves into this package as `zipDirectory` and the
  CLI re-uses it (single zip implementation for web + desktop).
- **Signing** (see Pillar 2).

App/window name: `buildSettings.title`, falling back to `project.name` when
empty (same fallback the web player uses). Bundle id: `com.hearth.<slug>`,
not overridable this wave.

### Host wiring (parity)
- **CLI**: `hearth export desktop [--out <dir>] [--platform <p>...]`
  (repeatable `--platform`; guarded by `--allow build` like `export web`).
- **MCP**: `exportDesktop` tool (**67 → 68 tools**).
- **Editor server**: route invoked by the Export dialog, streaming progress
  events over the existing ws channel.

### Honest verification limits
Cross-packaged win32/linux artifacts from a macOS host are
packaging-verified (structure, zip contents) but not execution-verified.
Docs state this plainly. CI executes only the host platform's packaged app
(headless boot smoke test); other platforms are structure-asserted.

## Pillar 2 — Signing (ad-hoc + hooks)

All signing lives in `@hearth/shipping`, macOS only this wave:

- **Default (no env)**: ad-hoc `codesign --force --deep -s -` on the
  packaged `.app`. If codesign fails (e.g. non-mac host), fall back to
  unsigned with a warning in the result (`signed: "none"`); never a hard
  error.
- **`HEARTH_MAC_IDENTITY`** set: real signing with that identity. Failure is
  a hard error (the user asked for it).
- **`HEARTH_APPLE_ID` + `HEARTH_APPLE_PASSWORD` + `HEARTH_TEAM_ID`** set (in
  addition to identity): notarize the zipped app with `xcrun notarytool
  submit --wait` and staple. Failure is a hard error.
- Windows/Linux: unsigned; the docs guide explains Authenticode/signing
  options for later. No wiring.
- Signing state is reported per-build in the command result and surfaced in
  the CLI output and Export dialog.

## Pillar 3 — itch.io-ready web parity

`export web --zip` exists in the CLI only. Close the gap:

- `exportWeb` result keeps its shape; the **zip step stays host-side**
  (core cannot zip) but moves to `@hearth/shipping`'s `zipDirectory`.
- **MCP** `exportWeb` tool gains `zip?: boolean`.
- **Editor Export dialog** gains a "zip for itch.io" checkbox for web
  exports (replaces the current text hint pointing at the CLI).
- Zip layout: `index.html` at the zip root (itch.io's requirement) — the
  existing `zipExportedDir` behavior, now covered by a test.
- New docs guide **"Shipping to itch.io"**: web upload (zip, viewport =
  buildSettings dimensions), desktop uploads (one zip per platform, channel
  naming), butler as a documented manual step (no butler wrapping).

## Pillar 4 — Project templates

`hearth init <name> --template blank|platformer|topdown|arcade` (default
`blank` = current behavior).

- **`packages/templates`** (new workspace package, data + generator):
  `generate.mjs` produces each template as a complete valid project folder
  (checked in), following the examples generator pattern and reusing its
  pixel-art asset helpers where sensible. Each genre template is a **small
  playable skeleton, not a demo game**: one scene, player entity with input
  + movement script (commented as a teaching surface), camera (follow where
  the genre wants it), a few placed tiles/obstacles, one playtest asserting
  the player can move. Genre specifics:
  - *platformer*: gravity + jump, small autotiled ground strip.
  - *topdown*: 4-direction movement, camera follow, small autotiled room.
  - *arcade*: fixed camera, ship + shoot-on-key, one spawned target prefab.
- Templates embed `hearthVersion` → they join the **same-commit regeneration
  rule** with examples on every version bump, and the CI clean-tree gate
  covers `packages/templates` output.
- **Resolution**: hosts locate template data like the player bundle —
  `$HEARTH_TOOLS_DIR/templates/<name>` (packaged app) or
  `packages/templates/templates/<name>` (repo checkout) — via a
  `getTemplate(name)` / `listTemplates()` API exported by
  `packages/templates`' small runtime entry (Node-only, used by CLI and
  editor server).
- **CLI**: `hearth init <name> --template <t>`; `--template` with an unknown
  name lists available templates in the error. `hearth init --list-templates`
  prints them.
- **Editor**: `Launcher.tsx` create form gains a template picker (cards with
  name + one-line description + tiny genre glyph; `blank` first,
  preselected). Wired through the existing editor-server createProject route
  (route gains `template?` param).
- **MCP/agents**: init is pre-project so no registry command; agents use the
  CLI. AGENTS.md documents the template names and when to pick each.
- Template application = copy template dir → rewrite project name/slug in
  `project.json` → normal open. Copied projects must pass `validate` and
  their playtest must pass.

## Pillar 5 — Editor export UI

Extend `ExportDialog.tsx` (design under the `impeccable` skill; typed
controls, no raw JSON):

- Target segmented control: **Web / Desktop**.
- Web: existing options + the new zip checkbox.
- Desktop: platform checkboxes (all four preselected), output dir, signing
  status line (reads env-derived capability from the server: "ad-hoc" /
  identity name / "will notarize"), and a streamed progress area (Electron
  download → package → sign → zip per platform) fed by ws events. Errors
  render per-platform, not as one blob.
- On success: per-build rows with reveal-in-Finder buttons and the zip
  paths.

## Cross-cutting requirements

- **Counts**: 71 registry commands, 68 MCP tools; every doc/website
  reference to counts updates in the docs pass.
- **Parity**: every new capability reachable by editor UI, CLI, and MCP
  (except pre-project `init`, which is CLI + editor Launcher).
- **Live-patch**: `exportDesktop`/`exportWeb` are non-mutating → both
  live-patch classifiers (`classifyLocal`, `classifyJournal`) map them to
  `none` explicitly (they must not fall into a default-structural bucket).
- **Strict-Zod posture**: all new command payloads/results via zod schemas +
  safeParse at boundaries, matching Wave I conventions.
- **Bundle boundaries**: `@hearth/shipping` and `packages/templates` runtime
  entry are Node-only; no browser bundle may import them (editor imports go
  through server routes only). No non-literal dynamic imports.
- **Docs pass**: export guide (desktop section), new "Shipping to itch.io"
  guide, CLI/MCP references, AGENTS.md (templates + exportDesktop),
  architecture (shipping package), roadmap tick, READMEs.
- **Release**: version bump to 0.13.0 regenerates examples **and templates**
  in the same commit (double-regen proof); tag `v0.13.0`; release asset
  matrix unchanged (templates ship inside the CLI package `files`);
  website update (counts, "ship your game" messaging — **no example/game
  showcase**, per standing rule).

## Testing matrix

| Area | Tests |
|---|---|
| exportDesktop command | validation gate, unsupported-host error, journal details, result shape (zod) |
| shipping: shell | generated main.js contains buildSettings dimensions, hardening flags; no template placeholders left |
| shipping: packaging | mocked `@electron/packager` unit tests (spec construction per platform, icon fallback); one real host-platform package in CI + headless boot smoke |
| shipping: signing | hook resolution table (no env → adhoc, identity → hard-fail on error, notary triple → notarize call), mocked exec |
| shipping: zip | `<slug>-<platform>.zip` naming; web zip has index.html at root |
| templates | each template: schema-valid, `validate` clean, playtest green, hearthVersion matches; generator idempotent (double-regen proof) |
| CLI | `export desktop` flags, `init --template` happy/unknown/list paths |
| MCP | exportDesktop tool + exportWeb zip param, 68-tool boot |
| editor | ExportDialog target switch + progress stream (component tests), Launcher template picker |

## Non-goals (this wave)

- Tauri backend (Electron only; packager interface kept narrow enough to
  add one later).
- Windows/Linux code signing wiring.
- butler/itch.io API integration.
- Mobile export, auto-updaters, installer formats (dmg/msi/deb) — zips only.
- Further settings fields beyond `buildSettings.icon` (no bundle id
  override, no per-platform options).
- Template gallery/marketplace; exactly the four checked-in templates.
