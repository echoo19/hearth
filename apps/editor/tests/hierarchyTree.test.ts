import { describe, expect, it } from 'vitest';
import {
  descendantIds,
  flattenVisible,
  treeNav,
  type FlatRow,
} from '../src/components/Hierarchy';
import { clampMenuOrigin } from '../src/components/ui/Menu';
import type { SceneEntity } from '../src/types';

function ent(id: string, parentId: string | null): SceneEntity {
  return { id, name: id, parentId, enabled: true, tags: [], components: {}, position: null, children: [] };
}

// Tree:  a -> (b -> (c), d),  e
function childMap(): Map<string | null, SceneEntity[]> {
  const entities = [ent('a', null), ent('b', 'a'), ent('c', 'b'), ent('d', 'a'), ent('e', null)];
  const map = new Map<string | null, SceneEntity[]>();
  for (const e of entities) {
    const list = map.get(e.parentId) ?? [];
    list.push(e);
    map.set(e.parentId, list);
  }
  return map;
}

const ids = (rows: FlatRow[]) => rows.map((r) => r.entity.id);

describe('flattenVisible', () => {
  it('pre-orders the whole tree when nothing is collapsed', () => {
    const rows = flattenVisible(childMap(), new Set());
    expect(ids(rows)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('hides the subtree of a collapsed node', () => {
    const rows = flattenVisible(childMap(), new Set(['b']));
    expect(ids(rows)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('reports depth and hasChildren', () => {
    const rows = flattenVisible(childMap(), new Set());
    const byId = new Map(rows.map((r) => [r.entity.id, r]));
    expect(byId.get('a')).toMatchObject({ depth: 0, hasChildren: true });
    expect(byId.get('b')).toMatchObject({ depth: 1, hasChildren: true });
    expect(byId.get('c')).toMatchObject({ depth: 2, hasChildren: false });
    expect(byId.get('e')).toMatchObject({ depth: 0, hasChildren: false });
  });
});

describe('descendantIds (drag cycle guard)', () => {
  it('collects the full subtree', () => {
    expect(descendantIds(childMap(), 'a')).toEqual(new Set(['b', 'c', 'd']));
  });

  it('is empty for a leaf', () => {
    expect(descendantIds(childMap(), 'c')).toEqual(new Set());
  });
});

describe('treeNav (keyboard tree contract)', () => {
  const rows = flattenVisible(childMap(), new Set());

  it('Down/Up move by one visible row', () => {
    expect(treeNav(rows, new Set(), 'a', 'ArrowDown')).toEqual({ type: 'select', id: 'b' });
    expect(treeNav(rows, new Set(), 'b', 'ArrowUp')).toEqual({ type: 'select', id: 'a' });
  });

  it('Down clamps at the last row; Up at the first', () => {
    expect(treeNav(rows, new Set(), 'e', 'ArrowDown')).toEqual({ type: 'select', id: 'e' });
    expect(treeNav(rows, new Set(), 'a', 'ArrowUp')).toEqual({ type: 'select', id: 'a' });
  });

  it('Home/End jump to the ends', () => {
    expect(treeNav(rows, new Set(), 'c', 'Home')).toEqual({ type: 'select', id: 'a' });
    expect(treeNav(rows, new Set(), 'c', 'End')).toEqual({ type: 'select', id: 'e' });
  });

  it('Right expands a collapsed parent, then steps into it', () => {
    const collapsedRows = flattenVisible(childMap(), new Set(['a']));
    expect(treeNav(collapsedRows, new Set(['a']), 'a', 'ArrowRight')).toEqual({ type: 'expand', id: 'a' });
    // Expanded parent: Right steps into the first child.
    expect(treeNav(rows, new Set(), 'a', 'ArrowRight')).toEqual({ type: 'select', id: 'b' });
  });

  it('Right on a leaf does nothing', () => {
    expect(treeNav(rows, new Set(), 'c', 'ArrowRight')).toBeNull();
  });

  it('Left collapses an expanded parent, then steps out to the parent', () => {
    expect(treeNav(rows, new Set(), 'a', 'ArrowLeft')).toEqual({ type: 'collapse', id: 'a' });
    // Leaf (or already-collapsed): Left moves to the parent row.
    expect(treeNav(rows, new Set(), 'c', 'ArrowLeft')).toEqual({ type: 'select', id: 'b' });
  });

  it('Left on a root leaf does nothing', () => {
    expect(treeNav(rows, new Set(), 'e', 'ArrowLeft')).toBeNull();
  });

  it('selects the first row when there is no current selection', () => {
    expect(treeNav(rows, new Set(), null, 'ArrowDown')).toEqual({ type: 'select', id: 'a' });
  });
});

describe('clampMenuOrigin (context-menu viewport flip)', () => {
  const vp = { w: 1000, h: 800 };

  it('leaves an in-bounds menu where the cursor is', () => {
    expect(clampMenuOrigin({ x: 100, y: 100 }, { w: 200, h: 300 }, vp)).toEqual({ x: 100, y: 100 });
  });

  it('shifts a menu back inside the right/bottom edges', () => {
    const pos = clampMenuOrigin({ x: 950, y: 750 }, { w: 200, h: 300 }, vp, 4);
    expect(pos.x).toBe(1000 - 200 - 4);
    expect(pos.y).toBe(800 - 300 - 4);
  });

  it('never pushes past the top/left when the menu is larger than the viewport', () => {
    const pos = clampMenuOrigin({ x: 10, y: 10 }, { w: 2000, h: 2000 }, vp, 4);
    expect(pos).toEqual({ x: 4, y: 4 });
  });
});
