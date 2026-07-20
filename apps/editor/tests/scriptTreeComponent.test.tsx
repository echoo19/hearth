// @vitest-environment jsdom
/**
 * The Code panel's script tree (script modules, human surface):
 * nested paths render as a real ARIA tree (folder rows, aria-level), library
 * scripts wear the "library" badge, and the keyboard contract is the shared
 * Hierarchy treeNav one — roving tabindex, arrows move a focus cursor
 * WITHOUT opening buffers, Enter/Space activates, Left/Right collapse/expand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { ScriptTree } from '../src/components/code/ScriptTree';

afterEach(() => cleanup());

const SCRIPTS = ['scripts/player.lua', 'scripts/lib/noise.lua', 'scripts/enemy.lua'];

function tree(overrides: Partial<React.ComponentProps<typeof ScriptTree>> = {}) {
  const onOpen = vi.fn();
  render(
    <ScriptTree
      scripts={SCRIPTS}
      libraries={new Set(['scripts/lib/noise.lua'])}
      activePath={null}
      onOpen={onOpen}
      {...overrides}
    />,
  );
  return { onOpen };
}

/** The treeitem row whose .tree-name label is exactly `label` (row accessible
 * names also carry caret/badge text, so match the label span directly). */
function rowNamed(label: string): HTMLElement {
  const name = screen.getAllByText(label).find((el) => el.classList.contains('tree-name'));
  if (!name) throw new Error(`no tree row labeled ${label}`);
  return name.closest('[role="treeitem"]') as HTMLElement;
}

function queryRowNamed(label: string): HTMLElement | null {
  const name = screen.queryAllByText(label).find((el) => el.classList.contains('tree-name'));
  return name ? (name.closest('[role="treeitem"]') as HTMLElement) : null;
}

describe('ScriptTree', () => {
  it('renders nested paths as a tree: a folder row with the script one level deeper', () => {
    tree();
    const lib = rowNamed('lib');
    const noise = rowNamed('noise.lua');
    expect(lib.getAttribute('aria-level')).toBe('1');
    expect(lib.getAttribute('aria-expanded')).toBe('true');
    expect(noise.getAttribute('aria-level')).toBe('2');
    // Top-level scripts stay at level 1.
    expect(rowNamed('player.lua').getAttribute('aria-level')).toBe('1');
  });

  it('labels a hookless script as a library — and only that one', () => {
    tree();
    const badges = screen.getAllByText('library');
    expect(badges).toHaveLength(1);
    expect(rowNamed('noise.lua').textContent).toContain('library');
    expect(rowNamed('player.lua').textContent).not.toContain('library');
  });

  it('opens a script on click and on Enter, but never on arrow movement', () => {
    const { onOpen } = tree();
    const first = screen.getAllByRole('treeitem')[0]; // 'lib' folder (folders sort first)
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' }); // → noise.lua
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(rowNamed('noise.lua'), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('scripts/lib/noise.lua');
    fireEvent.click(rowNamed('player.lua'));
    expect(onOpen).toHaveBeenCalledWith('scripts/player.lua');
  });

  it('collapses a folder with ArrowLeft, hiding its children', () => {
    tree();
    const lib = rowNamed('lib');
    lib.focus();
    fireEvent.keyDown(lib, { key: 'ArrowLeft' });
    expect(rowNamed('lib').getAttribute('aria-expanded')).toBe('false');
    expect(queryRowNamed('noise.lua')).toBeNull();
  });

  it('keeps exactly one tab stop (roving tabindex)', () => {
    tree();
    const rows = screen.getAllByRole('treeitem');
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(rows.filter((r) => r.tabIndex === -1)).toHaveLength(rows.length - 1);
  });

  it('marks the active buffer as the selected row', () => {
    tree({ activePath: 'scripts/player.lua' });
    expect(rowNamed('player.lua').getAttribute('aria-selected')).toBe('true');
    expect(rowNamed('enemy.lua').getAttribute('aria-selected')).toBe('false');
  });
});
