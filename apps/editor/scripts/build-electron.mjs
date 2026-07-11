#!/usr/bin/env node
/**
 * Bundle the Electron main process to dist-electron/main.cjs.
 *
 * Everything (including @hearth/core and the project server) is inlined by
 * esbuild so the packaged app ships no node_modules — only `electron` itself
 * stays external (provided by the Electron runtime).
 */
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');

await mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });

// Lua support in single-file bundles: wasmoon resolves its glue.wasm next to
// its own module via __filename/__dirname, which breaks once esbuild inlines
// it (and __filename doesn't exist in ESM output at all). The inject shim
// inlines the wasm as base64 (loader below) and calls setLuaWasmUri with a
// data: URI before any entry code runs, so every bundle stays one file.
//
// The standalone CLI/MCP tool bundles — AND the Electron main bundle —
// additionally inline the script formatters (StyLua wasm + Prettier).
// @hearth/core loads those via non-literal dynamic imports the bundler can't
// follow, so `hearth script format` (and the packaged app's in-process
// format-on-save) would otherwise fail with no node_modules present. The
// packaged desktop app ships main.cjs with only @lydell/node-pty in
// release-app/node_modules (assemble-app.mjs) — stylua/prettier aren't there —
// so the main bundle needs the shim too, or every editScript/createScript in
// the shipped app breaks. (In dev, real node_modules resolve the imports; the
// shim's setFormatterModules override is harmless there.)
const toolInline = {
  inject: [path.join(here, 'lua-wasm-inline.mjs'), path.join(here, 'format-inline.mjs')],
  loader: { '.wasm': 'base64' },
};

await build({
  entryPoints: [path.join(appRoot, 'electron', 'main.ts')],
  outfile: path.join(appRoot, 'dist-electron', 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // playwright-core stays external for the same reason as the standalone
  // tool bundles below: @hearth/playtest's screenshot.ts only ever reaches
  // it through a lazy `import('playwright-core')`, and playwright-core's own
  // bundle pulls in optional native/CJS-only deps (chromium-bidi, fsevents)
  // that esbuild can't statically resolve anyway.
  // @lydell/node-pty ships prebuilt native binaries only (no JS source to
  // inline) and is dynamically imported lazily by server/ptyManager.ts;
  // esbuild must leave the import alone so it resolves via real node_modules
  // resolution at runtime against release-app/node_modules (see
  // scripts/assemble-app.mjs), not get bundled/rewritten.
  external: ['electron', 'playwright-core', '@lydell/node-pty'],
  sourcemap: false,
  logLevel: 'info',
  ...toolInline,
  // The server dynamically imports @hearth/playtest for runtime hooks; make
  // sure esbuild follows workspace symlinks and inlines it too.
  alias: {
    '@hearth/core/node': path.join(appRoot, '..', '..', 'packages', 'core', 'src', 'node', 'index.ts'),
    '@hearth/core': path.join(appRoot, '..', '..', 'packages', 'core', 'src', 'index.ts'),
    '@hearth/playtest': path.join(appRoot, '..', '..', 'packages', 'playtest', 'src', 'index.ts'),
    '@hearth/runtime/lua': path.join(appRoot, '..', '..', 'packages', 'runtime', 'src', 'lua.ts'),
    '@hearth/runtime': path.join(appRoot, '..', '..', 'packages', 'runtime', 'src', 'index.ts'),
  },
});

await copyFile(
  path.join(appRoot, 'electron', 'preload.cjs'),
  path.join(appRoot, 'dist-electron', 'preload.cjs'),
);

// ---------------------------------------------------------------------------
// Standalone agent tools: single-file bundles of the CLI and MCP server that
// ship inside the desktop app (and as release artifacts), so a user who only
// downloads the app still gets the full agent tooling — runnable with any
// Node ≥ 20: `node hearth-cli.cjs --help`, `node hearth-mcp.cjs --project …`.
// ---------------------------------------------------------------------------
const repoRoot = path.join(appRoot, '..', '..');
const toolAliases = {
  '@hearth/core/node': path.join(repoRoot, 'packages', 'core', 'src', 'node', 'index.ts'),
  '@hearth/core': path.join(repoRoot, 'packages', 'core', 'src', 'index.ts'),
  '@hearth/playtest': path.join(repoRoot, 'packages', 'playtest', 'src', 'index.ts'),
  '@hearth/runtime/lua': path.join(repoRoot, 'packages', 'runtime', 'src', 'lua.ts'),
  '@hearth/runtime': path.join(repoRoot, 'packages', 'runtime', 'src', 'index.ts'),
};

for (const [entry, outfile] of [
  [path.join(repoRoot, 'packages', 'cli', 'src', 'main.ts'), 'hearth-cli.mjs'],
  [path.join(repoRoot, 'packages', 'mcp-server', 'src', 'main.ts'), 'hearth-mcp.mjs'],
]) {
  await build({
    entryPoints: [entry],
    outfile: path.join(appRoot, 'dist-electron', outfile),
    bundle: true,
    platform: 'node',
    format: 'esm', // the CLI uses top-level await
    target: 'node20',
    sourcemap: false,
    logLevel: 'info',
    // playwright-core (used lazily by @hearth/playtest's `hearth screenshot`
    // support) must never be inlined: it's a large, optional, native-binary-
    // adjacent package, only ever pulled in via a dynamic `import()` inside
    // captureScreenshot so the tools still run without it installed. Bundling
    // it would both bloat these single-file tools and defeat that fallback.
    external: ['playwright-core'],
    banner: {
      // createRequire + __filename/__dirname shims: bundled CJS deps
      // (wasmoon among them) reference require()/__filename at runtime,
      // which don't exist in ESM output. (The entry files' own shebang is
      // preserved above this by esbuild.)
      js: [
        'import { createRequire as __hearthCreateRequire } from "node:module";',
        'import { fileURLToPath as __hearthFileURLToPath } from "node:url";',
        'import { dirname as __hearthDirname } from "node:path";',
        'const require = __hearthCreateRequire(import.meta.url);',
        'const __filename = __hearthFileURLToPath(import.meta.url);',
        'const __dirname = __hearthDirname(__filename);',
      ].join(' '),
    },
    ...toolInline,
    alias: toolAliases,
  });
}

// The web-export player ships next to the tools so `hearth export web` (CLI,
// MCP, or the editor's Export dialog) finds it via HEARTH_TOOLS_DIR in a
// packaged install. Built by packages/runtime's build:player step.
const playerSrc = path.join(repoRoot, 'packages', 'runtime', 'player', 'hearth-player.js');
await copyFile(playerSrc, path.join(appRoot, 'dist-electron', 'hearth-player.js'));

console.log('dist-electron/ ready (main + preload + hearth-cli.mjs + hearth-mcp.mjs + hearth-player.js)');
