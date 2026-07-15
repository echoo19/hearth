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
project server is Node (it reuses `@hearth/core/node` and the whole command
layer directly) and Tauri has no Node runtime, so it would need the server
rewritten in Rust or shipped as a sidecar. Electron's main process **is**
Node, so the same `createProjectServerContext()` that powers the Vite dev
server runs in-process, unchanged. One server implementation, three modes.

How it works: the main process starts a loopback-only `node:http` server on a
random port serving the built UI + the `/api` routes, and the window loads
`http://127.0.0.1:<port>`. The renderer is byte-identical to browser mode.
Everything is bundled by esbuild/vite (`dist-electron/main.cjs` is
self-contained), so the packaged app ships **zero node_modules**.

## Working from folders (Godot/Unity style)

A Hearth project is just a folder with `hearth.json` in it. In the desktop
app the launcher has native pickers:

- **Open Folder…**: a system dialog; choose any project folder on disk.
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
  signature is valid). First launch of a downloaded build on **macOS 15
  Sequoia or later**: Gatekeeper says "Apple could not verify 'Hearth' is
  free of malware" and only offers Move to Trash / Done. The old
  right-click → Open bypass no longer works there. Click **Done** (not
  Move to Trash), open **System Settings → Privacy & Security**, scroll
  down to the **"'Hearth' was blocked"** row, click **Open Anyway**, and
  confirm once. On macOS 14 and earlier, right-click → Open still works.
  If macOS instead claims the app "is damaged and can't be opened", clear
  the quarantine flag and open normally:
  `xattr -cr /Applications/Hearth.app`.
  Real Developer ID signing + notarization is on the roadmap and removes
  all of this.
- The app icon is the stock Electron icon for now. A custom icon is on the
  roadmap: drop icons into `buildResources/` and remove `identity: null`
  when signing.
- Windows (`nsis`, `zip`) and Linux (`AppImage`, `deb`) targets are
  configured in `apps/editor/package.json` → `build`; build them on the
  matching OS or in CI.

## Dependency audit posture

`npm audit --omit=dev`: **0 vulnerabilities.** Nothing that ships in the
packaged app (or in an exported game) carries a known advisory.

`npm audit` (full, including dev tooling): **11 advisories** (1 moderate, 10
high), all in the packaging toolchain: `electron` (bundled dev version
33.x, fix requires 43.x), `electron-builder` (25.x → 26.x) and its
`app-builder-lib`/`dmg-builder`/`tar` dependency chain, and `esbuild` (0.24.x
→ 0.28.x, used by Vite/vitest, not shipped). Every fix `npm audit fix
--force` offers is a breaking major bump, and none of the flagged code paths
run in the built app: Electron's advisories are renderer/IPC bugs in
Chromium versions this project isn't shipping, and esbuild's is a dev-server
CORS issue that doesn't exist once `dist/` is built. Consciously deferred
rather than force-bumped mid-wave; revisit alongside the next toolchain
upgrade (Electron majors land every few months and tend to want a coordinated
bump of `electron-builder` alongside them).

## Real signing & notarization (removing the warnings entirely)

This section is about signing **the Hearth editor app itself** (the
`.dmg`/`.exe`/`.AppImage` you'd distribute from this repo's releases) via
`electron-builder` and CI secrets, a separate pipeline from signing *games
made with Hearth*, which `hearth export desktop` handles with its own,
differently-named environment variables (`HEARTH_MAC_IDENTITY` and
friends) read locally at export time; see
[export.md#signing-macos-only](./export.md#signing-macos-only).

Release builds sign automatically once these GitHub Actions secrets exist;
the workflow itself doesn't need to change:

| Platform | What to get | Secrets to set |
| --- | --- | --- |
| macOS | Apple Developer Program ($99/yr) → create a **Developer ID Application** certificate in Xcode/developer.apple.com, export as .p12; generate an app-specific password at appleid.apple.com | `MAC_CSC_LINK` (the .p12, base64: `base64 -i cert.p12 \| pbcopy`), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | Any Authenticode cert. Cheapest modern route: **Azure Trusted Signing** (~$10/mo); classic route: an OV .pfx from a CA (SmartScreen trust builds with downloads) | `WIN_CSC_LINK` (base64 .pfx), `WIN_CSC_KEY_PASSWORD` |

With the macOS secrets present the workflow signs with hardened runtime
(entitlements in `buildResources/entitlements.mac.plist`) and notarizes.
Downloads then open with **zero** warnings and none of the Open Anyway or
xattr workarounds. Without them it falls back to the current ad-hoc signing.
Linux needs nothing.

## Window model

The desktop app behaves like Godot: it opens as a compact **project
manager** window (create/open/recents/examples); opening a project grows the
same window into the full editor (maximized) and titles it after the
project; closing the project shrinks back to the manager. Browser mode is a
single full-page app.

## Smoke-testing headlessly

`HEARTH_SMOKE=1` makes the app boot, verify `/api/meta` through the real
in-process server, print what the window loaded, and exit 0. CI uses it, and
it's handy after packaging changes:

```bash
HEARTH_SMOKE=1 ./apps/editor/release/mac-arm64/Hearth.app/Contents/MacOS/Hearth
```
