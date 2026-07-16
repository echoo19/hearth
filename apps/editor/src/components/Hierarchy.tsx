import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import type { SceneEntity } from '../types';
import { uniqueName as computeUniqueName } from '../uniqueName';
import { ConfirmDialog, Icon, entityIcon } from './ui';
import { Button, IconButton } from './ui/Button';
import { ContextMenu, type MenuItem } from './ui/Menu';
import { Tooltip } from './ui/Tooltip';
import { isLivePrefabInstance } from '../prefabActions';

// Tree rows are clickable divs, not native buttons — Enter/Space is the
// keyboard equivalent of the click that selects a row. Exported (module
// scope, not a closure) so it's unit-testable without a DOM.
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

// ---------------------------------------------------------------------------
// Pure tree helpers — no DOM, no React. Exported so the keyboard-nav contract
// (HIER-5) and the drag cycle-guard (HIER-2) are unit-testable in isolation.
// ---------------------------------------------------------------------------

export interface FlatRow {
  entity: SceneEntity;
  depth: number;
  hasChildren: boolean;
}

/** The rows currently visible in the tree, pre-order, respecting `collapsed`. */
export function flattenVisible(
  childrenOf: Map<string | null, SceneEntity[]>,
  collapsed: Set<string>,
): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const entity of childrenOf.get(parentId) ?? []) {
      const kids = childrenOf.get(entity.id) ?? [];
      out.push({ entity, depth, hasChildren: kids.length > 0 });
      if (kids.length > 0 && !collapsed.has(entity.id)) walk(entity.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Every descendant id of `rootId` — the set a reparent must never drop into. */
export function descendantIds(
  childrenOf: Map<string | null, SceneEntity[]>,
  rootId: string,
): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const c of childrenOf.get(id) ?? []) {
      out.add(c.id);
      walk(c.id);
    }
  };
  walk(rootId);
  return out;
}

export type TreeNavAction =
  | { type: 'select'; id: string }
  | { type: 'expand'; id: string }
  | { type: 'collapse'; id: string }
  | null;

/** The minimum a row's node must expose for treeNav — generic so the Code
 * panel's script tree (folders + scripts, not scene entities) shares this
 * exact keyboard contract instead of growing a second tree idiom. */
export interface TreeNavNode {
  id: string;
  parentId?: string | null;
}

/**
 * Standard ARIA tree keyboard contract, as a pure function of the visible rows.
 * Up/Down move by one visible row; Home/End jump to the ends; Right expands a
 * collapsed parent then steps into it; Left collapses an expanded parent then
 * steps out to the parent row. Returns the action to apply, or null for a no-op.
 */
export function treeNav<E extends TreeNavNode>(
  rows: ReadonlyArray<{ entity: E; hasChildren: boolean }>,
  collapsed: Set<string>,
  currentId: string | null,
  key: string,
): TreeNavAction {
  if (rows.length === 0) return null;
  const idx = rows.findIndex((r) => r.entity.id === currentId);
  const cur = idx >= 0 ? rows[idx] : null;
  switch (key) {
    case 'ArrowDown':
      return { type: 'select', id: rows[idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1)].entity.id };
    case 'ArrowUp':
      return { type: 'select', id: rows[idx < 0 ? rows.length - 1 : Math.max(0, idx - 1)].entity.id };
    case 'Home':
      return { type: 'select', id: rows[0].entity.id };
    case 'End':
      return { type: 'select', id: rows[rows.length - 1].entity.id };
    case 'ArrowRight':
      if (!cur) return { type: 'select', id: rows[0].entity.id };
      if (cur.hasChildren && collapsed.has(cur.entity.id)) return { type: 'expand', id: cur.entity.id };
      if (cur.hasChildren && idx + 1 < rows.length) return { type: 'select', id: rows[idx + 1].entity.id };
      return null;
    case 'ArrowLeft':
      if (!cur) return null;
      if (cur.hasChildren && !collapsed.has(cur.entity.id)) return { type: 'collapse', id: cur.entity.id };
      if (cur.entity.parentId && rows.some((r) => r.entity.id === cur.entity.parentId)) {
        return { type: 'select', id: cur.entity.parentId };
      }
      return null;
    default:
      return null;
  }
}

function isInputTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

// Sentinel drop target: dropping on the panel background reparents to scene root.
const ROOT_DROP = '__root__';

export function Hierarchy() {
  const scene = useEditor((s) => s.scene);
  const sceneId = useEditor((s) => s.sceneId);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);
  const assets = useEditor((s) => s.assets);
  const deleteSelectionRequest = useEditor((s) => s.deleteSelectionRequest);
  const playing = useEditor((s) => s.playing);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<SceneEntity | null>(null);
  const [savingPrefab, setSavingPrefab] = useState<string | null>(null);
  const [prefabNameValue, setPrefabNameValue] = useState('');
  const [prefabError, setPrefabError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entity: SceneEntity | null;
    /** The invoking row, so dismissing the menu restores roving-tabindex focus. */
    returnFocus: HTMLElement | null;
  } | null>(null);

  // Drag-to-reparent state (HIER-2). `dragId` is the entity being dragged;
  // `dropId` is the current drop target (a row id, or ROOT_DROP for the
  // background). Both cleared on drop / dragend / Escape (native DnD fires
  // dragend when Escape cancels a drag).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const dwellRef = useRef<{ id: string; timer: number } | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  function prefabAssetName(assetId: string): string {
    return assets.find((a) => a.id === assetId)?.name ?? assetId;
  }

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, SceneEntity[]>();
    for (const e of scene?.entities ?? []) {
      const list = map.get(e.parentId) ?? [];
      list.push(e);
      map.set(e.parentId, list);
    }
    return map;
  }, [scene]);

  const rows = useMemo(() => flattenVisible(childrenOf, collapsed), [childrenOf, collapsed]);

  // Descendants of the dragged entity — a reparent must never drop into its own
  // subtree (the engine cycle-guard would reject it; we prevent the drop first).
  const dragDescendants = useMemo(
    () => (dragId ? descendantIds(childrenOf, dragId) : null),
    [dragId, childrenOf],
  );

  const names = useMemo(() => new Set((scene?.entities ?? []).map((e) => e.name)), [scene]);

  function uniqueName(base: string): string {
    return computeUniqueName(names, base);
  }

  // Delete/Backspace keybind routes through the store request so it opens the
  // SAME ConfirmDialog as the row trash button — one deletion contract (HIER-3).
  const lastDeleteReq = useRef(deleteSelectionRequest);
  useEffect(() => {
    if (deleteSelectionRequest === lastDeleteReq.current) return;
    lastDeleteReq.current = deleteSelectionRequest;
    const entity = scene?.entities.find((e) => e.id === selection);
    if (entity) setDeleting(entity);
  }, [deleteSelectionRequest, scene, selection]);

  function clearDwell() {
    if (dwellRef.current) {
      clearTimeout(dwellRef.current.timer);
      dwellRef.current = null;
    }
  }

  function endDrag() {
    setDragId(null);
    setDropId(null);
    clearDwell();
  }

  async function addEntity(parent?: string) {
    if (!sceneId) return;
    const result = await exec<{ entityId: string }>('createEntity', {
      scene: sceneId,
      name: uniqueName(parent ? 'Child' : 'Entity'),
      ...(parent ? { parent } : {}),
    });
    if (result.success && result.data) {
      // Reveal a new child under a collapsed parent.
      if (parent) setCollapsed((prev) => { const n = new Set(prev); n.delete(parent); return n; });
      select(result.data.entityId);
    }
  }

  async function duplicate(entity: SceneEntity) {
    if (!sceneId) return;
    // duplicateEntity clones the full descendant subtree (fresh ids for every
    // copy) and picks a default "<name> copy" + position offset on its own —
    // no need to precompute a name or hand-copy components/children here.
    const result = await exec<{ entityId: string }>('duplicateEntity', {
      scene: sceneId,
      entity: entity.id,
    });
    if (result.success && result.data) select(result.data.entityId);
  }

  function startRename(entity: SceneEntity) {
    setRenaming(entity.id);
    setRenameValue(entity.name);
  }

  function startSavePrefab(entity: SceneEntity) {
    setSavingPrefab(entity.id);
    setPrefabNameValue(entity.name);
  }

  async function commitRename(entity: SceneEntity) {
    const newName = renameValue.trim();
    setRenaming(null);
    if (!sceneId || !newName || newName === entity.name) return;
    const result = await exec<{ name: string }>('renameEntity', { scene: sceneId, entity: entity.id, newName });
    // The command auto-suffixes a colliding rename (L-011). The row settles to
    // the actual name via scene state; name why it differs so the settle isn't
    // silent (the field would otherwise look like it "changed the name on you").
    if (result.success && result.data && result.data.name !== newName) {
      log('info', 'editor', `Renamed to "${result.data.name}": "${newName}" is already taken.`);
    }
  }

  async function commitSaveAsPrefab(entity: SceneEntity) {
    const name = prefabNameValue.trim();
    if (!sceneId || !name) {
      setSavingPrefab(null);
      setPrefabError(null);
      return;
    }
    const result = await exec('createPrefab', { scene: sceneId, entity: entity.id, name });
    if (result.success) {
      setSavingPrefab(null);
      setPrefabError(null);
    } else {
      // A silent close reads as success — keep the input open and name the
      // conflict at the point of use (HIER-7) instead of only a Console badge.
      setPrefabError(result.errors[0]?.message ?? 'Could not save the prefab.');
    }
  }

  function toggleCollapsed(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setCollapsedState(id: string, value: boolean) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function focusRow(id: string) {
    // Focus follows selection for arrow-key nav (roving tabindex). The row
    // element already exists (keyed by id), so focus lands before re-render.
    rowRefs.current.get(id)?.focus();
  }

  function onTreeKeyDown(e: React.KeyboardEvent) {
    if (isInputTarget(e.target)) return; // yield to the rename / prefab inputs
    if (e.key === 'F2' && selection) {
      const entity = scene?.entities.find((x) => x.id === selection);
      if (entity) {
        e.preventDefault();
        startRename(entity);
      }
      return;
    }
    const action = treeNav(rows, collapsed, selection, e.key);
    if (!action) return;
    e.preventDefault();
    if (action.type === 'select') {
      select(action.id);
      focusRow(action.id);
    } else if (action.type === 'expand') {
      setCollapsedState(action.id, false);
    } else if (action.type === 'collapse') {
      setCollapsedState(action.id, true);
    }
  }

  // Whether the dragged entity may be dropped onto `targetId` (self / own-subtree
  // drops would create a cycle and are refused before the drop happens).
  function canDropOn(targetId: string): boolean {
    return !!dragId && targetId !== dragId && !dragDescendants?.has(targetId);
  }

  async function reparent(entity: string, parent: string | null) {
    if (!sceneId) return;
    // moveEntity carries its own no-op guard, cycle guard, and prefab-instance
    // detach policy (whose PREFAB_* warnings already flow to the Console).
    await exec('moveEntity', { scene: sceneId, entity, parent });
  }

  function buildRowMenu(entity: SceneEntity): MenuItem[] {
    return [
      { label: 'Rename', icon: 'pencil', onSelect: () => startRename(entity) },
      { label: 'Duplicate', icon: 'duplicate', onSelect: () => void duplicate(entity) },
      { label: 'New child entity', icon: 'plus', onSelect: () => void addEntity(entity.id) },
      { label: 'Save as prefab', icon: 'prefab', onSelect: () => startSavePrefab(entity) },
      { separator: true },
      { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(entity) },
    ];
  }

  const emptyMenu: MenuItem[] = [
    { label: 'New entity', icon: 'plus', disabled: !sceneId, onSelect: () => void addEntity() },
  ];

  const focusableId = selection && rows.some((r) => r.entity.id === selection)
    ? selection
    : rows[0]?.entity.id;

  function renderRow({ entity, depth, hasChildren }: FlatRow): React.ReactNode {
    const isCollapsed = collapsed.has(entity.id);
    const isSelected = selection === entity.id;
    const isDropTarget = dropId === entity.id;
    const isDragging = dragId === entity.id;

    return (
      <div
        key={entity.id}
        ref={(el) => {
          if (el) rowRefs.current.set(entity.id, el);
          else rowRefs.current.delete(entity.id);
        }}
        className={
          `tree-row${isSelected ? ' selected' : ''}` +
          `${entity.enabled ? '' : ' disabled-entity'}` +
          `${isDropTarget ? ' drop-into' : ''}${isDragging ? ' dragging' : ''}`
        }
        style={{ '--depth': depth } as React.CSSProperties}
        role="treeitem"
        aria-selected={isSelected}
        aria-level={depth + 1}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        tabIndex={entity.id === focusableId ? 0 : -1}
        draggable={renaming !== entity.id && savingPrefab !== entity.id}
        onClick={() => select(entity.id)}
        onDoubleClick={() => startRename(entity)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          select(entity.id);
          setMenu({ x: e.clientX, y: e.clientY, entity, returnFocus: e.currentTarget });
        }}
        onKeyDown={(e) => {
          if (isActivationKey(e.key)) {
            e.preventDefault();
            select(entity.id);
          }
        }}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', entity.id);
          setDragId(entity.id);
          select(entity.id);
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (!dragId) return;
          e.stopPropagation(); // a row target overrides the container's root-drop
          if (!canDropOn(entity.id)) {
            e.dataTransfer.dropEffect = 'none';
            clearDwell();
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dropId !== entity.id) setDropId(entity.id);
          // Hover-dwell auto-expands a collapsed target so you can drop deeper.
          if (hasChildren && isCollapsed) {
            if (dwellRef.current?.id !== entity.id) {
              clearDwell();
              const timer = window.setTimeout(() => {
                setCollapsedState(entity.id, false);
                dwellRef.current = null;
              }, 550);
              dwellRef.current = { id: entity.id, timer };
            }
          } else {
            clearDwell();
          }
        }}
        onDrop={(e) => {
          if (!dragId) return;
          e.preventDefault();
          e.stopPropagation();
          if (canDropOn(entity.id)) void reparent(dragId, entity.id);
          endDrag();
        }}
      >
        {hasChildren ? (
          <button
            className={`tree-caret${isCollapsed ? '' : ' open'}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapsed(entity.id);
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
          <Icon name={entityIcon(entity.components)} />
        </span>
        {renaming === entity.id ? (
          <input
            className="rename-input"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => void commitRename(entity)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(entity);
              if (e.key === 'Escape') setRenaming(null);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : savingPrefab === entity.id ? (
          <span className="prefab-save-field">
            <input
              className={`rename-input${prefabError ? ' invalid' : ''}`}
              value={prefabNameValue}
              autoFocus
              placeholder="Prefab name"
              onChange={(e) => {
                setPrefabNameValue(e.target.value);
                if (prefabError) setPrefabError(null);
              }}
              onBlur={() => void commitSaveAsPrefab(entity)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitSaveAsPrefab(entity);
                if (e.key === 'Escape') {
                  setSavingPrefab(null);
                  setPrefabError(null);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
            {prefabError && <span className="field-error">{prefabError}</span>}
          </span>
        ) : (
          <span className="tree-name" title={entity.name}>
            {entity.name}
          </span>
        )}
        {/* Gate on resolved membership, not marker presence: a marker without a
            self-entry in its ids map (an unsynced createPrefab source master or
            stale legacy data) is not a live instance and must not wear the
            instance badge (SH-1). */}
        {isLivePrefabInstance(entity as { id: string; prefab?: { ids?: Record<string, string> } }) &&
          entity.prefab && (
          <span
            className="prefab-badge"
            title={`Instance of ${prefabAssetName(entity.prefab.asset)}`}
          >
            <Icon name="prefab" size={10} />
          </span>
        )}
        <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
          <IconButton
            bare
            className="icon-btn"
            icon="pencil"
            iconSize={11}
            label="Rename"
            tabIndex={-1}
            onClick={() => startRename(entity)}
          />
          <IconButton
            bare
            className="icon-btn"
            icon="duplicate"
            iconSize={11}
            label="Duplicate"
            tabIndex={-1}
            onClick={() => void duplicate(entity)}
          />
          <IconButton
            bare
            className="icon-btn"
            icon="prefab"
            iconSize={11}
            label="Save as prefab"
            tabIndex={-1}
            onClick={() => startSavePrefab(entity)}
          />
          <IconButton
            bare
            className="icon-btn danger"
            icon="trash"
            iconSize={11}
            label="Delete"
            tabIndex={-1}
            onClick={() => setDeleting(entity)}
          />
        </span>
      </div>
    );
  }

  const isRootDrop = dropId === ROOT_DROP;

  return (
    <>
      <div className="panel-header">
        <span>
          Hierarchy{scene ? <span className="panel-header-detail"> · {scene.name}</span> : null}
        </span>
        {playing && (
          // L-020 (HIER-15): during Play this tree keeps showing the
          // edit-time document while runtime-spawned entities live in the
          // running game — say so instead of letting the mismatch read as
          // missing rows. Runtime state lives in the Live panel.
          <Tooltip content="This is the edit-time scene. Entities spawned during Play appear in the Live panel">
            <span className="panel-header-detail" tabIndex={0} style={{ cursor: 'help' }}>
              edit-time
            </span>
          </Tooltip>
        )}
        <IconButton
          bare
          className="icon-btn"
          icon="plus"
          label="New entity"
          onClick={() => void addEntity()}
          disabled={!sceneId}
        />
      </div>
      <div
        className={`panel-scroll${isRootDrop ? ' drop-root' : ''}`}
        onContextMenu={(e) => {
          e.preventDefault();
          // No returnFocus: the panel background is not a tab stop.
          setMenu({ x: e.clientX, y: e.clientY, entity: null, returnFocus: null });
        }}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dropId !== ROOT_DROP) setDropId(ROOT_DROP);
          clearDwell();
        }}
        onDrop={(e) => {
          if (!dragId) return;
          e.preventDefault();
          void reparent(dragId, null);
          endDrag();
        }}
      >
        {rows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="entity" size={16} />
            </span>
            <span>{scene ? 'This scene is empty.' : 'No scene selected.'}</span>
            {scene && (
              <Button size="sm" icon="plus" onClick={() => void addEntity()}>
                Add an entity
              </Button>
            )}
          </div>
        ) : (
          <div className="tree" role="tree" aria-label="Scene hierarchy" onKeyDown={onTreeKeyDown}>
            {rows.map((row) => renderRow(row))}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.entity ? menu.entity.name : 'Hierarchy'}
          items={menu.entity ? buildRowMenu(menu.entity) : emptyMenu}
          returnFocus={menu.returnFocus}
          onClose={() => setMenu(null)}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete "${deleting?.name ?? ''}"?`}
        body="Its children are kept and re-parented one level up. This shows up in your undo history, so Ctrl/Cmd+Z brings it back."
        confirmLabel="Delete entity"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target && sceneId) void exec('deleteEntity', { scene: sceneId, entity: target.id });
        }}
      />
    </>
  );
}
