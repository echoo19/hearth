/**
 * Built player artifact checks (player/hearth-player.js, produced by
 * scripts/build-player.mjs). Skipped when the artifact has not been built in
 * this checkout; when present it must carry the inlined Lua wasm and zero
 * engine branding.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
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

  // Bundle budget: the standalone player ships in every exported game, so its
  // size is a hard product constraint. 0.10 baseline (pre-post-effects) was
  // 1,349,649 B; adding the hand-written Pixi post-effect + SpriteEffects
  // filters (postEffects.ts + spriteEffectsFilter.ts, GLSL as inline strings,
  // plus the full-screen background rect that lets post effects cover the
  // whole frame) measured 1,366,476 B — a +16,827 B (~1.2%) delta. The
  // previous 1,450,000 B ceiling was reached at 1,449,769 B (v1.3.3); the
  // DPR/pixelated rendering fix plus the PIXEL_ART_STRETCHED and
  // SPRITE_COLLIDER_FEET_MISMATCH validators (core is bundled into the
  // player) measured 1,453,803 B — a +4,034 B (~0.3%) delta. The 1,500,000 B
  // ceiling still catches an accidental heavyweight dependency (e.g. pulling
  // in pixi-filters, which the bloat rule forbids).
  it('stays under the 1.5 MB player budget', () => {
    const size = statSync(bundlePath).size;
    expect(size).toBeLessThan(1_500_000);
  });
});
