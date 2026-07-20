/**
 * Small shared UI primitives: icons, modal dialog, confirm dialog, and the
 * scalar field editors (NumberField/TextField/ColorField) every typed
 * Inspector control is built from.
 */
import React, { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui/Button';

// ---------------------------------------------------------------------------
// Field editors: value type decides the control. All commit on blur / Enter.
// Shared by Inspector.tsx, PostEffectsField.tsx, InputSettings.tsx, and
// anything else editing a typed scalar — kept here (rather than in
// Inspector.tsx) so those consumers don't have to import Inspector.tsx just
// to reach a field primitive, which used to create a circular import between
// Inspector.tsx and PostEffectsField.tsx.
//
// Rejection contract. A field's local `draft` only re-syncs
// from the `value` prop, so a commit the consumer rejects — one that leaves
// `value` unchanged — used to leave the bad draft on screen (and, for
// NumberField, silently commit `0` for an emptied field). To close that gap:
//   1. Fields validate client-side where the shape is known: empty/NaN/out-of
//      -range numbers and malformed hex never reach `onCommit`; they revert
//      the draft to `value` and flash a rejection cue.
//   2. `onCommit` may signal rejection by returning `false` or a non-empty
//      reason string (or a Promise / throw thereof). On rejection the draft
//      reverts to `value`, the input flashes the `field-reject` shake + gets
//      the `.invalid` border, and (TextField) the reason renders inline.
//      `void` / `true` / `''` mean accepted, preserving existing call sites.
// ---------------------------------------------------------------------------

/** What a field's `onCommit` may return. See the rejection contract above. */
export type CommitOutcome = void | boolean | string;
type CommitFn<T> = (value: T) => CommitOutcome | Promise<CommitOutcome>;

/** Core accepts #rgb, #rrggbb, or #rrggbbaa (schema/components.ts ColorSchema). */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

interface Settled {
  rejected: boolean;
  /** Human reason when rejected with a string; '' for a bare `false` reject. */
  message: string;
}

/** Interpret an `onCommit` return value (sync or async) per the contract. */
async function settleOutcome(
  outcome: CommitOutcome | Promise<CommitOutcome>,
): Promise<Settled> {
  try {
    const out = await outcome;
    if (out === false) return { rejected: true, message: '' };
    if (typeof out === 'string' && out !== '') return { rejected: true, message: out };
    return { rejected: false, message: '' };
  } catch (err) {
    return { rejected: true, message: err instanceof Error ? err.message : '' };
  }
}

/**
 * Shared rejection state for the scalar fields: the inline reason (if any) and
 * the one-shot shake cue. `revert()` puts the field back to server truth and
 * flashes; `clear()` drops the cue when the user resumes typing or a fresh
 * `value` arrives.
 *
 * It also owns the commit-staleness guard: an async rejection that settles
 * after the user has since typed a newer draft (or after a newer commit) must
 * not clobber that newer state. `beginCommit()` stamps a generation before
 * awaiting the outcome; `isCurrent(gen)` gates applying it. `clear()` (called
 * on every keystroke / Escape) and a fresh `value` prop both invalidate any
 * in-flight generation.
 */
function useRejectionCue(value: unknown) {
  const [message, setMessage] = useState('');
  const [shaking, setShaking] = useState(false);
  const genRef = useRef(0);
  // A fresh authoritative value means whatever was rejected is moot.
  useEffect(() => {
    genRef.current++;
    setMessage('');
    setShaking(false);
  }, [value]);
  const revert = useCallback((reason: string) => {
    setMessage(reason);
    setShaking(true);
  }, []);
  const clear = useCallback(() => {
    genRef.current++;
    setMessage('');
    setShaking(false);
  }, []);
  const beginCommit = useCallback(() => ++genRef.current, []);
  const isCurrent = useCallback((gen: number) => gen === genRef.current, []);
  const cueClass = `${shaking ? ' field-reject' : ''}${message || shaking ? ' invalid' : ''}`;
  const onAnimationEnd = useCallback(() => setShaking(false), []);
  return { message, cueClass, revert, clear, onAnimationEnd, beginCommit, isCurrent };
}

export function NumberField({
  value,
  min,
  max,
  integer = false,
  id,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  /** Reject non-integer drafts client-side (for schema fields with `.int()`). */
  integer?: boolean;
  /** DOM id for the input, so a `<label htmlFor>` can associate with it (L-109). */
  id?: string;
  onCommit: CommitFn<number>;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const cue = useRejectionCue(value);
  const commit = async () => {
    const parsed = Number(draft.trim());
    // Empty / non-numeric / out-of-range / non-integer never commits — revert + flash.
    const outOfRange =
      (min !== undefined && parsed < min) || (max !== undefined && parsed > max);
    const notInteger = integer && !Number.isInteger(parsed);
    if (draft.trim() === '' || !Number.isFinite(parsed) || outOfRange || notInteger) {
      setDraft(String(value));
      cue.revert('');
      return;
    }
    if (parsed === value) {
      cue.clear();
      return;
    }
    const gen = cue.beginCommit();
    const settled = await settleOutcome(onCommit(parsed));
    if (!cue.isCurrent(gen)) return; // a newer draft/commit superseded this one
    if (settled.rejected) {
      setDraft(String(value));
      cue.revert(settled.message);
    } else {
      cue.clear();
    }
  };
  return (
    <input
      id={id}
      className={`input${cue.cueClass}`}
      type="number"
      step={integer ? 1 : 'any'}
      min={min}
      max={max}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        cue.clear();
      }}
      onBlur={() => void commit()}
      onAnimationEnd={cue.onAnimationEnd}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(String(value));
          cue.clear();
        }
      }}
    />
  );
}

