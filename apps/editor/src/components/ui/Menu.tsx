/**
 * Menu primitive — Wave L. One implementation of the toolbar dropdown menu
 * (trigger button + popover) whose open/close, click-outside, Escape,
 * focus-return, and arrow-key roving focus were previously copy-pasted into
 * SceneMenu and the toolbar's View menu (now MenuBar).
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
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui';
import { Tooltip } from './Tooltip';

export type MenuItem =
  | {
      label: string;
      icon?: string;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      /**
       * One short line explaining why the item is disabled. When set on a
       * disabled item, the item is wrapped in a Tooltip so hovering/focusing
       * it explains why instead of just looking greyed out.
       */
      disabledReason?: string;
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
        // Disabled items with a `disabledReason` stay reachable by pointer and
        // focus so the explanatory Tooltip can actually show — the native
        // `disabled` attribute makes an element inert to both. `aria-disabled`
        // keeps the a11y semantics and the greyed-out look (see menu.css)
        // while the click handler below still refuses to run `onSelect`, and
        // `menuNavIndex` already treats any `disabled: true` item as
        // unfocusable for arrow-key/Home/End roving.
        const showReason = !!(item.disabled && item.disabledReason);
        const itemButton = (
          <button
            ref={(el) => {
              if (itemRefs) itemRefs.current[i] = el;
            }}
            className={`menu-item${item.danger ? ' menu-item-danger' : ''}`}
            role={isCheckbox ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={isCheckbox ? !!item.checked : undefined}
            aria-disabled={showReason ? true : undefined}
            disabled={item.disabled && !showReason}
            tabIndex={i === focusedIndex ? 0 : -1}
            onFocus={() => {
              if (!item.disabled) onFocusIndex?.(i);
            }}
            onClick={() => {
              if (!item.disabled) onSelectItem?.(item, i);
            }}
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
        return showReason ? (
          <Tooltip key={item.label} content={item.disabledReason!}>
            {itemButton}
          </Tooltip>
        ) : (
          <React.Fragment key={item.label}>{itemButton}</React.Fragment>
        );
      })}
    </>
  );
}

/**
 * Clamp a menu's top-left origin so the popover stays inside the viewport.
 * Pure so the flip math is testable without a DOM. When the menu would overflow
 * the right/bottom edge it is shifted back by the overflow (or flipped above/
 * left of the cursor when that reads better), never off the top/left.
 */
