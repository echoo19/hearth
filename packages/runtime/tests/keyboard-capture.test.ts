// @vitest-environment jsdom
/**
 * L-001: game-input keyboard capture must not swallow keys when focus is in
 * editor chrome (any element outside the game view root) or when a modal
 * <dialog> is open — while still keeping FULL capture in an exported player
 * (no chrome: focus sits on <body>, and the game owns the keyboard).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldCaptureGameKey } from '../src/pixi/keyboardCapture.js';

describe('shouldCaptureGameKey (L-001)', () => {
  let root: HTMLElement; // the game view container / canvas host
  let canvas: HTMLElement; // a focusable node inside the game view
  let chromeInput: HTMLInputElement; // an editor field OUTSIDE the game view

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    canvas = document.createElement('canvas');
    root.appendChild(canvas);
    chromeInput = document.createElement('input');
    document.body.appendChild(root);
    document.body.appendChild(chromeInput);
  });

  it('captures when a node inside the game view has focus', () => {
    expect(
      shouldCaptureGameKey({ paused: false, dialogOpen: false, activeElement: canvas, captureRoot: root }),
    ).toBe(true);
  });

  it('does NOT capture when focus is inside editor chrome (outside the game view)', () => {
    expect(
      shouldCaptureGameKey({ paused: false, dialogOpen: false, activeElement: chromeInput, captureRoot: root }),
    ).toBe(false);
  });

  it('does NOT capture while a modal <dialog> is open', () => {
    expect(
      shouldCaptureGameKey({ paused: false, dialogOpen: true, activeElement: canvas, captureRoot: root }),
    ).toBe(false);
  });

  it('does NOT capture while the game is paused (not receiving input)', () => {
    expect(
      shouldCaptureGameKey({ paused: true, dialogOpen: false, activeElement: canvas, captureRoot: root }),
    ).toBe(false);
  });

  it('exported player: <body> focus (no chrome) keeps full capture', () => {
    expect(
      shouldCaptureGameKey({ paused: false, dialogOpen: false, activeElement: document.body, captureRoot: root }),
    ).toBe(true);
  });

  it('exported player: null activeElement keeps full capture', () => {
    expect(
      shouldCaptureGameKey({ paused: false, dialogOpen: false, activeElement: null, captureRoot: root }),
    ).toBe(true);
  });

  it('no captureRoot configured → unrestricted full capture (export default)', () => {
    expect(
      shouldCaptureGameKey({ paused: false, dialogOpen: false, activeElement: chromeInput, captureRoot: null }),
    ).toBe(true);
  });
});
