# The Hearth Desktop App

Hearth runs three ways; all use the exact same UI and project server code:

| Mode | Command | Best for |
| --- | --- | --- |
| Browser (dev) | `npm run dev` → http://localhost:5173 | Development, contributions |
| Desktop (local) | `npm run app` | Daily use from a repo checkout |
| Desktop (packaged) | `npm run app:dist` → `apps/editor/release/…/Hearth.app` | Installing like a normal app |

## Why Electron (and where Tauri stands)

The original plan was Tauri, and a Tauri shell still lives in
`apps/editor/src-tauri/` as an experimental alternative. The blocker: Hearth's
project server is Node — it reuses `@hearth/core/node` and the whole command
layer directly — and Tauri has no Node runtime, so it would need the server
rewritten in Rust or shipped as a sidecar. Electron's main process **is**
Node, so the same `createProjectServerContext()` that powers the Vite dev
server runs in-process, unchanged. One server implementation, three modes.

How it works: the main process starts a loopback-only `node:http` server on a
random port serving the built UI + the `/api` routes, and the window loads
`http://127.0.0.1:<port>` — the renderer is byte-identical to browser mode.
Everything is bundled by esbuild/vite (`dist-electron/main.cjs` is
self-contained), so the packaged app ships **zero node_modules**.

## Working from folders (Godot/Unity style)

A Hearth project is just a folder with `hearth.json` in it. In the desktop
app the launcher has native pickers:

- **Open Folder…** — a system dialog; choose any project folder on disk.
- **Browse…** next to the new-project location field.
- Recent projects are remembered in `~/.hearth/recent-projects.json`.

In browser mode the same launcher accepts typed/pasted paths (browsers can't
show native folder pickers for server-side paths).

## Building the app

```bash
npm install && npm run build:packages

npm run app          # build UI + main, launch Electron directly
npm run app:dist     # + electron-builder → apps/editor/release/mac-arm64/Hearth.app
npm run app:dist:installers -w @hearth/editor   # dmg/nsis/AppImage installers
```

Notes:
- macOS builds are unsigned in v0.1 (`identity: null`) — Gatekeeper may
  require right-click → Open the first time. Set up signing before
  distributing.
- The app icon is the stock Electron icon for now (custom icon on the
  roadmap — drop icons into `buildResources/` and remove `identity: null`
  when signing).
- Windows (`nsis`, `zip`) and Linux (`AppImage`, `deb`) targets are
  configured in `apps/editor/package.json` → `build`; build them on the
  matching OS or in CI.

## Smoke-testing headlessly

`HEARTH_SMOKE=1` makes the app boot, verify `/api/meta` through the real
in-process server, print what the window loaded, and exit 0 — used by CI and
handy after packaging changes:

```bash
HEARTH_SMOKE=1 ./apps/editor/release/mac-arm64/Hearth.app/Contents/MacOS/Hearth
```
