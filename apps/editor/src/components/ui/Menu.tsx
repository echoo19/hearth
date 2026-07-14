/**
 * Menu primitive — Wave L. One implementation of the toolbar dropdown menu
 * (trigger button + popover) whose open/close, click-outside, Escape,
 * focus-return, and arrow-key roving focus were previously copy-pasted into
 * SceneMenu and ViewMenu.
 *
 * Two behavioral contracts callers depend on (see `installMenuDismiss`):
 *
 *  1. Escape closes the menu AND stops propagation. The keydown listener lives
 *     at DOCUMENT level (bubble phase). The keydown bubble path is
 *     target -> … -> document -> window, so the document listener runs BEFORE
 *     SceneView's window-level Escape-deselect listener; stopPropagation() then
 *     keeps that listener from also clearing the current entity selection.
 *
 *  2. Click-outside detection is a WINDOW listener in the CAPTURE phase.
 *     SceneView's canvas pointer handlers stopPropagation() in the bubble
 *     phase; a bubble/document pointerdown listener would never fire for a
 *     click that lands on the scene canvas, leaving the menu stuck open.
 *     Capture runs top-down (window first), before any handler can stop it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../ui';

export type MenuItem =
  | {
      label: string;
      icon?: string;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      /** Present (true/false) → renders as a menuitemcheckbox with a ✓ gutter. */
      checked?: boolean;
      /** Defaults to true. Multi-toggle items (e.g. panel visibility) set false. */
      closeOnSelect?: boolean;
      onSelect: () => void;
    }
  | { separator: true };

export type MenuItemAction = Exclude<MenuItem, { separator: true }>;

export function isSeparator(item: MenuItem): item is { separator: true } {
  return 'separator' in item;
}

function isFocusable(item: MenuItem): boolean {
  return !isSeparator(item) && !item.disabled;
}

/**
 * Pure roving-focus math: given the item list and the currently focused index,
 * return the index a nav key should move focus to. Separators and disabled
 * items are skipped; ArrowDown/ArrowUp wrap. Returns `current` when nothing is
 * focusable.
 */
export function menuNavIndex(
  items: readonly MenuItem[],
  current: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): number {
  const focusable: number[] = [];
  items.forEach((item, i) => {
    if (isFocusable(item)) focusable.push(i);
  });
  if (focusable.length === 0) return current;
  if (key === 'Home') return focusable[0];
  if (key === 'End') return focusable[focusable.length - 1];
  const pos = focusable.indexOf(current);
  if (key === 'ArrowDown') {
    return pos === -1 ? focusable[0] : focusable[(pos + 1) % focusable.length];
  }
  // ArrowUp
  return pos === -1 ? focusable[focusable.length - 1] : focusable[(pos - 1 + focusable.length) % focusable.length];
}

interface EventTargetLike {
  addEventListener(type: string, listener: (e: any) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (e: any) => void, options?: boolean | EventListenerOptions): void;
}

/**
 * Install the dismiss listeners for an open menu. Extracted from the component
 * so both event-ordering contracts (see file header) are unit-testable with
 * injected targets. Returns a cleanup that removes both listeners.
 */
export function installMenuDismiss(opts: {
  isOutside: (target: EventTarget | null) => boolean;
  close: () => void;
  onEscape: () => void;
  targets?: { windowTarget: EventTargetLike; documentTarget: EventTargetLike };
}): () => void {
  const win = opts.targets?.windowTarget ?? (window as EventTargetLike);
  const doc = opts.targets?.documentTarget ?? (document as EventTargetLike);

  const onPointerDown = (e: { target?: EventTarget | null }) => {
    if (opts.isOutside(e.target ?? null)) opts.close();
  };
  const onKeyDown = (e: { key?: string; stopPropagation?: () => void }) => {
    if (e.key === 'Escape') {
      e.stopPropagation?.();
      opts.onEscape();
    }
  };

  // Capture phase (true): fires before any bubble-phase stopPropagation.
  win.addEventListener('pointerdown', onPointerDown, true);
  // Document (bubble): runs before SceneView's window-level Escape listener.
  doc.addEventListener('keydown', onKeyDown);
  return () => {
    win.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown);
  };
}

