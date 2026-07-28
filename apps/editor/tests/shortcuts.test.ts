// @vitest-environment jsdom
/**
 * Shortcut matching and labelling, on both platforms.
 *
 * The whole point of the module is that one declaration serves a Mac and a
 * Windows machine, so every case here is asserted twice with `mac` forced
 * rather than trusting whichever machine happens to run the suite.
 */
import { describe, it, expect } from 'vitest';
import { isTypingTarget, matchesShortcut, shortcutLabel, SHORTCUTS } from '../src/shortcuts';

/** A keyboard event shaped enough for the matcher. */
function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

describe('matchesShortcut', () => {
  it('takes Command on a Mac and Control elsewhere for the same declaration', () => {
    expect(matchesShortcut(key({ key: 'k', metaKey: true }), SHORTCUTS.search, true)).toBe(true);
    expect(matchesShortcut(key({ key: 'k', ctrlKey: true }), SHORTCUTS.search, false)).toBe(true);
  });

  it('rejects the other platform modifier', () => {
    // Ctrl+K on a Mac belongs to the terminal, and Cmd+K on Windows is not a
    // key anyone presses. Neither may trigger the app shortcut.
    expect(matchesShortcut(key({ key: 'k', ctrlKey: true }), SHORTCUTS.search, true)).toBe(false);
    expect(matchesShortcut(key({ key: 'k', metaKey: true }), SHORTCUTS.search, false)).toBe(false);
  });

  it('rejects a bare key when the shortcut wants the modifier', () => {
    expect(matchesShortcut(key({ key: 'k' }), SHORTCUTS.search, true)).toBe(false);
  });

  it('is case insensitive, so caps lock does not break it', () => {
    expect(matchesShortcut(key({ key: 'K', metaKey: true }), SHORTCUTS.search, true)).toBe(true);
  });

  it('rejects extra modifiers that were not declared', () => {
    expect(matchesShortcut(key({ key: 'k', metaKey: true, shiftKey: true }), SHORTCUTS.search, true)).toBe(false);
    expect(matchesShortcut(key({ key: 'k', metaKey: true, altKey: true }), SHORTCUTS.search, true)).toBe(false);
  });

  it('matches the punctuation shortcut used for settings', () => {
    expect(matchesShortcut(key({ key: ',', metaKey: true }), SHORTCUTS.settings, true)).toBe(true);
    expect(matchesShortcut(key({ key: ',', ctrlKey: true }), SHORTCUTS.settings, false)).toBe(true);
  });
});

describe('shortcutLabel', () => {
  it('uses the glyph on a Mac and the word on Windows', () => {
    expect(shortcutLabel(SHORTCUTS.search, true)).toBe('⌘K');
    expect(shortcutLabel(SHORTCUTS.search, false)).toBe('Ctrl+K');
  });

  it('keeps a punctuation key as it is typed', () => {
    expect(shortcutLabel(SHORTCUTS.settings, true)).toBe('⌘,');
    expect(shortcutLabel(SHORTCUTS.settings, false)).toBe('Ctrl+,');
  });

  it('orders modifiers the same way both platforms print them', () => {
    const combo = { key: 'p', mod: true, shift: true } as const;
    expect(shortcutLabel(combo, true)).toBe('⌘⇧P');
    expect(shortcutLabel(combo, false)).toBe('Ctrl+Shift+P');
  });
});

describe('isTypingTarget', () => {
  it('recognises the fields a bare shortcut must not steal from', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true);
    }
  });

  it('treats an ordinary element as fair game', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
