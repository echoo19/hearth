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

console.log('dist-electron/ ready');
