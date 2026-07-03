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
- macOS builds are **ad-hoc signed, not notarized** (no Apple Developer ID
  yet; an afterPack hook re-signs with `codesign -s -` so the bundle's
  signature is valid). First launch of a downloaded build: right-click →
  Open. If macOS claims the app "is damaged and can't be opened" (Gatekeeper
  quarantine + unidentified developer on some versions), clear the
  quarantine flag and open normally:
  `xattr -cr /Applications/Hearth.app`.
  Real Developer ID signing + notarization is on the roadmap and removes
  all of this.
- The app icon is the stock Electron icon for now (custom icon on the
  roadmap — drop icons into `buildResources/` and remove `identity: null`
  when signing).
- Windows (`nsis`, `zip`) and Linux (`AppImage`, `deb`) targets are
  configured in `apps/editor/package.json` → `build`; build them on the
  matching OS or in CI.

## Real signing & notarization (removing the warnings entirely)

Release builds sign automatically once these GitHub Actions secrets exist —
no workflow changes needed:

| Platform | What to get | Secrets to set |
| --- | --- | --- |
| macOS | Apple Developer Program ($99/yr) → create a **Developer ID Application** certificate in Xcode/developer.apple.com, export as .p12; generate an app-specific password at appleid.apple.com | `MAC_CSC_LINK` (the .p12, base64: `base64 -i cert.p12 \| pbcopy`), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | Any Authenticode cert. Cheapest modern route: **Azure Trusted Signing** (~$10/mo); classic route: an OV .pfx from a CA (SmartScreen trust builds with downloads) | `WIN_CSC_LINK` (base64 .pfx), `WIN_CSC_KEY_PASSWORD` |

With the macOS secrets present the workflow signs with hardened runtime
(entitlements in `buildResources/entitlements.mac.plist`) and notarizes —
downloads then open with **zero** warnings, no right-click, no xattr. Without
them it falls back to the current ad-hoc signing. Linux needs nothing.

## Window model

The desktop app behaves like Godot: it opens as a compact **project
manager** window (create/open/recents/examples); opening a project grows the
same window into the full editor (maximized) and titles it after the
project; closing the project shrinks back to the manager. Browser mode is a
single full-page app.

## Smoke-testing headlessly

`HEARTH_SMOKE=1` makes the app boot, verify `/api/meta` through the real
in-process server, print what the window loaded, and exit 0 — used by CI and
handy after packaging changes:

```bash
HEARTH_SMOKE=1 ./apps/editor/release/mac-arm64/Hearth.app/Contents/MacOS/Hearth
```