/**
 * The popover's item list. Exported so render states are testable without a
 * live DOM; also the single place the item → markup mapping lives.
 */
export function MenuItems({
  items,
  focusedIndex = -1,
  onFocusIndex,
  onSelectItem,
  itemRefs,
}: {
  items: readonly MenuItem[];
  focusedIndex?: number;
  onFocusIndex?: (index: number) => void;
  onSelectItem?: (item: MenuItemAction, index: number) => void;
  itemRefs?: React.MutableRefObject<(HTMLButtonElement | null)[]>;
}) {
  return (
    <>
      {items.map((item, i) => {
        if (isSeparator(item)) {
          return <div key={`sep-${i}`} className="menu-separator" role="separator" />;
        }
        const isCheckbox = typeof item.checked === 'boolean';
        return (
          <button
            key={item.label}
            ref={(el) => {
              if (itemRefs) itemRefs.current[i] = el;
            }}
            className={`menu-item${item.danger ? ' menu-item-danger' : ''}`}
            role={isCheckbox ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={isCheckbox ? !!item.checked : undefined}
            disabled={item.disabled}
            tabIndex={i === focusedIndex ? 0 : -1}
            onFocus={() => onFocusIndex?.(i)}
            onClick={() => onSelectItem?.(item, i)}
          >
            <span className="menu-check" aria-hidden="true">
              {item.checked ? '✓' : ''}
            </span>
            {item.icon && <Icon name={item.icon} />}
            {item.label}
            {item.shortcut && (
              <span className="menu-shortcut" aria-hidden="true">
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

export interface MenuButtonProps {
  /** Content of the trigger button (an Icon, or plain text). */
  trigger: React.ReactNode;
  items: MenuItem[];
  /** Accessible name for the trigger and the menu. */
  label: string;
  align?: 'left' | 'right';
  disabled?: boolean;
  triggerClassName?: string;
}

export function MenuButton({
  trigger,
  items,
  label,
  align = 'left',
  disabled,
  triggerClassName = 'btn btn-sm',
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(-1);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const closeAndFocusTrigger = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // Dismiss wiring (click-outside + Escape). See file header for the contracts.
  useEffect(() => {
    if (!open) return;
    return installMenuDismiss({
      isOutside: (target) => !(rootRef.current && target instanceof Node && rootRef.current.contains(target)),
      close: () => setOpen(false),
      onEscape: closeAndFocusTrigger,
    });
  }, [open, closeAndFocusTrigger]);

  // On open, move focus to the first focusable item.
  useEffect(() => {
    if (!open) return;
    setFocused(menuNavIndex(items, -1, 'Home'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reflect the roving index into real DOM focus.
  useEffect(() => {
    if (!open || focused < 0) return;
    itemRefs.current[focused]?.focus();
  }, [open, focused]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setFocused((cur) => menuNavIndex(items, cur, e.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'));
    }
    // Enter/Space activate the focused item natively (it is a <button>).
    // Escape is handled by the document listener in installMenuDismiss so it can
    // stopPropagation before SceneView's window-level deselect listener.
  }

  function selectItem(item: MenuItemAction) {
    item.onSelect();
    if (item.closeOnSelect !== false) closeAndFocusTrigger();
  }

  return (
    <span className="menu-root" ref={rootRef}>
      <button
        ref={buttonRef}
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div
          className={`menu-popover${align === 'right' ? ' menu-popover-right' : ''}`}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          <MenuItems items={items} focusedIndex={focused} onFocusIndex={setFocused} onSelectItem={selectItem} itemRefs={itemRefs} />
        </div>
      )}
    </span>
  );
}
