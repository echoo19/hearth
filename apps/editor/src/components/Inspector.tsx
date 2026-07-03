import React, { useEffect, useMemo, useState } from 'react';
import { useEditor } from '../store';
import type { SceneEntity } from '../types';
import { ConfirmDialog, Icon, componentIcon } from './ui';

// ---------------------------------------------------------------------------
// Field editors: value type decides the control. All commit on blur / Enter.
// ---------------------------------------------------------------------------

function NumberField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <input
      className="input"
      type="number"
      step="any"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(String(value));
      }}
    />
  );
}

function TextField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

function ColorField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const pickerValue = /^#[0-9a-fA-F]{6}$/.test(draft) ? draft : '#ffffff';
  return (
    <div className="color-pair">
      <input
        type="color"
        value={pickerValue}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value);
        }}
        aria-label="Pick color"
      />
      <input
        className="input mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(value);
        }}
      />
    </div>
  );
}

function Vec2Field({
  value,
  onCommitAxis,
}: {
  value: { x: number; y: number };
  onCommitAxis: (axis: 'x' | 'y', v: number) => void;
}) {
  return (
    <div className="vec2-pair">
      <NumberField value={value.x} onCommit={(v) => onCommitAxis('x', v)} />
      <NumberField value={value.y} onCommit={(v) => onCommitAxis('y', v)} />
    </div>
  );
}