export function TextField({
  value,
  placeholder,
  id,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  /** DOM id for the input, so a `<label htmlFor>` can associate with it (L-109). */
  id?: string;
  onCommit: CommitFn<string>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const cue = useRejectionCue(value);
  const commit = async () => {
    if (draft === value) {
      cue.clear();
      return;
    }
    const gen = cue.beginCommit();
    const settled = await settleOutcome(onCommit(draft));
    if (!cue.isCurrent(gen)) return; // a newer draft/commit superseded this one
    if (settled.rejected) {
      setDraft(value);
      cue.revert(settled.message);
    } else {
      cue.clear();
    }
  };
  return (
    <div className="text-field">
      <input
        id={id}
        className={`input${cue.cueClass}`}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          cue.clear();
        }}
        onBlur={() => void commit()}
        onAnimationEnd={cue.onAnimationEnd}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(value);
            cue.clear();
          }
        }}
      />
      {cue.message && <span className="field-error">{cue.message}</span>}
    </div>
  );
}

export function ColorField({
  value,
  id,
  onCommit,
}: {
  value: string;
  /** DOM id for the hex text input (the labellable control), so `htmlFor` works (L-109). */
  id?: string;
  onCommit: CommitFn<string>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const cue = useRejectionCue(value);
  // The native swatch only ever reflects a valid color: while the draft is
  // being typed (or is invalid) it holds the last valid value rather than
  // silently snapping to a #ffffff fallback that diverges from what commits.
  const pickerValue = HEX_COLOR.test(draft) ? draft : HEX_COLOR.test(value) ? value : '#ffffff';
  const commit = async () => {
    if (draft === value) {
      cue.clear();
      return;
    }
    if (!HEX_COLOR.test(draft)) {
      setDraft(value);
      cue.revert('');
      return;
    }
    const gen = cue.beginCommit();
    const settled = await settleOutcome(onCommit(draft));
    if (!cue.isCurrent(gen)) return; // a newer draft/commit superseded this one
    if (settled.rejected) {
      setDraft(value);
      cue.revert(settled.message);
    } else {
      cue.clear();
    }
  };
  return (
    <div className="color-pair">
      <input
        type="color"
        value={pickerValue}
        onChange={(e) => {
          setDraft(e.target.value);
          cue.clear();
          const gen = cue.beginCommit();
          void settleOutcome(onCommit(e.target.value)).then((s) => {
            if (!cue.isCurrent(gen)) return;
            if (s.rejected) {
              setDraft(value);
              cue.revert(s.message);
            }
          });
        }}
        aria-label="Pick color"
      />
      <input
        id={id}
        className={`input mono${cue.cueClass}`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          cue.clear();
        }}
        onBlur={() => void commit()}
        onAnimationEnd={cue.onAnimationEnd}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(value);
            cue.clear();
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons — one minimal 12px stroke set so the whole surface shares a vocabulary
// ---------------------------------------------------------------------------

const ICON_PATHS: Record<string, ReactNode> = {
  // The Hearth mark ("Kept Flame") scaled to the 12px icon grid: arch with
  // the flame as negative space. Source of truth: assets/brand/hearth-mark.svg.
  flame: (
    <path
      d="M2.5 6.5 A3.5 3.5 0 0 1 9.5 6.5 L9.5 9.75 A0.75 0.75 0 0 1 8.75 10.5 L3.25 10.5 A0.75 0.75 0 0 1 2.5 9.75 Z M5.975 9.65 C4.95 9.65 4.2 8.925 4.2 7.95 C4.2 6.725 5.35 6.225 6.1 4 C6.875 4.925 7.775 6.175 7.775 7.525 C7.775 8.8 6.975 9.65 5.975 9.65 Z"
      fill="currentColor"
      fillRule="evenodd"
      stroke="none"
    />
  ),
  plus: <path d="M6 2.5v7M2.5 6h7" />,
  cross: <path d="M3 3l6 6M9 3l-6 6" />,
  chevron: <path d="M4.5 2.5L8 6l-3.5 3.5" />,
  entity: <rect x="2.5" y="2.5" width="7" height="7" rx="1" />,
  camera: (
    <>
      <rect x="1.5" y="3.5" width="6.5" height="5.5" rx="1" />
      <path d="M8 5.5l2.5-1.5v4.5L8 7" />
    </>
  ),
  text: <path d="M2.5 3h7M6 3v6.5" />,
  image: (
    <>
      <rect x="1.5" y="2" width="9" height="8" rx="1" />
      <path d="M1.5 8l2.5-2.5 2 2 2-2.5 2.5 3" />
    </>
  ),
  grid: <path d="M2 4.5h8M2 7.5h8M4.5 2v8M7.5 2v8" />,
  script: <path d="M4 3.5L2 6l2 2.5M8 3.5L10 6 8 8.5" />,
  // Folder: a script-tree directory (Code panel's nested scripts/ listing).
  folder: <path d="M1.5 9V3.5a1 1 0 0 1 1-1h2.3l1 1.2h3.7a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z" />,
  play: <path d="M3.5 2.5l6 3.5-6 3.5z" fill="currentColor" />,
  stop: <rect x="3" y="3" width="6" height="6" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="3" y="2.5" width="2" height="7" fill="currentColor" stroke="none" />
      <rect x="7" y="2.5" width="2" height="7" fill="currentColor" stroke="none" />
    </>
  ),
  // A play triangle butted against a bar — "advance one step" (frame-step glyph).
  step: (
    <>
      <path d="M2.5 2.5l4 3.5-4 3.5z" fill="currentColor" stroke="none" />
      <rect x="8" y="2.5" width="1.5" height="7" fill="currentColor" stroke="none" />
    </>
  ),
  copy: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <path d="M2.5 8V2.5H8" />
    </>
  ),
  pencil: <path d="M2.5 9.5l.6-2.4 5-5 1.8 1.8-5 5-2.4.6z" />,
  duplicate: (
    <>
      <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
      <path d="M2 7V2h5" />
    </>
  ),
  trash: <path d="M2.5 3.5h7M4 3.5V2.5h4v1M4.5 3.5l.4 6h2.2l.4-6" />,
  audio: <path d="M2.5 5v2h2L7 9.5v-7L4.5 5h-2zM8.5 4.5a2.5 2.5 0 0 1 0 3" />,
  upload: <path d="M6 8V2.5M3.5 4.5L6 2l2.5 2.5M2.5 9.5h7" />,
  physics: <circle cx="6" cy="6" r="3.8" />,
  collider: <rect x="2.5" y="2.5" width="7" height="7" rx="2" strokeDasharray="2 1.6" />,
  light: (
    <>
      <circle cx="6" cy="5" r="3" />
      <path d="M4.5 9.3h3M5 10.5h2" />
    </>
  ),
  line: <path d="M2 8.5L4.5 4.5 7 7.5 10 3" />,
  particles: (
    <>
      <circle cx="6" cy="9.5" r="0.9" fill="currentColor" stroke="none" />
      <path d="M6 7.5V3M6 3L4.3 4.7M6 3l1.7 1.7" />
    </>
  ),
  animator: (
    <>
      <rect x="2" y="3" width="8" height="6" rx="1" />
      <path d="M4.5 3v6M7.5 3v6" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="2.75" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="6" cy="6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="6" cy="9.25" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="M2.5 6.2L5 8.7l4.5-5" />,
  star: (
    <path
      d="M6 2l1.24 2.52 2.78.4-2.01 1.96.47 2.77L6 8.34 3.52 9.65l.47-2.77L1.98 4.92l2.78-.4z"
      fill="currentColor"
      stroke="none"
    />
  ),
  warning: (
    <>
      <path d="M6 2.2l4 6.8H2z" />
      <path d="M6 5v2M6 8.2v.05" />
    </>
  ),
  // Prefabs are "tracked stamps" (see wave design doc) — a stamp base with
  // its handle arch, distinct from `duplicate`'s overlapping-squares glyph.
  prefab: (
    <>
      <rect x="2.5" y="6" width="7" height="3.5" rx="1" />
      <path d="M4.5 6V4.2A1.5 1.5 0 0 1 6 2.7v0a1.5 1.5 0 0 1 1.5 1.5V6" />
    </>
  ),
  // ---- Toolbar / application-menu glyphs -----------------------------------
  // Undo / Redo: curved "return" arrows (↩ / ↪), reading as step-back /
  // step-forward rather than plain page navigation.
  undo: (
    <>
      <path d="M4.2 3.5 1.8 5.8l2.4 2.3" />
      <path d="M1.8 5.8H7a2.6 2.6 0 0 1 0 5.2H4.5" />
    </>
  ),
  redo: (
    <>
      <path d="M7.8 3.5 10.2 5.8l-2.4 2.3" />
      <path d="M10.2 5.8H5a2.6 2.6 0 0 0 0 5.2H7.5" />
    </>
  ),
  // Export: an arrow lifting up out of an open tray — "send this build out".
  export: (
    <>
      <path d="M6 7.5V2.5M4 4.5 6 2.5l2 2" />
      <path d="M2.5 7v2.5h7V7" />
    </>
  ),
  // Checkpoint: a planted flag — a marked point you can return to.
  checkpoint: (
    <>
      <path d="M3.2 10V2.2" />
      <path d="M3.2 2.8h5.2L7 4.6l1.4 1.8H3.2z" />
    </>
  ),
  // Review: an eye — "see what changed since your last checkpoint".
  review: (
    <>
      <path d="M1.5 6S3.5 3 6 3s4.5 3 4.5 3-2 3-4.5 3S1.5 6 1.5 6z" />
      <circle cx="6" cy="6" r="1.25" />
    </>
  ),
  // Debug: a bug — collider/velocity overlay toggle.
  debug: (
    <>
      <ellipse cx="6" cy="6.4" rx="2.3" ry="2.7" />
      <path d="M6 3.7V2.4M4.1 4.1 3 3M7.9 4.1 9 3M3.7 6.2H1.9M10.1 6.2H8.3M3.9 8.4 2.6 9.4M8.1 8.4l1.3 1M3.7 6.4h4.6" />
    </>
  ),
  // Close (project): a door with an arrow leaving — "log out" of the editor.
  close: (
    <>
      <path d="M6.5 2.5H3v7h3.5" />
      <path d="M5.5 6H10M8 4 10 6 8 8" />
    </>
  ),
  // Restart: a near-full circle with an arrowhead — replay the run.
  restart: (
    <>
      <path d="M9.4 6a3.4 3.4 0 1 1-1.05-2.45" />
      <path d="M9.6 2.6v1.9H7.7" />
    </>
  ),
  // Overflow: horizontal ellipsis (distinct from `more`'s vertical dots).
  overflow: (
    <>
      <circle cx="2.75" cy="6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="6" cy="6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="9.25" cy="6" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  // Search: magnifying glass — the Assets panel's name/type filter.
  search: (
    <>
      <circle cx="5.1" cy="5.1" r="3.1" />
      <path d="M7.5 7.5L10.2 10.2" />
    </>
  ),
  // Gear: Agent panel's settings menu trigger (mode ladder / re-detect / manual setup).
  gear: (
    <>
      <circle cx="6" cy="6" r="1.7" />
      <path d="M6 1.5v1.6M6 8.9v1.6M1.5 6h1.6M8.9 6h1.6M2.8 2.8l1.1 1.1M8.1 8.1l1.1 1.1M9.2 2.8L8.1 3.9M3.9 8.1L2.8 9.2" />
    </>
  ),
};

export function Icon({ name, size = 12 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name] ?? ICON_PATHS.entity}
    </svg>
  );
}

