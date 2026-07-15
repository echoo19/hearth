// @vitest-environment jsdom
/**
 * PixiSceneView.pause()/play() ↔ WebAudioPlayer suspend/resume wiring
 * (review I1). The full view needs a browser to mount, so these drive the
 * prototype methods against a minimal `this` — pinning that pause() actually
 * calls audio.suspend() (and play() audio.resume()) without a Pixi
 * Application. The suspend/resume semantics themselves are covered in
 * pixi-audio.test.ts; end-to-end audio silence is verified live in the
 * editor (Wave L T9-U5).
 */
import { describe, it, expect, vi } from 'vitest';
import { PixiSceneView } from '../src/pixi/index.js';

interface WiringSeam {
  _paused: boolean;
  accumulator: number;
  audio: { suspend: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> } | null;
}

function makeView(over: Partial<WiringSeam> = {}): PixiSceneView & WiringSeam {
  const view = Object.create(PixiSceneView.prototype) as PixiSceneView & WiringSeam;
  view._paused = false;
  view.accumulator = 0.5;
  view.audio = { suspend: vi.fn(), resume: vi.fn() };
  Object.assign(view, over);
  return view;
}

describe('PixiSceneView pause/play audio wiring', () => {
  it('pause() suspends audio along with the simulation', () => {
    const view = makeView();
    view.pause();
    expect(view.paused).toBe(true);
    expect(view.accumulator).toBe(0);
    expect(view.audio!.suspend).toHaveBeenCalledTimes(1);
    expect(view.audio!.resume).not.toHaveBeenCalled();
  });

  it('play() resumes audio along with the simulation', () => {
    const view = makeView({ _paused: true });
    view.play();
    expect(view.paused).toBe(false);
    expect(view.audio!.resume).toHaveBeenCalledTimes(1);
    expect(view.audio!.suspend).not.toHaveBeenCalled();
  });

  it('pause()/play() tolerate a missing audio player (unsupported env)', () => {
    const view = makeView({ audio: null });
    expect(() => {
      view.pause();
      view.play();
    }).not.toThrow();
  });
});
