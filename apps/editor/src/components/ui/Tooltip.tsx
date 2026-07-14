/**
 * Tooltip — the editor's single hover/focus hint primitive.
 *
 * Quiet by design: one short line of text, optional trailing shortcut chip.
 * Content is typed `string` on purpose — tooltips never carry instructional
 * prose; anything richer belongs in an empty state or the docs.
 *
 * Behavior contract (consumed by the toolbar/menu/button primitives):
 *  - hover shows after a ~300ms delay; keyboard focus shows instantly
 *    (matches :focus-visible — a click that focuses does not force it open);
 *  - a short "warm" window (module-level, shared across every tooltip) makes
 *    the next hover instant, so sweeping a toolbar doesn't re-pay the delay;
 *  - hide is always instant (pointer leave / blur / Escape);
 *  - portal-rendered to <body>, positioned off the trigger's rect with a
 *    viewport-edge flip; `role="tooltip"` + `aria-describedby` on the trigger.
 */
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** One short line. Not ReactNode by design — tooltips don't carry prose. */
  content: string;
  /** Optional shortcut, rendered as a trailing kbd chip (e.g. "Space", "⌘S"). */
  shortcut?: string;
  side?: TooltipSide;
  /** A single focusable element — the thing the tooltip describes. */
  children: ReactElement;
}

const SHOW_DELAY = 300;
const WARM_WINDOW = 500;
const GAP = 6;

/** Shared across all tooltips: when did *any* tooltip last hide. */
let lastHiddenAt = 0;

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref && typeof ref === 'object') (ref as { current: T | null }).current = value;
}

interface Coords {
  top: number;
  left: number;
  placement: TooltipSide;
}

export function Tooltip({ content, shortcut, side = 'top', children }: TooltipProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);

  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(false);
  // True while a pointer is pressing the trigger — used to tell a click-focus
  // (no tooltip) from a keyboard focus (instant tooltip), i.e. :focus-visible.
  const pointerActive = useRef(false);

  const clearShowTimer = useCallback(() => {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  }, []);

  const doShow = useCallback(() => {
    visibleRef.current = true;
    setVisible(true);
  }, []);

  const requestShow = useCallback(
    (instant: boolean) => {
      clearShowTimer();
      if (visibleRef.current) return;
      if (instant || Date.now() - lastHiddenAt < WARM_WINDOW) {
        doShow();
      } else {
        showTimer.current = setTimeout(doShow, SHOW_DELAY);
      }
    },
    [clearShowTimer, doShow],
  );

  const hide = useCallback(() => {
    clearShowTimer();
    if (visibleRef.current) {
      visibleRef.current = false;
      lastHiddenAt = Date.now();
      setVisible(false);
      setCoords(null);
    }
  }, [clearShowTimer]);

  // Clean up any pending timer if the trigger unmounts mid-delay.
  useEffect(() => clearShowTimer, [clearShowTimer]);

  // Position after the tooltip is in the DOM so we can measure it, then flip
  // off the nearest viewport edge. Runs before paint — no flash at 0,0.
  useLayoutEffect(() => {
    if (!visible) return;
    const trig = triggerRef.current?.getBoundingClientRect();
    const tipEl = tipRef.current;
    if (!trig || !tipEl) return;
    const rect = tipEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let placement = side;
    if (placement === 'top' && trig.top - rect.height - GAP < 0) placement = 'bottom';
    else if (placement === 'bottom' && trig.bottom + rect.height + GAP > vh) placement = 'top';
    else if (placement === 'left' && trig.left - rect.width - GAP < 0) placement = 'right';
    else if (placement === 'right' && trig.right + rect.width + GAP > vw) placement = 'left';

    let top = 0;
    let left = 0;
    switch (placement) {
      case 'top':
        top = trig.top - rect.height - GAP;
        left = trig.left + trig.width / 2 - rect.width / 2;
        break;
      case 'bottom':
        top = trig.bottom + GAP;
        left = trig.left + trig.width / 2 - rect.width / 2;
        break;
      case 'left':
        left = trig.left - rect.width - GAP;
        top = trig.top + trig.height / 2 - rect.height / 2;
        break;
      case 'right':
        left = trig.right + GAP;
        top = trig.top + trig.height / 2 - rect.height / 2;
        break;
    }
    // Keep it on screen.
    left = Math.max(4, Math.min(left, vw - rect.width - 4));
    top = Math.max(4, Math.min(top, vh - rect.height - 4));

    setCoords((prev) =>
      prev && prev.top === top && prev.left === left && prev.placement === placement
        ? prev
        : { top, left, placement },
    );
  }, [visible, side, content, shortcut]);

  const childRef = (children as unknown as { ref?: Ref<HTMLElement> }).ref;
  const childProps = children.props as Record<string, unknown>;

  const compose =
    <E,>(mine: (e: E) => void, theirs?: (e: E) => void) =>
    (e: E) => {
      theirs?.(e);
      mine(e);
    };

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      setRef(childRef, node);
    },
    'aria-describedby': visible ? id : (childProps['aria-describedby'] as string | undefined),
    onPointerEnter: compose(() => requestShow(false), childProps.onPointerEnter as (e: unknown) => void),
    onPointerLeave: compose(() => {
      pointerActive.current = false;
      hide();
    }, childProps.onPointerLeave as (e: unknown) => void),
    onPointerDown: compose(() => {
      pointerActive.current = true;
    }, childProps.onPointerDown as (e: unknown) => void),
    onFocus: compose(() => {
      // Keyboard focus (no active pointer press) shows instantly.
      if (!pointerActive.current) requestShow(true);
    }, childProps.onFocus as (e: unknown) => void),
    onBlur: compose(() => {
      pointerActive.current = false;
      hide();
    }, childProps.onBlur as (e: unknown) => void),
    onKeyDown: compose((e: { key: string }) => {
      if (e.key === 'Escape') hide();
    }, childProps.onKeyDown as (e: unknown) => void),
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {visible &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="tooltip"
            data-side={coords?.placement ?? side}
            style={{
              position: 'fixed',
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              // Hide the pre-measure frame so it never paints at 0,0.
              visibility: coords ? 'visible' : 'hidden',
            }}
          >
            <span className="tooltip-label">{content}</span>
            {shortcut ? <kbd className="tooltip-kbd">{shortcut}</kbd> : null}
          </div>,
          document.body,
        )}
    </>
  );
}