export function componentIcon(type: string): string {
  switch (type) {
    case 'Camera':
      return 'camera';
    case 'Text':
      return 'text';
    case 'SpriteRenderer':
      return 'image';
    case 'Tilemap':
      return 'grid';
    case 'Script':
      return 'script';
    case 'AudioSource':
      return 'audio';
    case 'PhysicsBody':
      return 'physics';
    case 'Collider':
      return 'collider';
    case 'Light2D':
      return 'light';
    case 'LineRenderer':
      return 'line';
    case 'ParticleEmitter':
      return 'particles';
    case 'SpriteAnimator':
      return 'animator';
    default:
      return 'entity';
  }
}

/** Pick the icon that best describes an entity from its components. */
export function entityIcon(components: Record<string, unknown>): string {
  for (const type of ['Camera', 'Text', 'Tilemap', 'SpriteRenderer', 'Script', 'AudioSource']) {
    if (components[type]) return componentIcon(type);
  }
  return 'entity';
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * Is the dialog currently a live top-layer modal? A dialog opened with
 * showModal() matches `:modal`; one that has `open` set but is NOT in the top
 * layer (e.g. after a remount stranded it) does not. jsdom has no `:modal`
 * support and throws on the selector, so fall back to the plain `open` flag
 * there — best-effort, and enough for the unit tests to exercise the reopen.
 */
export function isModalOpen(dialog: HTMLDialogElement): boolean {
  try {
    return dialog.matches(':modal');
  } catch {
    return dialog.open;
  }
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // L-109 (EXPORTDIALOG-2): name the dialog after its visible title so screen
  // readers announce "Export game, dialog" instead of a bare "dialog".
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      // Center-with-backdrop only holds while the dialog is in the top layer
      // (`:modal`). A dialog whose DOM node is remounted/reparented while open
      // keeps `dialog.open === true` but silently drops out of the top layer —
      // it then lays out in normal flow (bottom-right of its parent), the
      // L-124 symptom. Recover by re-showing: close any stale open state first
      // (showModal throws if the dialog is already open) then showModal to
      // re-enter the top layer.
      if (dialog.isConnected && !isModalOpen(dialog)) {
        if (dialog.open) dialog.close();
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog className="modal" ref={ref} onCancel={onClose} onClose={onClose} aria-labelledby={titleId}>
      {open && (
        <>
          <div className="modal-title" id={titleId}>
            {title}
          </div>
          {children}
        </>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Deterministic initial focus (L-022 / HIER-13): React's `autoFocus` on the
  // confirm button raced showModal()'s own focus-the-first-focusable (Cancel)
  // and the winner was accidental. The decision is now explicit: a `danger`
  // confirm focuses Cancel (Enter must not destroy anything by reflex), a
  // plain confirm focuses the confirm button. The effect runs after Modal's
  // child effect calls showModal(), so it always lands last.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    (danger ? cancelRef : confirmRef).current?.focus();
  }, [open, danger]);
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <div className="modal-body">
        <p>{body}</p>
      </div>
      <div className="modal-actions">
        <Button ref={cancelRef} onClick={onCancel}>
          Cancel
        </Button>
        <Button ref={confirmRef} variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Copyable code block
// ---------------------------------------------------------------------------

export function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="code-block">
      <pre>{code}</pre>
      <Button
        variant="ghost"
        size="sm"
        className="copy-btn"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
