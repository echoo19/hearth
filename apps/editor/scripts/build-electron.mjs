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

await build({
  entryPoints: [path.join(appRoot, 'electron', 'main.ts')],
  outfile: path.join(appRoot, 'dist-electron', 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
  // The server dynamically imports @hearth/playtest for runtime hooks; make
  // sure esbuild follows workspace symlinks and inlines it too.
  alias: {
    '@hearth/core/node': path.join(appRoot, '..', '..', 'packages', 'core', 'src', 'node', 'index.ts'),
    '@hearth/core': path.join(appRoot, '..', '..', 'packages', 'core', 'src', 'index.ts'),
    '@hearth/playtest': path.join(appRoot, '..', '..', 'packages', 'playtest', 'src', 'index.ts'),
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
    banner: {
      // createRequire shim: some bundled CJS deps call require() at runtime.
      // (The entry files' own shebang is preserved above this by esbuild.)
      js: 'import { createRequire as __hearthCreateRequire } from "node:module"; const require = __hearthCreateRequire(import.meta.url);',
    },
    alias: toolAliases,
  });
}

// The web-export player ships next to the tools so `hearth export web` (CLI,
// MCP, or the editor's Export dialog) finds it via HEARTH_TOOLS_DIR in a
// packaged install. Built by packages/runtime's build:player step.
const playerSrc = path.join(repoRoot, 'packages', 'runtime', 'player', 'hearth-player.js');
await copyFile(playerSrc, path.join(appRoot, 'dist-electron', 'hearth-player.js'));

console.log('dist-electron/ ready (main + preload + hearth-cli.mjs + hearth-mcp.mjs + hearth-player.js)');