function JsonField({ value, onCommit }: { value: unknown; onCommit: (v: unknown) => void }) {
  const formatted = useMemo(() => JSON.stringify(value, null, 2) ?? 'null', [value]);
  const [draft, setDraft] = useState(formatted);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(formatted);
    setError('');
  }, [formatted]);
  const commit = () => {
    try {
      const parsed = draft.trim() === '' ? null : JSON.parse(draft);
      setError('');
      if (JSON.stringify(parsed) !== JSON.stringify(value)) onCommit(parsed);
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <textarea
        className={`textarea${error ? ' invalid' : ''}`}
        rows={Math.min(8, Math.max(2, formatted.split('\n').length))}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function isVec2(v: unknown): v is { x: number; y: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length === 2 &&
    typeof (v as any).x === 'number' &&
    typeof (v as any).y === 'number'
  );
}

export function Inspector() {
  const scene = useEditor((s) => s.scene);
  const sceneId = useEditor((s) => s.sceneId);
  const selection = useEditor((s) => s.selection);
  const assets = useEditor((s) => s.assets);
  const componentDocs = useEditor((s) => s.componentDocs);
  const exec = useEditor((s) => s.exec);
  const select = useEditor((s) => s.select);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const entity = useMemo(
    () => scene?.entities.find((e) => e.id === selection),
    [scene, selection],
  );

  if (!entity || !sceneId) {
    return (
      <>
        <div className="panel-header">
          <span>Inspector</span>
        </div>
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">
            <Icon name="entity" size={16} />
          </span>
          <span>Nothing selected</span>
          <span className="hint">
            Click an entity in the Hierarchy or the Scene view to edit its components here.
          </span>
        </div>
      </>
    );
  }

  const setProperty = (property: string, value: unknown) =>
    void exec('setComponentProperty', { scene: sceneId, entity: entity.id, property, value }, { quiet: true });

  const existingTypes = Object.keys(entity.components);
  const addableTypes = componentDocs.filter((d) => !existingTypes.includes(d.type));

  return (
    <>
      <div className="panel-header">
        <span>Inspector</span>
        <span className="mono panel-header-detail">{entity.id}</span>
      </div>
      <div className="panel-scroll">
        {/* entity-level fields */}
        <div className="inspector-section">
          <div className="inspector-row">
            <label className="field-label">Name</label>
            <TextField
              key={`name-${entity.id}`}
              value={entity.name}
              onCommit={(newName) =>
                newName.trim() &&
                void exec('renameEntity', { scene: sceneId, entity: entity.id, newName: newName.trim() })
              }
            />
          </div>
          <div className="inspector-row">
            <label className="field-label" htmlFor="entity-enabled">
              Enabled
            </label>
            <input
              id="entity-enabled"
              type="checkbox"
              checked={entity.enabled}
              onChange={(e) =>
                void exec('setEntityEnabled', { scene: sceneId, entity: entity.id, enabled: e.target.checked })
              }
            />
          </div>
          <div className="inspector-row">
            <label className="field-label">Tags</label>
            <TextField
              key={`tags-${entity.id}`}
              value={entity.tags.join(', ')}
              onCommit={(raw) =>
                void exec('setEntityTags', {
                  scene: sceneId,
                  entity: entity.id,
                  tags: raw
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <div className="inspector-row">
            <label className="field-label">Parent</label>
            <select
              className="select"
              value={entity.parentId ?? ''}
              onChange={(e) =>
                void exec('moveEntity', {
                  scene: sceneId,
                  entity: entity.id,
                  parent: e.target.value === '' ? null : e.target.value,
                })
              }
            >
              <option value="">(scene root)</option>
              {(scene?.entities ?? [])
                .filter((e) => e.id !== entity.id)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </div>
        </div>

        {/* components */}
        {Object.entries(entity.components).map(([type, component]) => {
          const doc = componentDocs.find((d) => d.type === type);
          return (
            <div className="component-card" key={type}>
              <div className="component-header" title={doc?.description}>
                <span className="component-title">
                  <span className="entity-icon">
                    <Icon name={componentIcon(type)} />
                  </span>
                  {type}
                </span>
                <button
                  className="icon-btn danger"
                  title={`Remove ${type}`}
                  onClick={() => setConfirmRemove(type)}
                >
                  <Icon name="cross" size={10} />
                </button>
              </div>
              <div className="component-body">
                {Object.entries(component as Record<string, unknown>).map(([field, value]) => {
                  const property = `${type}.${field}`;
                  const rowKey = `${entity.id}.${property}`;
                  let control: React.ReactNode;
                  if (field === 'assetId' && (typeof value === 'string' || value === null)) {
                    control = (
                      <select
                        className="select"
                        value={(value as string | null) ?? ''}
                        onChange={(e) => setProperty(property, e.target.value === '' ? null : e.target.value)}
                      >
                        <option value="">(none: draw primitive)</option>
                        {assets
                          .filter((a) => a.type === 'sprite' || a.type === 'tile' || a.type === 'audio')
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.type})
                            </option>
                          ))}
                      </select>
                    );
                  } else if (typeof value === 'number') {
                    control = (
                      <NumberField key={rowKey} value={value} onCommit={(v) => setProperty(property, v)} />
                    );
                  } else if (typeof value === 'boolean') {
                    control = (
                      <input
                        type="checkbox"
                        checked={value}
                        onChange={(e) => setProperty(property, e.target.checked)}
                      />
                    );
                  } else if (typeof value === 'string' && value.startsWith('#')) {
                    control = (
                      <ColorField key={rowKey} value={value} onCommit={(v) => setProperty(property, v)} />
                    );
                  } else if (typeof value === 'string') {
                    control = (
                      <TextField key={rowKey} value={value} onCommit={(v) => setProperty(property, v)} />
                    );
                  } else if (isVec2(value)) {
                    control = (
                      <Vec2Field
                        key={rowKey}
                        value={value}
                        onCommitAxis={(axis, v) => setProperty(`${property}.${axis}`, v)}
                      />
                    );
                  } else {
                    control = (
                      <JsonField key={rowKey} value={value} onCommit={(v) => setProperty(property, v)} />
                    );
                  }
                  return (
                    <div className="inspector-row" key={field}>
                      <label className="field-label" title={property}>
                        {field}
                      </label>
                      {control}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* add component */}
        <div className="add-component-row">
          <select
            className="select"
            value=""
            style={{ width: '100%' }}
            disabled={addableTypes.length === 0}
            onChange={(e) => {
              if (e.target.value) {
                void exec('addComponent', { scene: sceneId, entity: entity.id, type: e.target.value });
              }
            }}
          >
            <option value="" disabled>
              {addableTypes.length === 0 ? 'All component types added' : 'Add component…'}
            </option>
            {addableTypes.map((d) => (
              <option key={d.type} value={d.type} title={d.description}>
                {d.type}
              </option>
            ))}
          </select>
        </div>

        <div style={{ padding: '4px 10px 14px' }}>
          <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={11} /> Delete entity
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${entity.name}”?`}
        body="Its children are kept and re-parented one level up."
        confirmLabel="Delete entity"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          select(null);
          void exec('deleteEntity', { scene: sceneId, entity: entity.id });
        }}
      />
      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Remove ${confirmRemove ?? ''}?`}
        body={`The ${confirmRemove ?? ''} component and its settings are removed from “${entity.name}”.`}
        confirmLabel="Remove component"
        danger
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          const type = confirmRemove;
          setConfirmRemove(null);
          if (type) void exec('removeComponent', { scene: sceneId, entity: entity.id, type });
        }}
      />
    </>
  );
}
