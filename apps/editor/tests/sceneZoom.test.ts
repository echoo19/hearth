import { describe, expect, it } from 'vitest';
import { fitView, sceneWheelAction, sceneZoomKey, zoomBy } from '../src/components/SceneView';

/**
 * Pure logic tests for SceneView's keyboard zoom (=/-/0): the zoom/fit math
 * (zoomBy/fitView, also used by the pre-existing wheel-zoom and auto-fit
 * paths) and the decision function that gates the bare keys on the typing
 * target and modifier-key guards (sceneZoomKey). No DOM, no store — mirrors
 * the style of keybinds.test.ts's dispatchDecision coverage.
 */
describe('zoomBy', () => {
  it('keeps the given screen point fixed while scaling around it', () => {
    const view = { s: 1, tx: 0, ty: 0 };
    const center = { x: 100, y: 50 };
    const next = zoomBy(view, 2, center);
    expect(next.s).toBe(2);
    // world point under the cursor before the zoom must be under it after too
    const worldBefore = { x: (center.x - view.tx) / view.s, y: (center.y - view.ty) / view.s };
    const worldAfter = { x: (center.x - next.tx) / next.s, y: (center.y - next.ty) / next.s };
    expect(worldAfter.x).toBeCloseTo(worldBefore.x);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y);
  });

  it('clamps to MIN_ZOOM/MAX_ZOOM instead of scaling without bound', () => {
    const view = { s: 1, tx: 0, ty: 0 };
    expect(zoomBy(view, 1000, { x: 0, y: 0 }).s).toBe(12);
    expect(zoomBy(view, 0.00001, { x: 0, y: 0 }).s).toBe(0.05);
  });
});

describe('fitView', () => {
  it('scales the build viewport to fit inside the host with padding, centered', () => {
    const view = fitView({ w: 1000, h: 800 }, { w: 400, h: 300 });
    // min(1000/(400+160), 800/(300+120), 1.5) = min(1.786, 1.905, 1.5) = 1.5
    expect(view.s).toBe(1.5);
    expect(view.tx).toBeCloseTo((1000 - 400 * 1.5) / 2);
    expect(view.ty).toBeCloseTo((800 - 300 * 1.5) / 2);
  });

  it('shrinks (never exceeds the 1.5 cap) when the host is smaller than the build viewport', () => {
    const view = fitView({ w: 300, h: 200 }, { w: 800, h: 600 });
    expect(view.s).toBeLessThan(1);
  });
});

describe('sceneZoomKey', () => {
  const noMods = { metaKey: false, ctrlKey: false, altKey: false, target: null };

  it('maps =, -, 0 to in/out/fit', () => {
    expect(sceneZoomKey({ key: '=', ...noMods })).toBe('in');
    expect(sceneZoomKey({ key: '-', ...noMods })).toBe('out');
    expect(sceneZoomKey({ key: '0', ...noMods })).toBe('fit');
  });

  it('ignores every other key', () => {
    expect(sceneZoomKey({ key: 'a', ...noMods })).toBeNull();
    expect(sceneZoomKey({ key: '+', ...noMods })).toBeNull();
    expect(sceneZoomKey({ key: 'Enter', ...noMods })).toBeNull();
  });

  it('yields to a typing target (input/textarea/CodeMirror contentEditable) — must not fire while typing', () => {
    expect(sceneZoomKey({ key: '=', ...noMods, target: { tagName: 'INPUT' } })).toBeNull();
    expect(sceneZoomKey({ key: '-', ...noMods, target: { tagName: 'TEXTAREA' } })).toBeNull();
    expect(sceneZoomKey({ key: '0', ...noMods, target: { tagName: 'DIV', isContentEditable: true } })).toBeNull();
  });

  it('yields when a modifier is held, avoiding the browser Mod+=/Mod+-/Mod+0 page-zoom collision', () => {
    expect(sceneZoomKey({ key: '=', metaKey: true, ctrlKey: false, altKey: false, target: null })).toBeNull();
    expect(sceneZoomKey({ key: '-', metaKey: false, ctrlKey: true, altKey: false, target: null })).toBeNull();
    expect(sceneZoomKey({ key: '0', metaKey: false, ctrlKey: false, altKey: true, target: null })).toBeNull();
  });
});

describe('sceneWheelAction', () => {
  const wheel = (o: Partial<{ deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean }>) => ({
    deltaX: 0,
    deltaY: 0,
    ctrlKey: false,
    metaKey: false,
    ...o,
  });

  // The bug this pins: a plain wheel used to zoom, which left a trackpad with
  // NO pan gesture — two-finger scroll zoomed the canvas instead of moving it.
  it('pans on a plain two-finger scroll, honoring both axes', () => {
    expect(sceneWheelAction(wheel({ deltaX: 12, deltaY: 30 }))).toEqual({ kind: 'pan', dx: -12, dy: -30 });
  });

  it('zooms on pinch (browsers synthesize ctrlKey) and on ctrl+wheel', () => {
    const pinch = sceneWheelAction(wheel({ deltaY: -10, ctrlKey: true }));
    expect(pinch.kind).toBe('zoom');
    if (pinch.kind === 'zoom') expect(pinch.factor).toBeGreaterThan(1); // scroll up = zoom in
  });

  it('zooms on meta+wheel', () => {
    expect(sceneWheelAction(wheel({ deltaY: 10, metaKey: true })).kind).toBe('zoom');
  });

  // Direction, stated separately from the two-axis case above: a scroll down
  // (positive deltaY) moves the view down, i.e. content travels up, the way a
  // scrolled document behaves.
  it('scrolling down moves the view down; scrolling up moves it up', () => {
    const down = sceneWheelAction(wheel({ deltaY: 50 }));
    const up = sceneWheelAction(wheel({ deltaY: -50 }));
    expect(down.kind === 'pan' && down.dy).toBe(-50);
    expect(up.kind === 'pan' && up.dy).toBe(50);
  });
});
