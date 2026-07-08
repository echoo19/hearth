/**
 * Keyboard-shortcut cheat sheet. A native <dialog> overlay rendered entirely
 * from the KEYBINDS table (via groupedKeybinds), so it can never drift from
 * what the dispatcher actually does — see apps/editor/tests/keybinds.test.ts.
 *
 * Opened by `?` (the dispatcher's shift+/ binding toggles store state) or the
 * View menu's "Keyboard shortcuts" item. Closed by Esc (dialog cancel),
 * clicking the backdrop, or pressing `?` again while open.
 */
import React, { useEffect, useRef } from 'react';
import { useEditor } from '../store';
import { comboDisplay, groupedKeybinds } from '../keybinds';

export function ShortcutSheet() {
  const open = useEditor((s) => s.shortcutSheetOpen);
  const setOpen = useEditor((s) => s.setShortcutSheet);
  const ref = useRef<HTMLDialogElement>(null);
  const groups = groupedKeybinds();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      className="shortcut-sheet"
      ref={ref}
      aria-label="Keyboard shortcuts"
      onCancel={() => setOpen(false)}
      onClose={() => setOpen(false)}
      // Clicking the backdrop (target is the dialog itself, not its content) closes.
      onClick={(e) => {
        if (e.target === ref.current) setOpen(false);
      }}
      // A second `?` while open toggles it back off, matching the dispatcher.
      // The dispatcher's own `?` is suppressed while a <dialog> is open, so
      // this is the sole close-on-`?` path. Accept both the produced char and
      // shift+/ (some layouts/synthetic events report the physical key).
      onKeyDown={(e) => {
        if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      {open && (
        <div className="shortcut-sheet-inner">
          <div className="shortcut-sheet-head">
            <div className="shortcut-sheet-title">Keyboard shortcuts</div>
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close">
              Close
            </button>
          </div>
          <div className="shortcut-sheet-groups">
            {groups.map(({ group, binds }) => (
              <section key={group} className="shortcut-group">
                <h3 className="shortcut-group-title">{group}</h3>
                <ul className="shortcut-list">
                  {binds.map((b) => (
                    <li key={b.id} className="shortcut-row">
                      <span className="shortcut-label">{b.label}</span>
                      <kbd className="shortcut-keys">{comboDisplay(b.combo)}</kbd>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="shortcut-sheet-foot">
            Press <kbd className="shortcut-keys">{comboDisplay('shift+/')}</kbd> anytime to open this list.
          </p>
        </div>
      )}
    </dialog>
  );
}
