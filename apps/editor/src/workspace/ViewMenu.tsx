/**
 * Toolbar "View" menu: one checkbox per workspace panel (open/close) plus
 * "Reset layout". Small hand-rolled popover — Escape closes, click-outside
 * closes, aria-expanded/menu roles for assistive tech.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { PANEL_TITLES, VIEW_MENU_PANELS, resetLayout, showPanel } from './Workspace';
import type { PanelId } from './layout';

export function ViewMenu({ dock, storageKey }: { dock: DockviewApi | null; storageKey: string }) {
  const [open, setOpen] = useState(false);
  const [openPanels, setOpenPanels] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Track which panels exist so the checkboxes stay honest while the user
  // drags/closes panels with the menu closed.
  useEffect(() => {
    if (!dock) {
      setOpenPanels(new Set());
      return;
    }
    const update = () => setOpenPanels(new Set(dock.panels.map((p) => p.id)));
    update();
    const disposables = [dock.onDidAddPanel(update), dock.onDidRemovePanel(update), dock.onDidLayoutFromJSON(update)];
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [dock]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function togglePanel(id: PanelId) {
    if (!dock) return;
    const panel = dock.getPanel(id);
    if (panel) panel.api.close();
    else showPanel(dock, id);
  }

  return (
    <span className="menu-root" ref={rootRef}>
      <button
        ref={buttonRef}
        className="btn btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!dock}
        onClick={() => setOpen((v) => !v)}
      >
        View
      </button>
      {open && dock && (
        <div className="menu-popover" role="menu" aria-label="View">
          {VIEW_MENU_PANELS.map((id) => {
            const checked = openPanels.has(id);
            return (
              <button
                key={id}
                className="menu-item"
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => togglePanel(id)}
              >
                <span className="menu-check" aria-hidden="true">
                  {checked ? '✓' : ''}
                </span>
                {PANEL_TITLES[id]}
              </button>
            );
          })}
          <div className="menu-separator" role="separator" />
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              resetLayout(dock, storageKey);
              setOpen(false);
            }}
          >
            <span className="menu-check" aria-hidden="true" />
            Reset layout
          </button>
        </div>
      )}
    </span>
  );
}
