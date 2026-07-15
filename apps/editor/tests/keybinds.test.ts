import { describe, it, expect, vi } from 'vitest';
import {
  KEYBINDS,
  comboDisplay,
  eventCombo,
  resolveBinding,
  isTypingTarget,
  groupedKeybinds,
  canonicalCombo,
  dispatchDecision,
  isMac,
  type KeyLike,
  type DispatchEventLike,
} from '../src/keybinds';
import type { EditorStore } from '../src/store';

/** A KeyboardEvent-shaped fixture; only the fields the pure helpers read. */
function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

/** A dispatchDecision event fixture: key() plus repeat/target. */
function dispatchKey(k: string, over: Partial<DispatchEventLike> = {}): DispatchEventLike {
  return { ...key(k, over), repeat: false, target: null, ...over };
}

/** A mock store recording which actions a binding invoked. */
function mockStore(over: Partial<EditorStore> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  const store = {
    selection: null,
    playing: false,
    paused: false,
    exec: vi.fn((name: string, params?: unknown) => {
      calls.push(['exec', name, params]);
      return Promise.resolve({ success: true });
    }),
    log: rec('log'),
    duplicateSelection: rec('duplicateSelection'),
    requestDeleteSelection: rec('requestDeleteSelection'),
    nudgeSelection: rec('nudgeSelection'),
    requestFocusSelection: rec('requestFocusSelection'),
    togglePlay: rec('togglePlay'),
    setPaused: rec('setPaused'),
    checkpoint: rec('checkpoint'),
    toggleShortcutSheet: rec('toggleShortcutSheet'),
    requestCodeSearch: rec('requestCodeSearch'),
    undo: rec('undo'),
    redo: rec('redo'),
    ...over,
  } as unknown as EditorStore;
  return { store, calls };
}

describe('combo matching', () => {
  it('maps modifier events to canonical combos (mac uses meta as mod)', () => {
    expect(eventCombo(key('z', { metaKey: true }), true)).toBe('mod+z');
    expect(eventCombo(key('z', { ctrlKey: true }), false)).toBe('mod+z');
    // Token order is normalized regardless of press order.
    expect(eventCombo(key('Z', { metaKey: true, shiftKey: true }), true)).toBe('mod+shift+z');
    expect(canonicalCombo('shift+mod+z')).toBe('mod+shift+z');
  });

  it('normalizes special keys and treats Backspace as delete', () => {
    expect(eventCombo(key('ArrowUp'))).toBe('up');
    expect(eventCombo(key('ArrowUp', { shiftKey: true }))).toBe('shift+up');
    expect(eventCombo(key('Backspace'))).toBe('delete');
    expect(eventCombo(key('Delete'))).toBe('delete');
    expect(eventCombo(key('Enter', { metaKey: true }), true)).toBe('mod+enter');
    expect(eventCombo(key('?', { shiftKey: true }))).toBe('shift+/');
  });

  it('ignores lone modifier keys', () => {
    expect(eventCombo(key('Shift', { shiftKey: true }))).toBeNull();
    expect(eventCombo(key('Meta', { metaKey: true }), true)).toBeNull();
  });

  it('resolves the Pause combo (shift+mod+enter) with mod as both meta and ctrl, explicitly on each platform', () => {
    expect(eventCombo(key('Enter', { metaKey: true, shiftKey: true }), true)).toBe('mod+shift+enter');
    expect(eventCombo(key('Enter', { ctrlKey: true, shiftKey: true }), false)).toBe('mod+shift+enter');
  });

  it('resolves the bare zoom keys with no modifier (avoiding the browser Mod+=/Mod+-/Mod+0 page-zoom collision)', () => {
    expect(eventCombo(key('='))).toBe('=');
    expect(eventCombo(key('-'))).toBe('-');
    expect(eventCombo(key('0'))).toBe('0');
  });
});

