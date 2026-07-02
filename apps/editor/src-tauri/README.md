# Hearth editor — Tauri shell

This directory is a minimal Tauri v2 shell around the web editor. **For v0.1
the supported way to run the editor is the browser/dev mode**:

```bash
npm run dev -w @hearth/editor   # then open http://localhost:5173
```

The web editor works without Tauri because all filesystem/project access goes
through the Vite dev server's project-server plugin
(`apps/editor/server/projectServer.ts`), which serves the `/api/*` routes.

## Desktop packaging (roadmap)

To build a desktop app you need:

1. A Rust toolchain (`rustup`), plus the platform WebView dependencies
   ([tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)).
2. The Tauri CLI in the workspace: `npm i -D @tauri-apps/cli` (deliberately
   not a default dependency).
3. **Icons** — not checked in. Generate them from a 1024×1024 source image:
   `npx tauri icon path/to/icon.png`, then set `bundle.icon` in
   `tauri.conf.json` and flip `bundle.active` to `true`.
4. **The project server as a sidecar** — in dev, Tauri's `devUrl` points at
   the Vite dev server, so the `/api` routes exist. A packaged app has no Vite
   dev server; the project server must run as a Node sidecar process (or be
   ported to Rust commands). This is on the roadmap and the main reason
   browser/dev mode is the supported path for v0.1.

Then: `npx tauri dev` (development) or `npx tauri build` (packaging).
