/**
 * Built player artifact checks (player/hearth-player.js, produced by
 * scripts/build-player.mjs). Skipped when the artifact has not been built in
 * this checkout; when present it must carry the inlined Lua wasm and zero
 * engine branding.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bundlePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../player/hearth-player.js',
);
const built = existsSync(bundlePath);

describe.skipIf(!built)('player bundle (hearth-player.js)', () => {
  const source = built ? readFileSync(bundlePath, 'utf8') : '';

  it('embeds the wasmoon glue.wasm payload ("\\0asm" magic, base64 AGFzbQ)', () => {
    expect(source).toContain('AGFzbQ');
    // And it is registered as a data: URI for setLuaWasmUri.
    expect(source).toContain('data:application/wasm;base64,');
  });

  it('contains no engine start screen or branding', () => {
    for (const leak of ['Click to start', '#141019', '#F76B15']) {
      expect(source).not.toContain(leak);
    }
  });
});
