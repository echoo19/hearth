// @vitest-environment jsdom
/**
 * Toolbar application menu bar.
 *
 * The full Toolbar is heavily store/dock/API-bound; its logic lives in the
 * pure `buildAppMenu` model (appMenu.test.ts) and the shared MenuButton
 * primitive (menu.test.tsx). This file pins the browser menu-bar surface that
 * ties them together: the File/Edit/View/Help strip renders from the model,
 * shows the moved-off-toolbar actions with their registry shortcuts, greys out
 * project-scoped items when nothing is open, reflects panel/debug checkboxes,
 * and fires the model's onSelect on click.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MenuBar } from '../src/menu/MenuBar';
import { buildAppMenu, type AppMenuContext } from '../src/menu/appMenu';
import { comboDisplay } from '../src/keybinds';
import type { EditorStore } from '../src/store';

afterEach(() => cleanup());

function mockStore(over: Partial<EditorStore> = {}): EditorStore {
  return {
    info: { id: 'p', name: 'Demo', scenes: [] },
    debugDraw: false,
    checkpoint: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    closeProject: vi.fn(),
    requestCodeSearch: vi.fn(),
    setDebugDraw: vi.fn(),
    setShortcutSheet: vi.fn(),
    ...over,
  } as unknown as EditorStore;
}

function ctx(over: Partial<AppMenuContext> = {}): AppMenuContext {
  return {
    canUndo: true,
    canRedo: false,
    onNewScene: vi.fn(),
    onExport: vi.fn(),
    onReview: vi.fn(),
    openDocs: vi.fn(),
    checkForUpdates: null,
    view: {
      panels: [
        { id: 'hierarchy', label: 'Hierarchy', open: true },
        { id: 'inspector', label: 'Inspector', open: false },
      ],
      togglePanel: vi.fn(),
      resetLayout: vi.fn(),
      canReset: true,
    },
    ...over,
  };
}

function renderBar(store = mockStore(), c = ctx()) {
  render(<MenuBar sections={buildAppMenu(store, c)} />);
}

describe('MenuBar', () => {
  it('renders the File / Edit / View / Help strip', () => {
    renderBar();
    for (const label of ['File', 'Edit', 'View', 'Help']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('surfaces the moved-off-toolbar File actions with their registry shortcut', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    for (const label of ['New scene…', 'Save checkpoint', 'Review changes', 'Export…', 'Close project']) {
      expect(screen.getByRole('menuitem', { name: new RegExp(label.replace('…', '')) })).toBeTruthy();
    }
    // Shortcut comes from the keybind registry (never hardcoded in the menu).
    expect(screen.getByText(comboDisplay('shift+mod+s'))).toBeTruthy();
  });

  it('greys out project-scoped items when no project is open', () => {
    renderBar(mockStore({ info: null }), ctx({ view: null }));
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect((screen.getByRole('menuitem', { name: /New scene/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reflects panel open-state as View checkboxes', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Hierarchy' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Inspector' }).getAttribute('aria-checked')).toBe('false');
  });

  it('fires the model onSelect on click (Edit → Undo routes to the store)', () => {
    const store = mockStore();
    renderBar(store);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Undo/ }));
    expect(store.undo).toHaveBeenCalledTimes(1);
  });

  it('disables Redo (empty redo history) while enabling Undo', () => {
    renderBar(mockStore(), ctx({ canUndo: true, canRedo: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByRole('menuitem', { name: /Undo/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('menuitem', { name: /Redo/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
