#!/usr/bin/env node
/**
 * Builds the standalone web player: bundles the runtime + pixi host + player
 * entry (src/player/index.ts) into a single browser IIFE at
 * player/hearth-player.js, consumed by the `exportWeb` command. @hearth/core
 * is aliased to its TypeScript sources so this build never depends on core's
 * dist output being fresh.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(pkgRoot, 'src/player/index.ts')],
  outfile: path.join(pkgRoot, 'player/hearth-player.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  alias: {
    '@hearth/core': path.join(pkgRoot, '../core/src/index.ts'),
  },
});
