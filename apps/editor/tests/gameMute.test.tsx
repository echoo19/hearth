// @vitest-environment jsdom
/**
 * Silencing the game.
 *
 * The pane is on all the time, so a game that loops music loops it at you
 * while you read the agent beside it. What makes this worth a test rather than
 * a two-line handler is WHERE the mute has to happen: the game is served from
 * a second loopback port to keep it cross-origin, so its document cannot be
 * reached from here, and a game using WebAudio has no media element to mute
 * even when it can be. Muting the window is the only thing that works, which
 * means it goes through Electron, which means the control has to disappear
 * where Electron is not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CapabilityStrip } from '../src/components/game/CapabilityStrip';
import { GAME_MUTED_KEY, readGameMuted, useApp } from '../src/store';

const setAudioMuted = vi.fn().mockResolvedValue(undefined);

/** Stand in the preload, or take it away to be the browser dev server. */
function withNative(present: boolean): void {
  if (present) {
    window.hearthNative = { setAudioMuted } as unknown as Window['hearthNative'];
  } else {
    delete window.hearthNative;
  }
}

beforeEach(() => {
  localStorage.clear();
  setAudioMuted.mockClear();
  withNative(true);
  useApp.setState({ gameMuted: false });
});

afterEach(() => {
  cleanup();
  delete window.hearthNative;
  localStorage.clear();
});

const muteButton = (): HTMLElement =>
  screen.getByRole('button', { name: /^Game (muted|not muted)$/ });

describe('the mute control', () => {
  it('silences the window, because the frame cannot be reached', () => {
    render(<CapabilityStrip />);
    fireEvent.click(muteButton());
    expect(setAudioMuted).toHaveBeenCalledWith(true);
    expect(useApp.getState().gameMuted).toBe(true);
  });

  it('unmutes again, so it is a switch rather than a one-way door', () => {
    useApp.setState({ gameMuted: true });
    render(<CapabilityStrip />);
    fireEvent.click(muteButton());
    expect(setAudioMuted).toHaveBeenLastCalledWith(false);
    expect(useApp.getState().gameMuted).toBe(false);
  });

  it('says which state it is in rather than which action it offers', () => {
    // A control labelled "Mute" while the game is already muted is one you
    // have to press to find out.
    render(<CapabilityStrip />);
    expect(muteButton().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(muteButton());
    expect(muteButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('is not offered at all where nothing can mute a cross-origin frame', () => {
    // The browser dev server. A button that cannot work is worse than no
    // button: it teaches that mute is broken rather than absent.
    withNative(false);
    render(<CapabilityStrip />);
    expect(screen.queryByRole('button', { name: /^Game (muted|not muted)$/ })).toBeNull();
    // And Play is still there, so hiding one control has not hidden the strip.
    expect(screen.getByRole('button', { name: 'Play the game' })).toBeTruthy();
  });
});

describe('remembering it', () => {
  it('keeps the choice for the next game, not just this folder', () => {
    // Someone who muted a game at midnight wants the next one muted too.
    // Per-folder storage would make them do it again for every project.
    useApp.getState().setGameMuted(true);
    expect(localStorage.getItem(GAME_MUTED_KEY)).toBe('1');
    expect(readGameMuted()).toBe(true);
  });

  it('reads as unmuted when nobody has ever said otherwise', () => {
    expect(readGameMuted()).toBe(false);
  });

  it('re-asserts a stored mute on mount, since the window starts unmuted', () => {
    // The preference survives a restart; the mute does not. Without this a
    // muted game comes back making noise on the next launch, and the button
    // says it is muted while it plays.
    useApp.setState({ gameMuted: true });
    render(<CapabilityStrip />);
    expect(setAudioMuted).toHaveBeenCalledWith(true);
  });

  it('does not touch the window on mount when nothing is muted', () => {
    render(<CapabilityStrip />);
    expect(setAudioMuted).not.toHaveBeenCalled();
  });
});
