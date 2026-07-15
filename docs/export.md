# Export

Hearth ships two ways: `hearth export web` turns a project into a static,
self-contained playable build: open `index.html` and the game runs. No
server, no external requests, no build tools on the player's machine.
`hearth export desktop` wraps that same build in a native Electron shell
and zips one packaged app per platform. Both require the `build` permission
(`--allow build` or `--allow all` on the CLI; `--mode all` on the MCP
server, where the tools are `export_web`/`export_desktop`). For uploading
either kind of output to itch.io, see
[shipping-to-itch.md](./shipping-to-itch.md).

## Web export

```bash
hearth export web                     # folder build → export/web/
hearth export web --single-file      # one self-contained index.html
hearth export web --zip              # also writes <project-slug>-web.zip
hearth export web --out dist/game    # different (project-relative) folder
```

The project is validated first; an export with validation errors fails
before writing anything.

### Folder build (default)

`export/web/` contains:

| File | What it is |
| --- | --- |
| `index.html` | Boot page (titled from `buildSettings.title`) that fetches the bundle and starts the player |
| `hearth-player.js` | The runtime + renderer (including the Lua engine) as one IIFE (`window.HearthPlayer`) |
| `project.bundle.json` | Project manifest, all scenes, all script sources |
| `assets/` | A copy of the project's asset files (SVGs, WAVs, imports) |

Host it on any static file server. Because `index.html` fetches
`project.bundle.json`, opening it from `file://` is blocked by browser
fetch restrictions. Use the single-file build for that, or a local server
(`npx serve export/web`).

### Single file (`--single-file`)

One `index.html` with the player inlined and every asset embedded as a
data URI. Bigger file, zero requests; works from `file://`, mail
attachments, and anywhere you can paste one HTML file.

### Zip for itch.io (`--zip`)

`--zip` also writes `<project-slug>-web.zip` next to the output
folder, with `index.html` at the zip root: exactly what itch.io's "HTML
playable in browser" upload expects. Upload the zip, check "This file will
be played in the browser", done. The MCP `export_web` tool takes the same
flag as `zip: true`, and the editor's Export dialog has a "Zip for itch.io"
checkbox on the Web target. See [shipping-to-itch.md](./shipping-to-itch.md)
for the full upload walkthrough.

### No engine chrome

Exported games boot **straight into the project's initial scene**:
no Hearth start screen, no branding, nothing a player can see that you
didn't put there. The game renders letterbox-scaled to the window.

