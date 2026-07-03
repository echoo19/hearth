#!/usr/bin/env node
/**
 * Builds the standalone web player: bundles the runtime + pixi host + player
 * entry (src/player/index.ts) into a single browser IIFE at
 * player/hearth-player.js, consumed by the `exportWeb` command. @hearth/core
 * is aliased to its TypeScript sources so this build never depends on core's
 * dist output being fresh.
 *
 * Lua support: wasmoon's glue.wasm is embedded at build time. A tiny esbuild
 * plugin swaps src/player/luaWasm.ts (an empty placeholder for the plain tsc
 * build) for a module exporting the real wasm bytes as a base64 data: URI;
 * the player entry passes it to setLuaWasmUri before anything boots, so
 * exported games are fully self-contained (no external .wasm fetch).
 */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const wasmPath = require.resolve('wasmoon/dist/glue.wasm');
const wasmDataUri = `data:application/wasm;base64,${fs.readFileSync(wasmPath).toString('base64')}`;

/** Replace the luaWasm placeholder module with the embedded wasm data URI. */
const inlineLuaWasmPlugin = {
  name: 'hearth-inline-lua-wasm',
  setup(build) {
    const placeholder = path.join(pkgRoot, 'src', 'player', 'luaWasm.ts');
    build.onLoad({ filter: /luaWasm\.ts$/ }, (args) => {
      if (path.resolve(args.path) !== placeholder) return null;
      return {
        contents: `export const LUA_WASM_DATA_URI = ${JSON.stringify(wasmDataUri)};`,
        loader: 'ts',
      };
    });
  },
};

/**
 * wasmoon's emscripten glue imports the Node builtins "url" and "module"
 * behind `ENVIRONMENT_IS_NODE` runtime guards that never run in a browser.
 * Stub them to empty shims so the browser bundle resolves.
 */
const nodeBuiltinShimPlugin = {
  name: 'hearth-node-builtin-shims',
  setup(build) {
    build.onResolve({ filter: /^(url|module)$/ }, (args) => ({
      path: args.path,
      namespace: 'hearth-node-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'hearth-node-shim' }, (args) => ({
      contents:
        args.path === 'module'
          ? 'export const createRequire = () => { throw new Error("node-only"); };\n' +
            'export default { createRequire };'
          : 'export const pathToFileURL = () => { throw new Error("node-only"); };\n' +
            'export default { pathToFileURL };',
      loader: 'js',
    }));
  },
};

const outfile = path.join(pkgRoot, 'player/hearth-player.js');

await build({
  entryPoints: [path.join(pkgRoot, 'src/player/index.ts')],
  outfile,
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
  plugins: [inlineLuaWasmPlugin, nodeBuiltinShimPlugin],
});

// Sanity check: the wasm payload must actually be embedded ("\0asm" magic
// base64-encodes to "AGFzbQ").
const bundleSource = fs.readFileSync(outfile, 'utf8');
if (!bundleSource.includes('AGFzbQ')) {
  console.error('build-player: hearth-player.js is missing the embedded Lua wasm payload');
  process.exit(1);
}
const sizeMb = (fs.statSync(outfile).size / (1024 * 1024)).toFixed(2);
console.log(`build-player: ok — Lua wasm embedded, bundle ${sizeMb} MB`);
