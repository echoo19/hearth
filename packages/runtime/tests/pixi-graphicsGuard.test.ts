/**
 * clearGraphics: the hardening guard around Pixi v8's destroy-then-clear
 * race (see ../src/pixi/graphicsGuard.ts's header for the investigation).
 * Uses a REAL
 * pixi.js Graphics — constructing and destroying one needs no canvas/WebGL
 * (same reason pixi-tilemapRender.test.ts runs in this workspace's default
 * "node" environment), so this reproduces the actual throw
 * ("Cannot read properties of null (reading 'clear')") that a bare
 * `g.clear()` hits post-destroy, rather than asserting against a stub.
 */
import { describe, it, expect, vi } from 'vitest';

// Same Node-vs-browser `navigator` shim pixi-tilemapRender.test.ts needs —
// pixi.js's GL video-texture uploader reads the bare global at module scope.
vi.hoisted(() => {
  if (typeof globalThis.navigator === 'undefined') {
    (globalThis as { navigator?: Navigator }).navigator = { userAgent: 'node' } as Navigator;
  }
});

import { Graphics } from 'pixi.js';
import { clearGraphics } from '../src/pixi/graphicsGuard.js';

describe('clearGraphics', () => {
  it('clears a live Graphics and reports success', () => {
    const g = new Graphics();
    g.rect(0, 0, 10, 10).fill('#ffffff');
    expect(clearGraphics(g)).toBe(true);
    expect(g.destroyed).toBe(false);
  });

  it('reproduces the raw bug: Graphics.clear() throws "reading \'clear\'" after destroy()', () => {
    const g = new Graphics();
    g.destroy();
    expect(() => g.clear()).toThrow(/reading 'clear'/);
  });

  it('is a no-op (no throw) on an already-destroyed Graphics, and reports skipped', () => {
    const g = new Graphics();
    g.destroy();
    expect(g.destroyed).toBe(true);
    expect(() => clearGraphics(g)).not.toThrow();
    expect(clearGraphics(g)).toBe(false);
  });

  it('never calls through to the real clear() once destroyed', () => {
    const g = new Graphics();
    g.destroy();
    const clearSpy = vi.spyOn(g, 'clear');
    clearGraphics(g);
    expect(clearSpy).not.toHaveBeenCalled();
  });
});