Want a start screen or menu? Build it as a scene: `Text`, an interactive
`UIElement` button, and `ctx.scenes.load("Level")` in its `onUiEvent`
hook. The `ember-trail` example ships exactly that pattern; see
[scripting.md](./scripting.md#building-a-start-screen--menu).

#### Loading visuals (`buildSettings.loading`)

While the bundle and assets load, the player shows only what you
configure in `buildSettings.loading`. Set it with the `updateSettings`
command (no hand-editing of `hearth.json` needed):

| Setting | Default | Meaning |
| --- | --- | --- |
| `backgroundColor` | `#000000` | Page + loading background color |
| `image` | `null` | Sprite asset id shown centered while loading |
| `spinner` | `false` | Minimal neutral spinner (a small monochrome ring, no text, no logo) |

The `index.html` page background matches `backgroundColor`, and the
loading image asset is always included in the bundle even if no scene
references it.

#### Debug overlay

Exported games never show the collider/velocity/light debug overlay,
matching the no-chrome rule above: `PixiViewOptions.debugDraw` defaults to
`false`, and the export template's own `HearthPlayer.boot({ mount, bundle })`
call never sets it, so there is no flag to accidentally leave on in a
shipped build. The overlay only exists for local iteration: the editor's
preview toolbar (**Debug** button, off by default) and `hearth screenshot
--debug` (see [cli.md](./cli.md#command-tour)), both of which start a
fresh session each time rather than mutating the exported artifact.

#### Audio unlock

Browsers block audio until the page receives a user gesture. The player
handles this **silently**: the audio context is created up front and, if
suspended, resumes on the first natural input (pointer, key, or touch).
Music that started while suspended begins playing from the start on
unlock; stale one-shot sound effects are dropped rather than burst all at
once. No overlay, no "click to enable sound" UI.

### Troubleshooting: `MISSING_RESOURCE`

The export embeds a prebuilt player bundle. If the command fails with
`MISSING_RESOURCE`, the host couldn't find `hearth-player.js`:

- **Repo checkout**: the player is built into
  `packages/runtime/player/hearth-player.js` by the runtime's build step.
  Run `npm run build:packages` (or `npm run build -w @hearth/runtime`).
- **Packaged app / standalone tools**: the player ships next to the CLI;
  the `HEARTH_TOOLS_DIR` environment variable must point at the directory
  containing `hearth-player.js`.

The error message names the exact locations it checked.

## Desktop export (Electron)

`hearth export desktop` wraps the same build the web export produces in a
minimal, hardened Electron shell and packages one native app per platform:

```bash
hearth export desktop --allow build                              # all four platforms → export/desktop/
hearth export desktop --platform darwin-arm64 --allow build      # one platform
hearth export desktop --platform darwin-arm64 --platform win32-x64 --allow build  # --platform repeats
hearth export desktop --out dist/desktop --allow build           # different (project-relative) folder
```

`--platform` is repeatable and validated against exactly four ids:
`darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`. Passing an unknown
id fails with `INVALID_INPUT` and lists the valid ones; omit `--platform`
entirely and all four are built. The project is validated first, same gate
as `export web`: an export with validation errors fails before writing
anything. This is a different thing from *packaging the Hearth editor
itself* as a desktop app; see [desktop-app.md](./desktop-app.md) for that.

Output: one directory per platform (`export/desktop/<platform>/`, the
packaged, unzipped app, useful for local testing) plus one zip per
platform next to them, named `<project-slug>-<platform>.zip` (e.g.
`ember_horde-win32-x64.zip`), ready to upload as separate itch.io channels,
see [shipping-to-itch.md](./shipping-to-itch.md). The MCP tool is
`export_desktop`; the editor's Export dialog has a Web/Desktop segmented
control with a Desktop pane (platform checkboxes, output dir, a live
per-platform progress stream, and per-build zip paths with a copy button).

### What's in the app

The window opens at `buildSettings.width`×`buildSettings.height`, titled
from `buildSettings.title` (falling back to the project name when empty,
same fallback the web player uses). The Electron main process is generated
fresh per export and hardened: `contextIsolation: true`, `nodeIntegration:
false`, no preload script, no remote content: the window only ever loads
the exported `index.html`, and both in-page navigation and
window-open attempts to anything else are denied outright. F11 and
Cmd/Ctrl+F toggle full screen; the app quits when its one window closes.

### App icon (`buildSettings.icon`)

Set `buildSettings.icon` to a sprite asset id (`hearth set-settings
--build-settings '{"icon":"ast_x"}'`, MCP `update_settings`, or the
editor's **Game Settings** panel, see below) and desktop exports use it as
the app icon, converted to `.icns` (macOS) and `.ico` (Windows/Linux gets
the source PNG) with a pure-JS converter. Default is `null`, which ships
the bundled default Hearth icon. Icon conversion is best-effort: a
non-sprite asset id is a structured error before packaging starts, but a
decode failure on an otherwise-valid PNG falls back to the default icon
with a warning rather than failing the whole export.

### First run: Electron download

`@electron/packager` downloads the target platform's Electron prebuilt on
first use (one file per platform, roughly 100MB) and caches it afterward
(the packager's standard cache directory, `~/Library/Caches/electron` on
macOS). Building all four platforms the first time downloads up to four of
these; every export after that reuses the cache and is fast. Progress
prints to stderr per platform (`stage` → `download` → `package` → `sign` →
`zip`), so `--json` stdout stays clean.

### Signing (macOS only)

| Environment | Result |
| --- | --- |
| (none) | Ad-hoc `codesign --force --deep -s -`. If codesign itself fails (e.g. running on a non-Mac host), the export still succeeds, unsigned (`signed: "none"`), never a hard failure. |
| `HEARTH_MAC_IDENTITY` | Real signing with that identity. A signing failure here **is** a hard error: you asked for a specific identity. |
| `HEARTH_MAC_IDENTITY` + `HEARTH_APPLE_ID` + `HEARTH_APPLE_PASSWORD` + `HEARTH_TEAM_ID` | Also notarizes (`xcrun notarytool submit --wait`) and staples the ticket. Failure is a hard error. |

Each build's result reports its `signed` state (`"adhoc"` / `"identity"` /
`"none"`) and `notarized` boolean. The CLI prints it inline, the editor
shows a signing status line read from `GET /api/export/capability` before
you export. Windows and Linux builds are never signed this release; treat
them as unsigned artifacts (Windows will show a SmartScreen warning until
you sign with your own Authenticode certificate; that wiring isn't built
yet; see the [roadmap](./roadmap.md)).

### Honest verification limits

Electron packaging is cross-platform (you can package a Windows or Linux
build from a Mac), but only ever **executed** on the platform that produced
it in Hearth's own CI and testing. A win32/linux zip packaged from a macOS
host is **packaging-verified**: the app directory structure and zip
contents are correct, but **not execution-verified**: nobody has actually
launched that build. If you're shipping to a platform you can't run
yourself, do at least one manual smoke test on real hardware (or a VM)
before publishing.

If a platform's build fails partway (most commonly a hard signing failure),
the whole `export desktop` call fails: platforms already built in that
call are not returned, and no builds from earlier in the same call are
zipped. Re-run after fixing the cause; already-produced platforms are cheap
to rebuild since Electron itself is cached.

### Editor Game Settings panel

The editor's **Game Settings** panel (a dockview panel next to Input) is
the typed UI over every `buildSettings` field, in four sections: **Window**
(title, width, height, background color), **Loop** (target FPS, fixed
timestep), **Loading** (the loading-screen fields above), and **Shipping**
(the icon picker, with a thumbnail preview and a "Used as the desktop app
icon" hint). Every edit is a normal `updateSettings` call carrying only the
changed field, so undo, the command journal, and live-patch all work
exactly like every other editor control. There's no raw JSON to hand-edit.

## Choosing web, desktop, or `build`

`hearth build` still exists: it writes a validated, portable copy of the
*project* (for handing off source, not for playing). For something people
can play in a browser, use `export web`; for a native app someone
double-clicks, use `export desktop`.
