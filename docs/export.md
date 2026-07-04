# Web Export

`hearth export web` turns a project into a static, self-contained playable
build — open `index.html` and the game runs. No server, no external
requests, no build tools on the player's machine. Export requires the
`build` permission (`--allow build` or `--allow all` on the CLI; `--mode
all` on the MCP server, where the tool is `export_web`).

```bash
hearth export web                     # folder build → export/web/
hearth export web --single-file      # one self-contained index.html
hearth export web --zip              # also writes <project-slug>-web.zip
hearth export web --out dist/game    # different (project-relative) folder
```

The project is validated first; an export with validation errors fails
before writing anything.

## Folder build (default)

`export/web/` contains:

| File | What it is |
| --- | --- |
| `index.html` | Boot page (titled from `buildSettings.title`) that fetches the bundle and starts the player |
| `hearth-player.js` | The runtime + renderer (including the Lua engine) as one IIFE (`window.HearthPlayer`) |
| `project.bundle.json` | Project manifest, all scenes, all script sources |
| `assets/` | A copy of the project's asset files (SVGs, WAVs, imports) |

Host it on any static file server. Because `index.html` fetches
`project.bundle.json`, opening it from `file://` is blocked by browser
fetch restrictions — use the single-file build for that, or a local server
(`npx serve export/web`).

## Single file (`--single-file`)

One `index.html` with the player inlined and every asset embedded as a
data URI. Bigger file, zero requests; works from `file://`, mail
attachments, and anywhere you can paste one HTML file.

## Zip for itch.io (`--zip`)

`--zip` additionally writes `<project-slug>-web.zip` next to the output
folder, with `index.html` at the zip root — exactly what itch.io's "HTML
playable in browser" upload expects. Upload the zip, check "This file will
be played in the browser", done.

## No engine chrome

Exported games boot **straight into the project's initial scene** —
no Hearth start screen, no branding, nothing a player can see that you
didn't put there. The game renders letterbox-scaled to the window.

Want a start screen or menu? Build it as a scene: `Text`, an interactive
`UIElement` button, and `ctx.scenes.load("Level")` in its `onUiEvent`
hook. The `ember-trail` example ships exactly that pattern; see
[scripting.md](./scripting.md#building-a-start-screen--menu).

### Loading visuals (`buildSettings.loading`)

While the bundle and assets load, the player shows only what you
configure in `buildSettings.loading` — set it with the `updateSettings`
command (no hand-editing of `hearth.json` needed):

| Setting | Default | Meaning |
| --- | --- | --- |
| `backgroundColor` | `#000000` | Page + loading background color |
| `image` | `null` | Sprite asset id shown centered while loading |
| `spinner` | `false` | Minimal neutral spinner (a small monochrome ring — no text, no logo) |

The `index.html` page background matches `backgroundColor`, and the
loading image asset is always included in the bundle even if no scene
references it.

### Debug overlay

Exported games never show the collider/velocity/light debug overlay,
matching the no-chrome rule above: `PixiViewOptions.debugDraw` defaults to
`false`, and the export template's own `HearthPlayer.boot({ mount, bundle })`
call never sets it, so there is no flag to accidentally leave on in a
shipped build. The overlay only exists for local iteration — the editor's
preview toolbar (**Debug** button, off by default) and `hearth screenshot
--debug` (see [cli.md](./cli.md#command-tour)) — both of which start a
fresh session each time rather than mutating the exported artifact.

### Audio unlock

Browsers block audio until the page receives a user gesture. The player
handles this **silently**: the audio context is created up front and, if
suspended, resumes on the first natural input (pointer, key, or touch).
Music that started while suspended begins playing from the start on
unlock; stale one-shot sound effects are dropped rather than burst all at
once. No overlay, no "click to enable sound" UI.

## Troubleshooting: `MISSING_RESOURCE`

The export embeds a prebuilt player bundle. If the command fails with
`MISSING_RESOURCE`, the host couldn't find `hearth-player.js`:

- **Repo checkout**: the player is built into
  `packages/runtime/player/hearth-player.js` by the runtime's build step —
  run `npm run build:packages` (or `npm run build -w @hearth/runtime`).
- **Packaged app / standalone tools**: the player ships next to the CLI;
  the `HEARTH_TOOLS_DIR` environment variable must point at the directory
  containing `hearth-player.js`.

The error message names the exact locations it checked.

## `export web` vs `build`

`hearth build` still exists: it writes a validated, portable copy of the
*project* (for handing off source, not for playing). For something people
can play in a browser, use `export web`.
