/**
 * Module-level game view handle: a plain get/set pair, no React
 * involved, so this is exercised directly rather than through a component.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getGameView, setGameView } from '../src/gameViewRef';
import type { MountedGameView } from '../src/runtimeBridge';

function fakeView(): MountedGameView {
  return {
    play() {},
    pause() {},
    destroy() {},
  };
}

describe('gameViewRef', () => {
  beforeEach(() => {
    setGameView(null);
  });

  it('starts null before any view has mounted', () => {
    expect(getGameView()).toBeNull();
  });

  it('returns exactly the view that was set', () => {
    const view = fakeView();
    setGameView(view);
    expect(getGameView()).toBe(view);
  });

  it('clears back to null (Stop / unmount)', () => {
    setGameView(fakeView());
    setGameView(null);
    expect(getGameView()).toBeNull();
  });

  it('the most recent set() wins (remount replaces the previous view)', () => {
    const first = fakeView();
    const second = fakeView();
    setGameView(first);
    setGameView(second);
    expect(getGameView()).toBe(second);
    expect(getGameView()).not.toBe(first);
  });
});