export function clampMenuOrigin(
  cursor: { x: number; y: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  margin = 4,
): { x: number; y: number } {
  let x = cursor.x;
  let y = cursor.y;
  if (x + size.w + margin > viewport.w) x = Math.max(margin, viewport.w - size.w - margin);
  if (y + size.h + margin > viewport.h) y = Math.max(margin, viewport.h - size.h - margin);
  return { x, y };
}

/**
 * Clamp a single axis so a `size`-long popover starting at `desiredStart` stays
 * fully inside `[margin, viewport - margin]`. Unlike `clampMenuOrigin` (which
 * only pulls back an element overflowing the FAR edge), this also refuses a
 * negative/too-small start — the exact failure behind L-123, where a dropdown
 * anchored to a trigger near x=0 rendered shifted a full popover-width off the
 * LEFT edge. When the popover is wider than the viewport it pins to `margin`
 * (near/start edge stays visible). Pure so it is testable without a DOM.
 */
export function clampAxis(desiredStart: number, size: number, viewport: number, margin = 4): number {
  const maxStart = viewport - size - margin;
  if (maxStart < margin) return margin;
  return Math.min(Math.max(desiredStart, margin), maxStart);
}

/**
 * Position a trigger-anchored dropdown popover (MenuButton). Anchors the
 * popover's start edge to the trigger (left edge for `align:'left'`, right edge
 * for `'right'`), opens `gap` px below the trigger, and CLAMPS both axes into
 * the viewport so it can never render off any edge (L-123). Flips above the
 * trigger when opening below would overflow the bottom and there is more room
 * above. Pure — the flip/clamp math is unit-tested without a live DOM.
 */
export function menuDropdownPosition(
  trigger: { left: number; right: number; top: number; bottom: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  align: 'left' | 'right' = 'left',
  gap = 4,
  margin = 4,
): { left: number; top: number } {
  const desiredLeft = align === 'right' ? trigger.right - size.w : trigger.left;
  const left = clampAxis(desiredLeft, size.w, viewport.w, margin);
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - size.h;
  let top: number;
  if (below + size.h + margin > viewport.h && above >= margin) {
    top = above; // flip above the trigger — more room there
  } else {
    top = clampAxis(below, size.h, viewport.h, margin);
  }
  return { left, top };
}

/**
 * Cursor-anchored context menu. Reuses the same item markup, roving-focus math
 * and dismiss contracts as MenuButton (see file header) — the only difference
 * is it opens at a point (right-click) instead of below a trigger, and renders
 * into a body portal so it escapes any panel's overflow clipping. The opener
 * owns the open/closed state; `onClose` is called on select, Escape, or an
 * outside click.
 */
export function ContextMenu({
  x,
  y,
  items,
  label,
  onClose,
  returnFocus,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  label: string;
  onClose: () => void;
  /**
   * Element to restore focus to when the menu dismisses — the invoking row in
   * a roving-tabindex tree, where losing focus to the body strands keyboard
   * users. Escape/outside-click restore immediately; item-select restores
   * AFTER the action settles and only if focus fell through to the body (an
   * action that moves focus itself, e.g. rename's autoFocus input, keeps it).
   */
  returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focused, setFocused] = useState(() => menuNavIndex(items, -1, 'Home'));
  const [pos, setPos] = useState({ x, y });

  const closeAndRestore = useCallback(() => {
    onClose();
    // Outside-click: pointerdown-capture runs before the click target's own
    // focus behavior, so a click on a focusable element still wins afterwards.
    returnFocus?.focus();
  }, [onClose, returnFocus]);

  // Dismiss wiring (click-outside + Escape), identical contracts to MenuButton.
  useEffect(() => {
    return installMenuDismiss({
      isOutside: (target) => !(ref.current && target instanceof Node && ref.current.contains(target)),
      close: closeAndRestore,
      onEscape: closeAndRestore,
    });
  }, [closeAndRestore]);

  // Keep the menu on-screen: measure once mounted and clamp to the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampMenuOrigin({ x, y }, { w: rect.width, h: rect.height }, { w: window.innerWidth, h: window.innerHeight }));
  }, [x, y]);

  // Focus the first item on open, then reflect the roving index into DOM focus.
  useEffect(() => {
    itemRefs.current[focused]?.focus();
  }, [focused]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setFocused((cur) => menuNavIndex(items, cur, e.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'));
    }
  }

  function selectItem(item: MenuItemAction) {
    const target = returnFocus ?? null;
    item.onSelect();
    onClose();
    // Restore focus AFTER the action's render settles: unmounting the menu
    // drops focus to the body unless the action claimed it (rename's autoFocus
    // input must keep it), so only reclaim focus that fell through.
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) target?.focus();
    }, 0);
  }

  return createPortal(
    <div
      ref={ref}
      className="menu-popover context-menu"
      role="menu"
      aria-label={label}
      style={{ position: 'fixed', left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
    >
      <MenuItems items={items} focusedIndex={focused} onFocusIndex={setFocused} onSelectItem={selectItem} itemRefs={itemRefs} />
    </div>,
    document.body,
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
  // null until measured. The popover is portaled to <body> and positioned with
  // clamped `fixed` coords (see the layout effect) so it can never render off a
  // viewport edge — the L-123 failure — and escapes any ancestor overflow
  // clip, the same reason ContextMenu portals.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const closeAndFocusTrigger = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // Dismiss wiring (click-outside + Escape). See file header for the contracts.
  // The popover now lives in a body portal, so an inside-click is inside EITHER
  // the trigger root or the popover — checking only the root would treat every
  // menu-item click as "outside" and slam the menu shut before it selects.
  useEffect(() => {
    if (!open) return;
    return installMenuDismiss({
      isOutside: (target) => {
        const node = target instanceof Node ? target : null;
        const inRoot = !!(rootRef.current && node && rootRef.current.contains(node));
        const inPopover = !!(popoverRef.current && node && popoverRef.current.contains(node));
        return !inRoot && !inPopover;
      },
      close: () => setOpen(false),
      onEscape: closeAndFocusTrigger,
    });
  }, [open, closeAndFocusTrigger]);

  // Measure the trigger + popover and clamp the popover into the viewport before
  // paint (useLayoutEffect runs pre-paint, so there is no first-frame flash at
  // the wrong spot). Recompute on resize while open so a window resize can't
  // strand the popover off-screen.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const trigger = buttonRef.current?.getBoundingClientRect();
      const pop = popoverRef.current?.getBoundingClientRect();
      if (!trigger || !pop) return;
      setPos(
        menuDropdownPosition(
          trigger,
          { w: pop.width, h: pop.height },
          { w: window.innerWidth, h: window.innerHeight },
          align,
        ),
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, align, items]);

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
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="menu-popover"
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
            // Fixed + clamped coords; hidden for the one pre-measure frame so it
            // never flashes at 0,0. useLayoutEffect sets `pos` before paint.
            style={{
              position: 'fixed',
              left: pos ? pos.left : 0,
              top: pos ? pos.top : 0,
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            <MenuItems items={items} focusedIndex={focused} onFocusIndex={setFocused} onSelectItem={selectItem} itemRefs={itemRefs} />
          </div>,
          document.body,
        )}
    </span>
  );
}
