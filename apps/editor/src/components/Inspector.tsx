import React, { useEffect, useMemo, useState } from 'react';
import { useEditor } from '../store';
import type { SceneEntity } from '../types';
import { addPoint, removePoint, setPointAxis, shouldHideField } from '../vec2List';
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

/**
 * Row-per-point editor for Vec2[] fields (LineRenderer.points, Collider
 * polygon points): paired x/y NumberField inputs identical to Vec2Field, a
 * remove button per row, and an add-point button. Jake's uniformity
 * feedback: this replaces JsonField's raw JSON textarea for every Wave A
 * Vec2[] field — the array-editing logic lives in ../vec2List so it stays
 * unit-testable without a DOM.
 */
function Vec2ListField({
  value,
  min = 0,
  onCommit,
}: {
  value: { x: number; y: number }[];
  /** Minimum point count — the same floor the canvas vertex editor enforces. */
  min?: number;
  onCommit: (points: { x: number; y: number }[]) => void;
}) {
  const atFloor = value.length <= min;
  return (
    <div className="vec2-list">
      {value.length === 0 && <span className="vec2-list-empty">No points</span>}
      {value.map((p, i) => (
        <div className="vec2-list-row" key={i}>
          <Vec2Field value={p} onCommitAxis={(axis, v) => onCommit(setPointAxis(value, i, axis, v))} />
          <button
            type="button"
            className="icon-btn danger"
            title={atFloor ? `Needs at least ${min} points` : `Remove point ${i + 1}`}
            disabled={atFloor}
            onClick={() => {
              const next = removePoint(value, i, min);
              if (next) onCommit(next);
            }}
          >
            <Icon name="cross" size={10} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => onCommit(addPoint(value))}>
        <Icon name="plus" size={10} /> Add point
      </button>
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
// UIElement.anchor: a 3×3 grid picker instead of a raw enum dropdown.
// ---------------------------------------------------------------------------

const ANCHOR_ROWS = [
  ['top-left', 'top', 'top-right'],
  ['left', 'center', 'right'],
  ['bottom-left', 'bottom', 'bottom-right'],
] as const;

function AnchorGrid({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  return (
    <div className="anchor-grid" role="radiogroup" aria-label="Anchor">
      {ANCHOR_ROWS.flat().map((anchor) => (
        <button
          key={anchor}
          type="button"
          className={`anchor-cell${value === anchor ? ' selected' : ''}`}
          role="radio"
          aria-checked={value === anchor}
          aria-label={anchor}
          title={anchor}
          onClick={() => value !== anchor && onCommit(anchor)}
        >
          <span className="anchor-dot" aria-hidden="true" />
        </button>
      ))}
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

function isVec2Array(v: unknown): v is { x: number; y: number }[] {
  return Array.isArray(v) && v.every(isVec2);
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
                  // Collider.points only means anything for a polygon shape
                  // (box/circle ignore it entirely) — showing an editable
                  // vertex list for a box/circle Collider is just noise, and
                  // unlike an emptied Tilemap.grid there's no shapeless case
                  // here that needs the row to stay editable.
                  if (shouldHideField(type, field, component as Record<string, unknown>)) {
                    return null;
                  }
                  const property = `${type}.${field}`;
                  const rowKey = `${entity.id}.${property}`;
                  let control: React.ReactNode;
                  if (field === 'assetId' && type === 'SpriteAnimator' && typeof value === 'string') {
                    // SpriteAnimator.assetId is a non-nullable string (default ''),
                    // unlike SpriteRenderer/AudioSource's nullable assetId, and it
                    // picks from animation assets specifically.
                    const options = assets.filter((a) => a.type === 'animation');
                    control = (
                      <select
                        className="select"
                        value={value}
                        onChange={(e) => setProperty(property, e.target.value)}
                      >
                        <option value="">(none)</option>
                        {options.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    );
                  } else if (field === 'assetId' && (typeof value === 'string' || value === null)) {
                    // AudioSource picks from audio assets; SpriteRenderer (and
                    // anything else with an assetId) from sprites/tiles.
                    const isAudio = type === 'AudioSource';
                    const options = assets.filter((a) =>
                      isAudio ? a.type === 'audio' : a.type === 'sprite' || a.type === 'tile',
                    );
                    control = (
                      <select
                        className="select"
                        value={(value as string | null) ?? ''}
                        onChange={(e) => setProperty(property, e.target.value === '' ? null : e.target.value)}
                      >
                        <option value="">{isAudio ? '(none)' : '(none: draw primitive)'}</option>
                        {options.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                            {isAudio ? '' : ` (${a.type})`}
                          </option>
                        ))}
                      </select>
                    );
                  } else if (type === 'UIElement' && field === 'anchor' && typeof value === 'string') {
                    control = (
                      <AnchorGrid key={rowKey} value={value} onCommit={(v) => setProperty(property, v)} />
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
                  } else if (isVec2Array(value) && (value.length > 0 || field === 'points')) {
                    // Any Vec2[] gets the row editor (Jake: never raw JSON for
                    // these). An EMPTY array is shapeless, so only trust the
                    // `points` field name for it — an emptied Tilemap.grid
                    // (string[]) must not grow {x,y} entries via "Add point".
                    // Same floors as the canvas vertex editor: a polygon
                    // Collider needs 3 points, a LineRenderer needs 2.
                    const min = type === 'Collider' ? 3 : type === 'LineRenderer' ? 2 : 0;
                    control = (
                      <Vec2ListField
                        key={rowKey}
                        value={value}
                        min={min}
                        onCommit={(points) => setProperty(property, points)}
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
