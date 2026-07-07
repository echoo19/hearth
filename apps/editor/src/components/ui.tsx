/**
 * Small shared UI primitives: icons, modal dialog, confirm dialog.
 */
import React, { useEffect, useRef, type ReactNode } from 'react';

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
  play: <path d="M3.5 2.5l6 3.5-6 3.5z" fill="currentColor" />,
  stop: <rect x="3" y="3" width="6" height="6" fill="currentColor" stroke="none" />,
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

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog className="modal" ref={ref} onCancel={onClose} onClose={onClose}>
      {open && (
        <>
          <div className="modal-title">{title}</div>
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
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <div className="modal-body">
        <p>{body}</p>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm} autoFocus>
          {confirmLabel}
        </button>
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
      <button
        className="btn btn-ghost btn-sm copy-btn"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
