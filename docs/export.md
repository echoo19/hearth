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
| `index.html` | Themed loading page that fetches the bundle and boots the player |
| `hearth-player.js` | The runtime + renderer as one IIFE (`window.HearthPlayer`) |
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

## The click-to-start screen

Every export shows a "Click to start" screen before the game runs. This is
deliberate: browsers block audio until the page gets a user gesture, so
the starting click is what lets `AudioSource` autoplay and
`ctx.audio.play` actually make sound. The player then runs the project's
initial scene, letterbox-scaled to the window, with a fullscreen button in
the corner.

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
