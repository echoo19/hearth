import React, { useMemo, useState } from 'react';
import { useEditor } from '../store';
import type { SceneEntity } from '../types';
import { ConfirmDialog, Icon, entityIcon } from './ui';

export function Hierarchy() {
  const scene = useEditor((s) => s.scene);
  const sceneId = useEditor((s) => s.sceneId);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const exec = useEditor((s) => s.exec);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<SceneEntity | null>(null);

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, SceneEntity[]>();
    for (const e of scene?.entities ?? []) {
      const list = map.get(e.parentId) ?? [];
      list.push(e);
      map.set(e.parentId, list);
    }
    return map;
  }, [scene]);

  const names = useMemo(() => new Set((scene?.entities ?? []).map((e) => e.name)), [scene]);

  function uniqueName(base: string): string {
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base} ${i}`;
      if (!names.has(candidate)) return candidate;
    }
  }

  async function addEntity() {
    if (!sceneId) return;
    const result = await exec<{ entityId: string }>('createEntity', {
      scene: sceneId,
      name: uniqueName('Entity'),
    });
    if (result.success && result.data) select(result.data.entityId);
  }

  async function duplicate(entity: SceneEntity) {
    if (!sceneId) return;
    const result = await exec<{ entityId: string }>('createEntity', {
      scene: sceneId,
      name: uniqueName(`${entity.name} copy`),
      parent: entity.parentId ?? undefined,
      tags: entity.tags,
      components: entity.components,
    });
    if (result.success && result.data) select(result.data.entityId);
  }

  async function commitRename(entity: SceneEntity) {
    const newName = renameValue.trim();
    setRenaming(null);
    if (!sceneId || !newName || newName === entity.name) return;
    await exec('renameEntity', { scene: sceneId, entity: entity.id, newName });
  }

  function toggleCollapsed(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderRow(entity: SceneEntity, depth: number): React.ReactNode {
    const children = childrenOf.get(entity.id) ?? [];
    const isCollapsed = collapsed.has(entity.id);
    const isSelected = selection === entity.id;

    return (
      <React.Fragment key={entity.id}>
        <div
          className={`tree-row${isSelected ? ' selected' : ''}${entity.enabled ? '' : ' disabled-entity'}`}
          style={{ '--depth': depth } as React.CSSProperties}
          onClick={() => select(entity.id)}
          onDoubleClick={() => {
            setRenaming(entity.id);
            setRenameValue(entity.name);
          }}
        >
          {children.length > 0 ? (
            <button
              className={`tree-caret${isCollapsed ? '' : ' open'}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapsed(entity.id);
              }}
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
          ) : (
            <span className="tree-name" title={entity.id}>
              {entity.name}
            </span>
          )}
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="icon-btn"
              title="Rename"
              onClick={() => {
                setRenaming(entity.id);
                setRenameValue(entity.name);
              }}
            >
              <Icon name="pencil" size={11} />
            </button>
            <button className="icon-btn" title="Duplicate" onClick={() => void duplicate(entity)}>
              <Icon name="duplicate" size={11} />
            </button>
            <button className="icon-btn danger" title="Delete" onClick={() => setDeleting(entity)}>
              <Icon name="trash" size={11} />
            </button>
          </span>
        </div>
        {!isCollapsed && children.map((child) => renderRow(child, depth + 1))}
      </React.Fragment>
    );
  }

  const roots = childrenOf.get(null) ?? [];

  return (
    <>
      <div className="panel-header">
        <span>
          Hierarchy{scene ? <span className="panel-header-detail"> · {scene.name}</span> : null}
        </span>
        <button className="icon-btn" title="New entity" onClick={() => void addEntity()} disabled={!sceneId}>
          <Icon name="plus" />
        </button>
      </div>
      <div className="panel-scroll">
        {roots.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="entity" size={16} />
            </span>
            <span>{scene ? 'This scene is empty.' : 'No scene selected.'}</span>
            {scene && (
              <button className="btn btn-sm" onClick={() => void addEntity()}>
                <Icon name="plus" /> Add an entity
              </button>
            )}
          </div>
        ) : (
          <div className="tree">{roots.map((e) => renderRow(e, 0))}</div>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name ?? ''}”?`}
        body="Its children are kept and re-parented one level up. This mutation is recorded like any other command — snapshot first if you want an undo point."
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
