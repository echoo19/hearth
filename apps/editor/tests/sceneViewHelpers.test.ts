import { describe, expect, it } from 'vitest';
import { GRID_SIZE, panSpaceKey, snapToGrid, uiScreenToWorld } from '../src/components/SceneView';

/**
 * Pure logic tests for the SceneView helpers added in Wave L T8-B4:
 * - panSpaceKey: the hold-Space-to-pan guard (L-053) must yield to any typing
 *   target, including CodeMirror's contenteditable surface — so Space types a
 *   space in the Code panel instead of being swallowed by the pan handler.
 * - snapToGrid: shift-drag move snapping to the 32px scene grid (L-029/SCENEVIEW-3).
 * - uiScreenToWorld: maps a runtime screen-space UIElement position into the
 *   scene's world space over the active camera's viewport (L-024).
 */

describe('panSpaceKey (L-053 space-to-pan guard)', () => {
  it('starts a pan for a bare Space over a non-typing target', () => {
    expect(panSpaceKey({ code: 'Space', target: { tagName: 'DIV' } })).toBe(true);
    expect(panSpaceKey({ code: 'Space', target: null })).toBe(true);
  });

  it('yields Space to text-entry fields (input/textarea) so they can type a space', () => {
    expect(panSpaceKey({ code: 'Space', target: { tagName: 'INPUT' } })).toBe(false);
    expect(panSpaceKey({ code: 'Space', target: { tagName: 'TEXTAREA' } })).toBe(false);
  });

  it("yields Space to CodeMirror's contenteditable surface (the L-053 root-cause fix)", () => {
    // CM6's .cm-content is a plain contenteditable div, not INPUT/TEXTAREA — the
    // old narrow guard misclassified it as "not typing" and preventDefault'd Space.
    expect(panSpaceKey({ code: 'Space', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
  });

  it('ignores non-Space keys', () => {
    expect(panSpaceKey({ code: 'KeyA', target: { tagName: 'DIV' } })).toBe(false);
  });
});

describe('snapToGrid (L-029 shift-drag grid snap)', () => {
  it('snaps to the nearest grid multiple', () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(15)).toBe(0);
    expect(snapToGrid(20)).toBe(GRID_SIZE);
    expect(snapToGrid(48)).toBe(GRID_SIZE * 2);
    expect(snapToGrid(64)).toBe(GRID_SIZE * 2);
  });

  it('snaps negative values symmetrically', () => {
    expect(snapToGrid(-15)).toBe(0);
    expect(snapToGrid(-20)).toBe(-GRID_SIZE);
  });
});

describe('uiScreenToWorld (L-024 HUD anchor mapping)', () => {
  const size = { w: 800, h: 600 };

  it('is identity when the camera sits at the build-viewport center (the runtime default)', () => {
    const center = { x: 400, y: 300 };
    expect(uiScreenToWorld({ x: 0, y: 0 }, center, size)).toEqual({ x: 0, y: 0 });
    expect(uiScreenToWorld({ x: 800, y: 600 }, center, size)).toEqual({ x: 800, y: 600 });
    expect(uiScreenToWorld({ x: 400, y: 300 }, center, size)).toEqual({ x: 400, y: 300 });
  });

  it('places the HUD 1:1 over an offset camera so it overlays what the camera frames', () => {
    const center = { x: 1000, y: 1000 };
    // top-left screen anchor -> camera center minus half the viewport
    expect(uiScreenToWorld({ x: 0, y: 0 }, center, size)).toEqual({ x: 600, y: 700 });
    // center screen anchor -> camera center
    expect(uiScreenToWorld({ x: 400, y: 300 }, center, size)).toEqual({ x: 1000, y: 1000 });
  });
});