describe('resolveBinding + guards', () => {
  it('resolves a global binding regardless of selection', () => {
    expect(resolveBinding({ combo: 'mod+z', hasSelection: false })?.id).toBe('undo');
  });

  it('gates selection-only bindings on a live selection', () => {
    expect(resolveBinding({ combo: 'mod+d', hasSelection: false })).toBeUndefined();
    expect(resolveBinding({ combo: 'mod+d', hasSelection: true })?.id).toBe('duplicate');
    expect(resolveBinding({ combo: 'up', hasSelection: false })).toBeUndefined();
    expect(resolveBinding({ combo: 'up', hasSelection: true })?.id).toBe('nudge-up');
  });

  it('recognizes text-entry targets as typing (shortcuts must yield)', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('gates the "playing" Pause binding on isPlaying, mirroring the selection guard', () => {
    expect(resolveBinding({ combo: 'shift+mod+enter', hasSelection: false, isPlaying: false })).toBeUndefined();
    expect(resolveBinding({ combo: 'shift+mod+enter', hasSelection: false, isPlaying: true })?.id).toBe('pause');
    // Omitting isPlaying entirely defaults to "not playing" (safe default).
    expect(resolveBinding({ combo: 'shift+mod+enter', hasSelection: false })).toBeUndefined();
  });
});

describe('table dispatch', () => {
  it('undo/redo route through the store actions (one code path with the toolbar — TOOLBAR-6)', () => {
    const a = mockStore();
    resolveBinding({ combo: 'mod+z', hasSelection: false })!.run(a.store);
    expect(a.calls).toContainEqual(['undo']);

    const b = mockStore();
    resolveBinding({ combo: 'shift+mod+z', hasSelection: false })!.run(b.store);
    resolveBinding({ combo: 'mod+y', hasSelection: false })!.run(b.store);
    expect(b.calls.filter((c) => c[0] === 'redo')).toHaveLength(2);
  });

  it('selection bindings call their store actions', () => {
    const { store, calls } = mockStore({ selection: 'ent-1' } as Partial<EditorStore>);
    resolveBinding({ combo: 'mod+d', hasSelection: true })!.run(store);
    resolveBinding({ combo: 'delete', hasSelection: true })!.run(store);
    resolveBinding({ combo: 'f', hasSelection: true })!.run(store);
    expect(calls).toContainEqual(['duplicateSelection']);
    expect(calls).toContainEqual(['requestDeleteSelection']);
    expect(calls).toContainEqual(['requestFocusSelection']);
  });

  it('nudge magnitudes: arrows 1px, shift+arrows 10px', () => {
    const { store, calls } = mockStore();
    resolveBinding({ combo: 'up', hasSelection: true })!.run(store);
    resolveBinding({ combo: 'shift+right', hasSelection: true })!.run(store);
    expect(calls).toContainEqual(['nudgeSelection', 0, -1]);
    expect(calls).toContainEqual(['nudgeSelection', 10, 0]);
  });

  it('? toggles the cheat sheet and Cmd+Enter toggles play', () => {
    const { store, calls } = mockStore();
    resolveBinding({ combo: 'shift+/', hasSelection: false })!.run(store);
    resolveBinding({ combo: 'mod+enter', hasSelection: false })!.run(store);
    expect(calls).toContainEqual(['toggleShortcutSheet']);
    expect(calls).toContainEqual(['togglePlay']);
  });

  it('Shift+Mod+F opens/focuses the Code panel search bar', () => {
    const { store, calls } = mockStore();
    const bind = resolveBinding({ combo: 'shift+mod+f', hasSelection: false })!;
    expect(bind.id).toBe('search-scripts');
    bind.run(store);
    expect(calls).toContainEqual(['requestCodeSearch']);
  });

  it('Shift+Mod+Enter pauses/resumes by flipping the store\'s paused flag (only reachable while playing)', () => {
    const { store: playingStore, calls: playingCalls } = mockStore({ playing: true, paused: false } as Partial<EditorStore>);
    resolveBinding({ combo: 'shift+mod+enter', hasSelection: false, isPlaying: true })!.run(playingStore);
    expect(playingCalls).toContainEqual(['setPaused', true]);

    const { store: resumeStore, calls: resumeCalls } = mockStore({ playing: true, paused: true } as Partial<EditorStore>);
    resolveBinding({ combo: 'shift+mod+enter', hasSelection: false, isPlaying: true })!.run(resumeStore);
    expect(resumeCalls).toContainEqual(['setPaused', false]);

    // Not reachable while stopped — mirrors the toolbar Pause button's own disabled={!playing}.
    expect(resolveBinding({ combo: 'shift+mod+enter', hasSelection: false, isPlaying: false })).toBeUndefined();
  });

  it('display-only rows (space, escape, zoom) carry the flag and are inert', () => {
    const space = KEYBINDS.find((b) => b.id === 'pan')!;
    const escape = KEYBINDS.find((b) => b.id === 'escape')!;
    const zoomIn = KEYBINDS.find((b) => b.id === 'zoom-in')!;
    const zoomOut = KEYBINDS.find((b) => b.id === 'zoom-out')!;
    const zoomFit = KEYBINDS.find((b) => b.id === 'zoom-fit')!;
    for (const b of [space, escape, zoomIn, zoomOut, zoomFit]) expect(b.display).toBe(true);
    const { store, calls } = mockStore();
    space.run(store);
    escape.run(store);
    zoomIn.run(store);
    zoomOut.run(store);
    zoomFit.run(store);
    expect(calls).toHaveLength(0);
  });
});

describe('platform display', () => {
  it('renders mac symbols and non-mac words', () => {
    expect(comboDisplay('mod+z', true)).toBe('⌘Z');
    expect(comboDisplay('mod+z', false)).toBe('Ctrl+Z');
    expect(comboDisplay('shift+mod+z', true)).toBe('⇧⌘Z');
    expect(comboDisplay('shift+mod+z', false)).toBe('Ctrl+Shift+Z');
    expect(comboDisplay('shift+/', true)).toBe('?');
    expect(comboDisplay('shift+up', true)).toBe('⇧↑');
    expect(comboDisplay('mod+enter', false)).toBe('Ctrl+Enter');
    expect(comboDisplay('delete', false)).toBe('Del');
  });
});

describe('dispatchDecision (installKeybinds guards, DOM-free)', () => {
  it('ignores an auto-repeat keydown', () => {
    const d = dispatchDecision(dispatchKey('z', { metaKey: isMac, ctrlKey: !isMac, repeat: true }), {
      hasSelection: false,
      isPlaying: false,
      dialogOpen: false,
    });
    expect(d).toEqual({ action: 'ignore', preventDefault: false });
  });

  it('ignores keys while a typing target (input/textarea/contentEditable) is focused', () => {
    const d = dispatchDecision(dispatchKey('d', { metaKey: isMac, ctrlKey: !isMac, target: { tagName: 'INPUT' } }), {
      hasSelection: true,
      isPlaying: false,
      dialogOpen: false,
    });
    expect(d).toEqual({ action: 'ignore', preventDefault: false });
  });

  it('ignores non-Escape keys while a dialog is open, but still resolves Escape', () => {
    const modZ = dispatchDecision(dispatchKey('z', { metaKey: isMac, ctrlKey: !isMac }), {
      hasSelection: false,
      isPlaying: false,
      dialogOpen: true,
    });
    expect(modZ).toEqual({ action: 'ignore', preventDefault: false });

    // Escape's own row is display-only, so a dialog-open Escape resolves to
    // passthrough (the native <dialog> handles it), not 'run'.
    const esc = dispatchDecision(dispatchKey('Escape'), { hasSelection: false, isPlaying: false, dialogOpen: true });
    expect(esc.action).toBe('passthrough');
    expect(esc.bind?.id).toBe('escape');
    expect(esc.preventDefault).toBe(false);
  });

  it('display rows (space, escape) resolve to passthrough with preventDefault false', () => {
    const space = dispatchDecision(dispatchKey(' '), { hasSelection: false, isPlaying: false, dialogOpen: false });
    expect(space.action).toBe('passthrough');
    expect(space.bind?.id).toBe('pan');
    expect(space.preventDefault).toBe(false);

    const esc = dispatchDecision(dispatchKey('Escape'), { hasSelection: false, isPlaying: false, dialogOpen: false });
    expect(esc.action).toBe('passthrough');
    expect(esc.bind?.id).toBe('escape');
    expect(esc.preventDefault).toBe(false);
  });

  it('an unbound key (no matching combo) also resolves to passthrough', () => {
    const d = dispatchDecision(dispatchKey('q'), { hasSelection: false, isPlaying: false, dialogOpen: false });
    expect(d).toEqual({ action: 'passthrough', bind: undefined, preventDefault: false });
  });

  it('mod+s resolves to run with preventDefault true (intercepts the browser Save dialog)', () => {
    const d = dispatchDecision(dispatchKey('s', { metaKey: isMac, ctrlKey: !isMac }), { hasSelection: false, isPlaying: false, dialogOpen: false });
    expect(d.action).toBe('run');
    expect(d.bind?.id).toBe('save');
    expect(d.preventDefault).toBe(true);
  });

  it('shift+mod+enter resolves to run only while playing (mod resolved via isMac, like the mod+s test above — platform-independent)', () => {
    // metaKey: isMac, ctrlKey: !isMac mirrors eventCombo's own mac ? metaKey :
    // ctrlKey branch, so this passes whether the test runs on mac or not.
    const running = dispatchDecision(dispatchKey('Enter', { metaKey: isMac, ctrlKey: !isMac, shiftKey: true }), {
      hasSelection: false,
      isPlaying: true,
      dialogOpen: false,
    });
    expect(running.action).toBe('run');
    expect(running.bind?.id).toBe('pause');
    expect(running.preventDefault).toBe(true);

    // Same combo while stopped: no binding resolves (mirrors the toolbar
    // Pause button's disabled={!playing}), so it passes through untouched.
    const stopped = dispatchDecision(dispatchKey('Enter', { metaKey: isMac, ctrlKey: !isMac, shiftKey: true }), {
      hasSelection: false,
      isPlaying: false,
      dialogOpen: false,
    });
    expect(stopped.action).toBe('passthrough');
    expect(stopped.bind).toBeUndefined();
  });

  it('bare zoom keys (=, -, 0) resolve to passthrough display rows, never "run" — SceneView owns the real behavior', () => {
    for (const [k, id] of [
      ['=', 'zoom-in'],
      ['-', 'zoom-out'],
      ['0', 'zoom-fit'],
    ] as const) {
      const d = dispatchDecision(dispatchKey(k), { hasSelection: false, isPlaying: false, dialogOpen: false });
      expect(d.action).toBe('passthrough');
      expect(d.bind?.id).toBe(id);
      expect(d.preventDefault).toBe(false);
    }
  });

  it('mod+s inside CodeMirror\'s contenteditable content is ignored by the global registry (double-fire guard)', () => {
    // CM6's editable surface is a contenteditable div; the Code panel binds its
    // own Mod-s -> save inside the CM6 keymap. The global dispatcher must yield
    // here so the two handlers never both fire for one keypress. Checked for
    // both mod forms (meta on mac, ctrl elsewhere) — platform-independent.
    const viaMeta = dispatchDecision(
      dispatchKey('s', { metaKey: true, target: { tagName: 'DIV', isContentEditable: true } }),
      { hasSelection: false, isPlaying: false, dialogOpen: false },
    );
    expect(viaMeta).toEqual({ action: 'ignore', preventDefault: false });

    const viaCtrl = dispatchDecision(
      dispatchKey('s', { ctrlKey: true, target: { tagName: 'DIV', isContentEditable: true } }),
      { hasSelection: false, isPlaying: false, dialogOpen: false },
    );
    expect(viaCtrl).toEqual({ action: 'ignore', preventDefault: false });
  });

  it('Shift+Mod+F still resolves to run while a typing target (e.g. CodeMirror\'s contenteditable) has focus, unlike mod+s', () => {
    // mod resolved via isMac (metaKey on mac, ctrlKey elsewhere), mirroring
    // the mod+s / shift+mod+enter platform-independent tests above.
    const viaContentEditable = dispatchDecision(
      dispatchKey('f', {
        metaKey: isMac,
        ctrlKey: !isMac,
        shiftKey: true,
        target: { tagName: 'DIV', isContentEditable: true },
      }),
      { hasSelection: false, isPlaying: false, dialogOpen: false },
    );
    expect(viaContentEditable.action).toBe('run');
    expect(viaContentEditable.bind?.id).toBe('search-scripts');
    expect(viaContentEditable.preventDefault).toBe(true);

    const viaInput = dispatchDecision(
      dispatchKey('f', { metaKey: isMac, ctrlKey: !isMac, shiftKey: true, target: { tagName: 'INPUT' } }),
      { hasSelection: false, isPlaying: false, dialogOpen: false },
    );
    expect(viaInput.action).toBe('run');
    expect(viaInput.bind?.id).toBe('search-scripts');
  });

  it('a selection-only binding without a live selection resolves to passthrough, not run', () => {
    const d = dispatchDecision(dispatchKey('d', { metaKey: isMac, ctrlKey: !isMac }), { hasSelection: false, isPlaying: false, dialogOpen: false });
    expect(d.action).toBe('passthrough');
    expect(d.bind).toBeUndefined();
  });
});

describe('no-drift: cheat sheet is generated from KEYBINDS', () => {
  it('every row has an id, label, and valid group', () => {
    const seen = new Set<string>();
    for (const b of KEYBINDS) {
      expect(b.id).toBeTruthy();
      expect(b.label).toBeTruthy();
      expect(['General', 'Scene', 'Selection']).toContain(b.group);
      expect(seen.has(b.id)).toBe(false); // ids are unique
      seen.add(b.id);
    }
  });

  it('groupedKeybinds renders exactly one row per KEYBINDS entry', () => {
    const groups = groupedKeybinds();
    const flat = groups.flatMap((g) => g.binds);
    expect(flat).toHaveLength(KEYBINDS.length);
    expect(new Set(flat.map((b) => b.id))).toEqual(new Set(KEYBINDS.map((b) => b.id)));
    // Grouping partitions the table — no row is dropped or duplicated.
    for (const g of groups) {
      for (const b of g.binds) expect(b.group).toBe(g.group);
    }
  });
});
