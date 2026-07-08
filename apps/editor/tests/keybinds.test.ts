import { describe, it, expect, vi } from 'vitest';
import {
  KEYBINDS,
  comboDisplay,
  eventCombo,
  resolveBinding,
  isTypingTarget,
  groupedKeybinds,
  canonicalCombo,
  type KeyLike,
} from '../src/keybinds';
import type { EditorStore } from '../src/store';

/** A KeyboardEvent-shaped fixture; only the fields the pure helpers read. */
function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

/** A mock store recording which actions a binding invoked. */
function mockStore(over: Partial<EditorStore> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  const store = {
    selection: null,
    exec: vi.fn((name: string, params?: unknown) => {
      calls.push(['exec', name, params]);
      return Promise.resolve({ success: true });
    }),
    log: rec('log'),
    duplicateSelection: rec('duplicateSelection'),
    deleteSelection: rec('deleteSelection'),
    nudgeSelection: rec('nudgeSelection'),
    requestFocusSelection: rec('requestFocusSelection'),
    togglePlay: rec('togglePlay'),
    checkpoint: rec('checkpoint'),
    toggleShortcutSheet: rec('toggleShortcutSheet'),
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
});

describe('table dispatch', () => {
  it('undo/redo run the right exec commands', () => {
    const a = mockStore();
    resolveBinding({ combo: 'mod+z', hasSelection: false })!.run(a.store);
    expect(a.calls).toContainEqual(['exec', 'undo', undefined]);

    const b = mockStore();
    resolveBinding({ combo: 'shift+mod+z', hasSelection: false })!.run(b.store);
    resolveBinding({ combo: 'mod+y', hasSelection: false })!.run(b.store);
    expect(b.calls.filter((c) => c[0] === 'exec' && c[1] === 'redo')).toHaveLength(2);
  });

  it('selection bindings call their store actions', () => {
    const { store, calls } = mockStore({ selection: 'ent-1' } as Partial<EditorStore>);
    resolveBinding({ combo: 'mod+d', hasSelection: true })!.run(store);
    resolveBinding({ combo: 'delete', hasSelection: true })!.run(store);
    resolveBinding({ combo: 'f', hasSelection: true })!.run(store);
    expect(calls).toContainEqual(['duplicateSelection']);
    expect(calls).toContainEqual(['deleteSelection']);
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

  it('display-only rows (space, escape) carry the flag and are inert', () => {
    const space = KEYBINDS.find((b) => b.id === 'pan')!;
    const escape = KEYBINDS.find((b) => b.id === 'escape')!;
    expect(space.display).toBe(true);
    expect(escape.display).toBe(true);
    const { store, calls } = mockStore();
    space.run(store);
    escape.run(store);
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
