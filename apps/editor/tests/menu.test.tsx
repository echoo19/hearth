/**
 * Menu primitive — Wave L Task 4.
 *
 * This repo runs tests under the `node` environment (no jsdom / RTL, and the
 * vitest glob only collects `*.test.ts`), so — following the same convention as
 * launcher.test.ts / exportDialog.test.ts — the menu's behavioral core is
 * exercised as pure, exported units rather than through a rendered DOM:
 *   - `menuNavIndex`      : arrow/Home/End roving-focus math (skips separators
 *                           and disabled items, wraps).
 *   - `installMenuDismiss`: the click-outside + Escape wiring, driven through
 *                           injected fake event targets so the two behavioral
 *                           contracts are pinned exactly:
 *                             1. Escape stops propagation (SceneView deselect
 *                                contract) via a DOCUMENT keydown listener.
 *                             2. outside-detection is a WINDOW listener in the
 *                                CAPTURE phase, so a canvas pointerdown that
 *                                stopPropagation()s in the bubble phase can't
 *                                leave the menu stuck open.
 *   - `MenuItems`         : render states (danger / checked / disabled /
 *                           separator / shortcut / icon) via static markup.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MenuItems,
  installMenuDismiss,
  menuNavIndex,
  type MenuItem,
} from '../src/components/ui/Menu';

describe('menuNavIndex — roving focus', () => {
  const items: MenuItem[] = [
    { label: 'A', onSelect: () => {} },
    { label: 'B', disabled: true, onSelect: () => {} },
    { separator: true },
    { label: 'C', onSelect: () => {} },
  ];

  it('Home lands on the first focusable item', () => {
    expect(menuNavIndex(items, -1, 'Home')).toBe(0);
  });

  it('End lands on the last focusable item', () => {
    expect(menuNavIndex(items, -1, 'End')).toBe(3);
  });

  it('ArrowDown skips disabled items and separators', () => {
    // From A (0): next focusable skips B (disabled, 1) and the separator (2).
    expect(menuNavIndex(items, 0, 'ArrowDown')).toBe(3);
  });

  it('ArrowDown wraps from the last focusable back to the first', () => {
    expect(menuNavIndex(items, 3, 'ArrowDown')).toBe(0);
  });

  it('ArrowUp skips disabled items and separators', () => {
    expect(menuNavIndex(items, 3, 'ArrowUp')).toBe(0);
  });

  it('ArrowUp wraps from the first focusable to the last', () => {
    expect(menuNavIndex(items, 0, 'ArrowUp')).toBe(3);
  });

  it('returns current when nothing is focusable', () => {
    const none: MenuItem[] = [{ separator: true }, { label: 'X', disabled: true, onSelect: () => {} }];
    expect(menuNavIndex(none, 0, 'ArrowDown')).toBe(0);
  });
});

/** Records listener registrations so phase/target/cleanup can be asserted. */
function fakeTarget() {
  const listeners: { type: string; fn: (e: any) => void; opts: unknown }[] = [];
  return {
    listeners,
    addEventListener(type: string, fn: (e: any) => void, opts?: unknown) {
      listeners.push({ type, fn, opts });
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire(type: string, event: any) {
      for (const l of listeners.filter((x) => x.type === type)) l.fn(event);
    },
  };
}

const OUTSIDE = {} as EventTarget;
const INSIDE = {} as EventTarget;

describe('installMenuDismiss — click-outside + Escape wiring', () => {
  function setup() {
    const windowTarget = fakeTarget();
    const documentTarget = fakeTarget();
    const close = vi.fn();
    const onEscape = vi.fn();
    const cleanup = installMenuDismiss({
      isOutside: (t) => t === OUTSIDE,
      close,
      onEscape,
      targets: { windowTarget, documentTarget },
    });
    return { windowTarget, documentTarget, close, onEscape, cleanup };
  }

  it('registers outside-detection as a CAPTURE-phase pointerdown on window', () => {
    const { windowTarget } = setup();
    const pd = windowTarget.listeners.find((l) => l.type === 'pointerdown');
    expect(pd).toBeDefined();
    // Capture phase — top-down, so a canvas handler that stopPropagation()s in
    // the bubble phase can't defeat it.
    expect(pd?.opts).toBe(true);
  });

  it('registers Escape handling as a keydown on document (not window)', () => {
    const { windowTarget, documentTarget } = setup();
    expect(documentTarget.listeners.some((l) => l.type === 'keydown')).toBe(true);
    expect(windowTarget.listeners.some((l) => l.type === 'keydown')).toBe(false);
  });

  it('closes on an outside pointerdown', () => {
    const { windowTarget, close } = setup();
    windowTarget.fire('pointerdown', { target: OUTSIDE });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stays open on a pointerdown inside the menu', () => {
    const { windowTarget, close } = setup();
    windowTarget.fire('pointerdown', { target: INSIDE });
    expect(close).not.toHaveBeenCalled();
  });

  it('Escape stops propagation AND fires onEscape (SceneView deselect contract)', () => {
    const { documentTarget, onEscape } = setup();
    const stopPropagation = vi.fn();
    documentTarget.fire('keydown', { key: 'Escape', stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('ignores non-Escape keys', () => {
    const { documentTarget, onEscape } = setup();
    const stopPropagation = vi.fn();
    documentTarget.fire('keydown', { key: 'a', stopPropagation });
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('cleanup removes both listeners', () => {
    const { windowTarget, documentTarget, cleanup } = setup();
    cleanup();
    expect(windowTarget.listeners).toHaveLength(0);
    expect(documentTarget.listeners).toHaveLength(0);
  });
});

describe('MenuItems — render states', () => {
  function markup(items: MenuItem[]): string {
    return renderToStaticMarkup(React.createElement(MenuItems, { items }));
  }

  it('renders a danger item with the danger class', () => {
    const html = markup([{ label: 'Delete', danger: true, onSelect: () => {} }]);
    expect(html).toContain('menu-item-danger');
  });

  it('renders a checked item as a menuitemcheckbox with the check glyph', () => {
    const html = markup([{ label: 'Grid', checked: true, onSelect: () => {} }]);
    expect(html).toContain('role="menuitemcheckbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('✓');
  });

  it('renders an unchecked checkbox item without the glyph but with aria-checked=false', () => {
    const html = markup([{ label: 'Grid', checked: false, onSelect: () => {} }]);
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('✓');
  });

  it('renders a plain action item as role menuitem', () => {
    const html = markup([{ label: 'Rename', onSelect: () => {} }]);
    expect(html).toContain('role="menuitem"');
    expect(html).not.toContain('menuitemcheckbox');
  });

  it('renders a disabled item with the disabled attribute', () => {
    const html = markup([{ label: 'Delete', disabled: true, onSelect: () => {} }]);
    expect(html).toContain('disabled');
  });

  it('renders a separator', () => {
    const html = markup([{ separator: true }]);
    expect(html).toContain('menu-separator');
    expect(html).toContain('role="separator"');
  });

  it('renders a shortcut chip', () => {
    const html = markup([{ label: 'Shortcuts', shortcut: '?', onSelect: () => {} }]);
    expect(html).toContain('menu-shortcut');
    expect(html).toContain('?');
  });

  it('renders an icon glyph', () => {
    const html = markup([{ label: 'More', icon: 'more', onSelect: () => {} }]);
    expect(html).toContain('<svg');
  });
});
