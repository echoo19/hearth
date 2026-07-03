/**
 * window.__HEARTH_BOOT__ merge logic (pure, headless). The player entry
 * itself (../src/player/index.ts) assigns window.HearthPlayer at module
 * scope and only runs in a browser — see player-loading.test.ts for the same
 * caveat — so this logic lives in its own window-free module purely so it
 * can be exercised here without a DOM. The end-to-end manual-boot behavior
 * (autoplay suppressed, window.__hearth.step advancing session.frame) is
 * verified separately against a real exported build in a browser, not here.
 */
import { describe, it, expect } from 'vitest';
import { mergeBootOverrides } from '../src/player/bootOverrides.js';

describe('mergeBootOverrides', () => {
  it('passes options through unchanged when there is no override object', () => {
    const opts = { manual: true, seed: 3 };
    expect(mergeBootOverrides(opts, undefined)).toEqual(opts);
  });

  it('fills in unset keys from the override object', () => {
    const opts = {};
    expect(mergeBootOverrides(opts, { manual: true, seed: 5, debug: true })).toEqual({
      manual: true,
      seed: 5,
      debug: true,
      width: undefined,
      height: undefined,
    });
  });

  it('lets an explicit option win over the override for the same key', () => {
    const opts = { manual: false, seed: 1 };
    const merged = mergeBootOverrides(opts, { manual: true, seed: 99 });
    expect(merged.manual).toBe(false);
    expect(merged.seed).toBe(1);
  });

  it('merges width/height independently of manual/seed/debug', () => {
    const opts = { width: 640 };
    const merged = mergeBootOverrides(opts, { height: 480, debug: true });
    expect(merged).toMatchObject({ width: 640, height: 480, debug: true });
  });

  it('does not mutate the input options object', () => {
    const opts = { manual: false };
    mergeBootOverrides(opts, { manual: true });
    expect(opts).toEqual({ manual: false });
  });

  it('merges scene the same way as the other override keys', () => {
    const opts = {};
    expect(mergeBootOverrides(opts, { scene: 'Level 2' })).toMatchObject({ scene: 'Level 2' });
    const explicit = { scene: 'Level 1' };
    expect(mergeBootOverrides(explicit, { scene: 'Level 2' }).scene).toBe('Level 1');
  });
});
