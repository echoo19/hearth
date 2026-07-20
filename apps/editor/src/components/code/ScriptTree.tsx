/**
 * The Code panel's script list, as a tree (script modules): nested
 * paths like scripts/lib/noise.lua render under their folder instead of as
 * flat rows, and hookless scripts wear a "library" badge so a human can tell
 * helpers from behaviors at a glance. Deliberately the same tree idiom as the
 * Hierarchy panel — the shared `treeNav` keyboard contract (roving tabindex,
 * arrows/Home/End, Left/Right collapse-expand), the same .tree/.tree-row/
 * .tree-caret classes — rather than a second tree implementation.
 *
 * One deliberate divergence from Hierarchy: arrow keys move FOCUS ONLY, and
 * activation (Enter/Space/click) is what opens a script. Hierarchy selects on
 * every arrow move because selection there is cheap and reversible; here
 * "select" means opening an editor buffer, and arrowing through 20 rows must
 * not open 20 tabs.
 *
 * Plain React, no CodeMirror imports — CodePanel mounts this eagerly, outside
 * the lazy CM6 boundary (same constraint as SearchAcross.tsx).
 */
import React, { useMemo, useRef, useState } from 'react';
import { Icon } from '../ui';
import { isActivationKey, treeNav } from '../Hierarchy';

// ---------------------------------------------------------------------------
// Pure tree model — no DOM, no store. Exported for unit tests
// (scriptTree.test.ts), same as Hierarchy.tsx's flattenVisible/treeNav.
// ---------------------------------------------------------------------------

export interface ScriptTreeRow {
  /** Folder rows: the directory path ('scripts/lib'); script rows: the full
   * script path ('scripts/lib/noise.lua'). Unique across the tree. */
  id: string;
  /** The containing folder's id, or null for a row directly under scripts/
   * (the scripts root itself is implicit and never rendered). */
  parentId: string | null;
  /** Last path segment — the row's visible label. */
  name: string;
  kind: 'folder' | 'script';
  depth: number;
  hasChildren: boolean;
}

interface TreeNode {
  id: string;
  name: string;
  kind: 'folder' | 'script';
  children: Map<string, TreeNode>;
}

/** Folders group before scripts; within a kind, case-insensitive by name. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Flatten `paths` (project-relative, 'scripts/...' prefixed) into the visible
 * tree rows, pre-order, skipping the subtrees of collapsed folder ids. A flat
 * project (no subdirectories) yields exactly one depth-0 script row per path.
 */
export function buildScriptRows(paths: string[], collapsed: ReadonlySet<string>): ScriptTreeRow[] {
  const root: TreeNode = { id: 'scripts', name: 'scripts', kind: 'folder', children: new Map() };
  for (const path of paths) {
    const segments = path.split('/');
    // segments[0] is the 'scripts' root; walk/create folder nodes for the
    // middle segments, then hang the script leaf off the last folder.
    let node = root;
    for (let i = 1; i < segments.length - 1; i++) {
      const id = segments.slice(0, i + 1).join('/');
      let child = node.children.get(id);
      if (!child) {
        child = { id, name: segments[i], kind: 'folder', children: new Map() };
        node.children.set(id, child);
      }
      node = child;
    }
    node.children.set(path, { id: path, name: segments[segments.length - 1], kind: 'script', children: new Map() });
  }

  const rows: ScriptTreeRow[] = [];
  const walk = (parent: TreeNode, depth: number) => {
    const parentId = parent === root ? null : parent.id;
    for (const node of [...parent.children.values()].sort(compareNodes)) {
      rows.push({
        id: node.id,
        parentId,
        name: node.name,
        kind: node.kind,
        depth,
        hasChildren: node.children.size > 0,
      });
      if (node.children.size > 0 && !collapsed.has(node.id)) walk(node, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ScriptTreeProps {
  /** Project-relative script paths (info.scripts), 'scripts/...' prefixed. */
  scripts: string[];
  /** Paths classified as libraries (no lifecycle hooks) — see scriptKinds.ts. */
  libraries: ReadonlySet<string>;
  /** The buffer currently active in the editor, shown as the selected row. */
  activePath: string | null;
  onOpen: (path: string) => void;
}

export function ScriptTree({ scripts, libraries, activePath, onOpen }: ScriptTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Roving-tabindex cursor. Unlike Hierarchy (focus follows selection), this
   * tree keeps its own cursor so arrowing never opens buffers. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const rows = useMemo(() => buildScriptRows(scripts, collapsed), [scripts, collapsed]);
  const navRows = useMemo(
    () => rows.map((r) => ({ entity: { id: r.id, parentId: r.parentId }, hasChildren: r.hasChildren })),
    [rows],
  );

  const visible = (id: string | null) => id !== null && rows.some((r) => r.id === id);
  // The single tab stop: the cursor row if it's still visible, else the active
  // script's row, else the first row.
  const focusableId = visible(focusedId) ? focusedId : visible(activePath) ? activePath : (rows[0]?.id ?? null);

  function setCollapsedState(id: string, value: boolean) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function focusRow(id: string) {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }

  function activate(row: ScriptTreeRow) {
    setFocusedId(row.id);
    if (row.kind === 'folder') setCollapsedState(row.id, !collapsed.has(row.id));
    else onOpen(row.id);
  }

  function onTreeKeyDown(e: React.KeyboardEvent) {
    const action = treeNav(navRows, collapsed, focusableId, e.key);
    if (!action) return;
    e.preventDefault();
    if (action.type === 'select') focusRow(action.id);
    else if (action.type === 'expand') setCollapsedState(action.id, false);
    else if (action.type === 'collapse') setCollapsedState(action.id, true);
  }

  function renderRow(row: ScriptTreeRow): React.ReactNode {
    const isCollapsed = collapsed.has(row.id);
    const isActive = row.kind === 'script' && row.id === activePath;
    return (
      <div
        key={row.id}
        ref={(el) => {
          if (el) rowRefs.current.set(row.id, el);
          else rowRefs.current.delete(row.id);
        }}
        className={`tree-row${isActive ? ' selected' : ''}`}
        style={{ '--depth': row.depth } as React.CSSProperties}
        role="treeitem"
        aria-selected={isActive}
        aria-level={row.depth + 1}
        aria-expanded={row.kind === 'folder' ? !isCollapsed : undefined}
        tabIndex={row.id === focusableId ? 0 : -1}
        onClick={() => activate(row)}
        onFocus={() => setFocusedId(row.id)}
        onKeyDown={(e) => {
          if (isActivationKey(e.key)) {
            e.preventDefault();
            activate(row);
          }
        }}
      >
        {row.kind === 'folder' ? (
          <button
            className={`tree-caret${isCollapsed ? '' : ' open'}`}
            onClick={(e) => {
              e.stopPropagation();
              setCollapsedState(row.id, !isCollapsed);
            }}
            tabIndex={-1}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
          >
            <Icon name="chevron" size={10} />
          </button>
        ) : (
          <span className="tree-caret" />
        )}
        <span className="entity-icon">
          <Icon name={row.kind === 'folder' ? 'folder' : 'script'} />
        </span>
        <span className="tree-name">{row.name}</span>
        {row.kind === 'script' && libraries.has(row.id) && (
          // Plain visible text, not a hover hint: telling helpers from
          // behaviors at a glance is the point, and the picker/require story
          // is spelled out where it matters (the Inspector's Script field).
          <span className="script-library-badge">library</span>
        )}
      </div>
    );
  }

  return (
    <div className="tree" role="tree" aria-label="Scripts" onKeyDown={onTreeKeyDown}>
      {rows.map((row) => renderRow(row))}
    </div>
  );
}
