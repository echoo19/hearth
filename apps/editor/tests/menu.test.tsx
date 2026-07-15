// @vitest-environment jsdom
/**
 * Menu primitive — Wave L Task 4.
 *
 * The vitest config collects `apps/*\/tests/**\/*.test.{ts,tsx}` and defaults
 * to the `node` environment, but a per-file docblock can opt a `.tsx` file
 * into jsdom — the same convention tooltip.test.tsx and button.test.tsx use.
 * This file does both:
 *   - The menu's pure, exported units (below) are exercised without any DOM,
 *     following the launcher.test.ts / exportDialog.test.ts convention:
 *       - `menuNavIndex`      : arrow/Home/End roving-focus math (skips
 *                               separators and disabled items, wraps).
 *       - `installMenuDismiss`: the click-outside + Escape wiring, driven
 *                               through injected fake event targets so the two
 *                               behavioral contracts are pinned exactly:
 *                                 1. Escape stops propagation (SceneView
 *                                    deselect contract) via a DOCUMENT keydown
 *                                    listener.
 *                                 2. outside-detection is a WINDOW listener in
 *                                    the CAPTURE phase, so a canvas
 *                                    pointerdown that stopPropagation()s in
 *                                    the bubble phase can't leave the menu
 *                                    stuck open.
 *       - `MenuItems`         : render states (danger / checked / disabled /
 *                               separator / shortcut / icon) via static markup.
 *   - The `MenuButton — real DOM behavior` block below renders the actual
 *     component with RTL to pin the wiring end to end: open/close, Escape
 *     focus-return, real arrow-key DOM focus movement, the disabled-item
 *     Tooltip, and the checkbox stay-open contract.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import {
  ContextMenu,
  MenuButton,
  MenuItems,
  installMenuDismiss,
  menuNavIndex,
  type MenuItem,
} from '../src/components/ui/Menu';
import { resetTooltipWarmState } from '../src/components/ui/Tooltip';

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

describe('MenuButton — real DOM behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTooltipWarmState();
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  const trigger = () => screen.getByRole('button', { name: 'Actions' });
  const menu = () => screen.queryByRole('menu');

  it('opens on trigger click and closes on a second click, without double-toggling', () => {
    render(<MenuButton label="Actions" trigger="Actions" items={[{ label: 'A', onSelect: () => {} }]} />);
    expect(menu()).toBeNull();
    fireEvent.click(trigger());
    // A single click must open it — a double-toggle bug would leave it closed.
    expect(menu()).not.toBeNull();
    fireEvent.click(trigger());
    expect(menu()).toBeNull();
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    render(
      <MenuButton
        label="Actions"
        trigger="Actions"
        items={[
          { label: 'A', onSelect: () => {} },
          { label: 'B', onSelect: () => {} },
        ]}
      />,
    );
    fireEvent.click(trigger());
    expect(menu()).not.toBeNull();
    expect(document.activeElement?.textContent).toContain('A');
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('moves real DOM focus across items with ArrowDown/ArrowUp', () => {
    render(
      <MenuButton
        label="Actions"
        trigger="Actions"
        items={[
          { label: 'A', onSelect: () => {} },
          { label: 'B', onSelect: () => {} },
          { label: 'C', onSelect: () => {} },
        ]}
      />,
    );
    fireEvent.click(trigger());
    expect(document.activeElement?.textContent).toContain('A');
    fireEvent.keyDown(menu()!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('B');
    fireEvent.keyDown(menu()!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('C');
    fireEvent.keyDown(menu()!, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toContain('B');
  });

  it('skips a disabled item during arrow-key nav and shows its disabledReason on hover', () => {
    render(
      <MenuButton
        label="Actions"
        trigger="Actions"
        items={[
          { label: 'A', onSelect: () => {} },
          { label: 'Delete', disabled: true, disabledReason: 'Cannot delete the only scene in a project', onSelect: () => {} },
          { label: 'C', onSelect: () => {} },
        ]}
      />,
    );
    fireEvent.click(trigger());
    expect(document.activeElement?.textContent).toContain('A');
    // ArrowDown from A must skip the disabled item and land on C.
    fireEvent.keyDown(menu()!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('C');

    const disabledItem = screen.getByRole('menuitem', { name: /Delete/ });
    expect(disabledItem.getAttribute('aria-disabled')).toBe('true');
    expect((disabledItem as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      fireEvent.pointerEnter(disabledItem);
      vi.advanceTimersByTime(350);
    });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Cannot delete the only scene in a project');
  });

  it('keeps the menu open after selecting a checkbox item with closeOnSelect: false', () => {
    const onSelect = vi.fn();
    render(
      <MenuButton
        label="View"
        trigger="View"
        items={[{ label: 'Inspector', checked: false, closeOnSelect: false, onSelect }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const checkbox = screen.getByRole('menuitemcheckbox', { name: 'Inspector' });
    fireEvent.click(checkbox);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).not.toBeNull();
  });
});

describe('ContextMenu — real DOM behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTooltipWarmState();
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /**
   * Mirrors the Hierarchy's usage: a focusable row opens the menu via
   * right-click and passes itself as `returnFocus`; a sibling input stands in
   * for the rename field an action might move focus to.
   */
  function Harness({ items }: { items: MenuItem[] }) {
    const [menu, setMenu] = React.useState<{ el: HTMLElement } | null>(null);
    return (
      <div>
        <div
          tabIndex={0}
          data-testid="row"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ el: e.currentTarget });
          }}
        >
          Row
        </div>
        <input data-testid="rename" aria-label="rename" />
        {menu && (
          <ContextMenu
            x={5}
            y={5}
            label="Row menu"
            items={items}
            returnFocus={menu.el}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
    );
  }

  const row = () => screen.getByTestId('row');
  const menu = () => screen.queryByRole('menu');

  it('opens on contextmenu and focuses the first item', () => {
    render(<Harness items={[{ label: 'A', onSelect: () => {} }]} />);
    expect(menu()).toBeNull();
    fireEvent.contextMenu(row());
    expect(menu()).not.toBeNull();
    expect(document.activeElement?.textContent).toContain('A');
  });

  it('Escape closes the menu and returns focus to the invoking row', () => {
    render(<Harness items={[{ label: 'A', onSelect: () => {} }]} />);
    fireEvent.contextMenu(row());
    expect(menu()).not.toBeNull();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(row());
  });

  it('an outside pointerdown closes the menu and returns focus to the row', () => {
    render(<Harness items={[{ label: 'A', onSelect: () => {} }]} />);
    fireEvent.contextMenu(row());
    expect(menu()).not.toBeNull();
    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(row());
  });

  it('selecting an item restores focus to the row after the action settles', () => {
    const onSelect = vi.fn();
    render(<Harness items={[{ label: 'Duplicate', onSelect }]} />);
    fireEvent.contextMenu(row());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    // The restore is deferred past the action's render; flush it.
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(document.activeElement).toBe(row());
  });

  it('an item action that moves focus itself keeps that focus (no reclaim)', () => {
    render(
      <Harness
        items={[
          {
            label: 'Rename',
            onSelect: () => {
              (document.querySelector('[data-testid="rename"]') as HTMLInputElement).focus();
            },
          },
        ]}
      />,
    );
    fireEvent.contextMenu(row());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(document.activeElement).toBe(screen.getByTestId('rename'));
  });
});
