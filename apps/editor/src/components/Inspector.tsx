import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AUTOTILE_SHAPES, BLOB47_TEMPLATE, getSheetFrames, type AutotileRule, type PostEffect } from '@hearth/core';
import { useEditor } from '../store';
import { PostEffectsField } from './PostEffectsField';
import type { AssetItem, SceneEntity } from '../types';
import { addPoint, removePoint, setPointAxis, shouldHideField } from '../vec2List';
import { addString, removeString, setStringAt } from '../stringList';
import {
  isAutotileRule,
  nextAvailableChar,
  setMappingOverride,
  toTileRows,
  validateTileChar,
  type TileAsset,
  type TileRow,
} from '../tileAutotileRows';
import { ColorField, ConfirmDialog, Icon, NumberField, TextField, componentIcon } from './ui';
import { Button, IconButton } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import {
  countPrefabInstances,
  createSyncPreflight,
  instanceOverrideCount,
  revertAllConfirmBody,
  syncConfirmBody,
} from '../prefabActions';
import {
  isFieldOverridden,
  overriddenEntityIds,
  overriddenPathsUnder,
  type EntityPrefabInfo,
  type RawPrefabOverride,
} from '../prefabOverrides';

// ---------------------------------------------------------------------------
// Field editors: value type decides the control. All commit on blur / Enter.
// ---------------------------------------------------------------------------

/** Raw schema field name -> "Title Case With Spaces" label, e.g.
 * "backgroundColor" -> "Background Color". PRODUCT.md targets a newcomer
 * audience; raw camelCase schema keys (isMain, ambientLight, fontFamily)
 * read as developer identifiers otherwise. Mirrors PostEffectsField.tsx's
 * humanize() for the same reason. The raw property name stays available in
 * the row's `title` tooltip for anyone who wants the exact schema key. */
export function humanizeFieldLabel(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
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
          <IconButton
            bare
            className="icon-btn danger"
            icon="cross"
            iconSize={10}
            label={atFloor ? `Needs at least ${min} points` : `Remove point ${i + 1}`}
            disabled={atFloor}
            onClick={() => {
              const next = removePoint(value, i, min);
              if (next) onCommit(next);
            }}
          />
        </div>
      ))}
      <Button size="sm" onClick={() => onCommit(addPoint(value))}>
        <Icon name="plus" size={10} /> Add point
      </Button>
    </div>
  );
}

/**
 * Row-per-string editor for string[] fields (Collider.collidesWith and
 * similar): text input per row with a remove button, and an add-string
 * button. Reuses Vec2ListField styling (.vec2-list, .vec2-list-row, etc)
 * for visual consistency. The array-editing logic lives in ../stringList
 * so it stays unit-testable without a DOM.
 */
function StringListField({
  value,
  min = 0,
  onCommit,
}: {
  value: string[];
  /** Minimum string count; removal disabled at or below this. */
  min?: number;
  onCommit: (list: string[]) => void;
}) {
  const atFloor = value.length <= min;
  return (
    <div className="vec2-list">
      {value.length === 0 && <span className="vec2-list-empty">No items</span>}
      {value.map((s, i) => (
        <div className="vec2-list-row" key={i}>
          <TextField
            value={s}
            placeholder="*"
            onCommit={(newVal) => onCommit(setStringAt(value, i, newVal))}
          />
          <IconButton
            bare
            className="icon-btn danger"
            icon="cross"
            iconSize={10}
            label={atFloor ? `Needs at least ${min} items` : `Remove item ${i + 1}`}
            disabled={atFloor}
            onClick={() => {
              const next = removeString(value, i, min);
              if (next) onCommit(next);
            }}
          />
        </div>
      ))}
      <Button size="sm" onClick={() => onCommit(addString(value))}>
        <Icon name="plus" size={10} /> Add layer
      </Button>
    </div>
  );
}

/**
 * Single-char input for a TileAssetsField row: like TextField (draft state,
 * commits on blur/Enter, Escape reverts), but validates via
 * ../tileAutotileRows and shows an inline hint instead of committing an
 * invalid char — a multi-char/empty value, or '.'/' ' (reserved for empty
 * cells), or a char already used by another row.
 */
function TileCharField({
  value,
  rows,
  index,
  onCommit,
}: {
  value: string;
  rows: readonly TileRow[];
  index: number;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(value);
    setError('');
  }, [value]);
  const commit = () => {
    if (draft === value) {
      setError('');
      return;
    }
    const issue = validateTileChar(draft, rows, index);
    if (issue) {
      setError(issue);
      return;
    }
    setError('');
    onCommit(draft);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <input
        className={`input mono${error ? ' invalid' : ''}`}
        style={{ width: 40, textAlign: 'center' }}
        maxLength={4}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(value);
            setError('');
          }
        }}
      />
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

/** Minimal shape of useEditor's exec() this field needs — just enough to check success before chaining a dependent call. */
type TileExecFn = (name: string, params?: unknown, opts?: { quiet?: boolean }) => Promise<{ success: boolean }>;

const MISSING_ASSET = '__missing__';

/**
 * A row's autotile controls: sheet dropdown + template (blob47 is the only
 * one that exists today, so this is a locked single-option select — swap in
 * real options the day a second template ships) + a collapsed "Advanced
 * mapping" section with one frame dropdown per blob47 shape, overriding that
 * shape's frame away from the standard `blob_<shapeKey>` template name (see
 * @hearth/core's BLOB47_TEMPLATE/AUTOTILE_SHAPES). Collapsed by default:
 * 47 rows would otherwise dominate the Inspector for every autotile char.
 */
function AutotileRuleFields({
  rule,
  sheetAssets,
  onChange,
}: {
  rule: AutotileRule;
  sheetAssets: AssetItem[];
  onChange: (next: AutotileRule) => void;
}) {
  const sheetAsset = sheetAssets.find((a) => a.id === rule.sheet);
  const frames = sheetAsset ? getSheetFrames(sheetAsset) : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 46 }}>
      <div className="vec2-list-row">
        <label className="field-label" style={{ minWidth: 60 }}>
          Template
        </label>
        <select className="select" style={{ maxWidth: 180 }} value={rule.template} disabled>
          <option value="blob47">Blob47 (47-shape)</option>
        </select>
      </div>
      <details>
        <summary>Advanced mapping</summary>
        <div className="vec2-list autotile-mapping-list">
          {AUTOTILE_SHAPES.map((shape) => (
            <div className="vec2-list-row" key={shape}>
              <span className="mono" style={{ width: 36, flex: 'none' }} title={`Shape key ${shape}`}>
                {shape}
              </span>
              <select
                className="select"
                value={rule.mapping?.[shape] ?? ''}
                onChange={(e) => {
                  const frameName = e.target.value === '' ? null : e.target.value;
                  onChange({ ...rule, mapping: setMappingOverride(rule.mapping, shape, frameName) });
                }}
              >
                <option value="">(default: {BLOB47_TEMPLATE[shape]})</option>
                {frames.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/** One TileAssetsField row: char input, sprite/autotile mode select, mode-specific controls, and a remove button. */
function TileRowEditor({
  row,
  rows,
  index,
  imageAssets,
  sheetAssets,
  onRename,
  onWrite,
  onRemove,
}: {
  row: TileRow;
  rows: readonly TileRow[];
  index: number;
  imageAssets: AssetItem[];
  sheetAssets: AssetItem[];
  onRename: (newChar: string) => void;
  onWrite: (next: TileAsset) => void;
  onRemove: () => void;
}) {
  const autotile = isAutotileRule(row.value);
  const assetId = autotile ? '' : (row.value as string);
  const missingAsset = !autotile && assetId !== '' && !imageAssets.some((a) => a.id === assetId);
  const canUseAutotile = autotile || sheetAssets.length > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="vec2-list-row">
        <TileCharField value={row.char} rows={rows} index={index} onCommit={onRename} />
        <select
          className="select"
          style={{ maxWidth: 96, flex: 'none' }}
          value={autotile ? 'autotile' : 'sprite'}
          disabled={!canUseAutotile}
          onChange={(e) => {
            if (e.target.value === 'autotile') {
              if (sheetAssets.length === 0) return;
              onWrite({ sheet: sheetAssets[0].id, template: 'blob47' });
            } else {
              onWrite('');
            }
          }}
        >
          <option value="sprite">Sprite</option>
          <option value="autotile">Autotile</option>
        </select>
        {!autotile && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
            <select
              className={`select${missingAsset ? ' invalid' : ''}`}
              value={missingAsset ? MISSING_ASSET : assetId}
              onChange={(e) => {
                if (e.target.value === MISSING_ASSET) return;
                onWrite(e.target.value);
              }}
            >
              <option value="">(none)</option>
              {missingAsset && (
                <option value={MISSING_ASSET} disabled>
                  (missing asset)
                </option>
              )}
              {imageAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {missingAsset && <span className="field-error">Referenced asset was deleted — pick a replacement.</span>}
          </div>
        )}
        {autotile && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
            <select
              className="select"
              value={(row.value as AutotileRule).sheet}
              onChange={(e) => onWrite({ ...(row.value as AutotileRule), sheet: e.target.value })}
            >
              {!sheetAssets.some((a) => a.id === (row.value as AutotileRule).sheet) && (
                <option value={(row.value as AutotileRule).sheet} disabled>
                  (missing sheet)
                </option>
              )}
              {sheetAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <IconButton
          bare
          className="icon-btn danger"
          icon="cross"
          iconSize={10}
          label={`Remove "${row.char}"`}
          onClick={onRemove}
        />
      </div>
      {autotile && (
        <AutotileRuleFields rule={row.value as AutotileRule} sheetAssets={sheetAssets} onChange={onWrite} />
      )}
    </div>
  );
}

/**
 * Row-per-char editor for Tilemap.tileAssets: each char is either a plain
 * sprite/tile asset (sprite mode) or an autotile rule (autotile mode — the
 * blob47 resolver, see @hearth/core's tilemap/autotile.ts). Replaces
 * JsonField's raw JSON textarea (Jake: never raw JSON for these) — row
 * ordering/validation/mapping edits live in ../tileAutotileRows so they stay
 * unit-testable without a DOM, matching Vec2ListField/StringListField.
 *
 * Unlike the other row editors, this does NOT commit via a single
 * onCommit(wholeMap) — setComponentProperty refuses to write the autotile
 * object arm at all (core's assertNotAutotileWrite: a whole-map write is
 * rejected the instant ANY char in the resulting map is autotile-mode, and a
 * per-char write is rejected only for the exact char it targets). So every
 * edit here is its own per-char setComponentProperty (sprite mode) or
 * setTileAutotile (autotile mode, and clearing a row of either mode — clear
 * doesn't care what the char's prior value was) call. A char rename is two
 * calls — write the new char, then clear the old one — since there's no
 * "rename a record key" verb in the command surface; each is its own undo
 * step, same as any other multi-command composition in this app.
 */
function TileAssetsField({
  value,
  assets,
  sceneId,
  entityId,
  exec,
}: {
  value: Record<string, TileAsset>;
  assets: AssetItem[];
  sceneId: string;
  entityId: string;
  exec: TileExecFn;
}) {
  const rows = toTileRows(value);
  // tileAssets maps to sprite/tile assets, same pool SpriteRenderer.assetId
  // picks from (renderTilemap resolves them the same way). Autotile mode
  // narrows further to sheets that are actually sliced (getSheetFrames > 0)
  // — an unsliced sheet has no frames to resolve to.
  const imageAssets = assets.filter((a) => a.type === 'sprite' || a.type === 'tile');
  const sheetAssets = imageAssets.filter((a) => getSheetFrames(a).length > 0);

  function writeChar(char: string, next: TileAsset) {
    if (typeof next === 'string') {
      return exec(
        'setComponentProperty',
        { scene: sceneId, entity: entityId, property: `Tilemap.tileAssets.${char}`, value: next },
        { quiet: true },
      );
    }
    return exec(
      'setTileAutotile',
      { scene: sceneId, entity: entityId, char, sheet: next.sheet, template: next.template, mapping: next.mapping },
      { quiet: true },
    );
  }

  function clearChar(char: string) {
    return exec('setTileAutotile', { scene: sceneId, entity: entityId, char, clear: true }, { quiet: true });
  }

  async function renameChar(oldChar: string, newChar: string, current: TileAsset) {
    const result = await writeChar(newChar, current);
    if (!result.success) return; // leave the old char alone if the new one failed to validate/write
    await clearChar(oldChar);
  }

  return (
    <div className="vec2-list">
      {rows.length === 0 && <span className="vec2-list-empty">No tile chars mapped</span>}
      {rows.map((row, i) => (
        <TileRowEditor
          key={i}
          row={row}
          rows={rows}
          index={i}
          imageAssets={imageAssets}
          sheetAssets={sheetAssets}
          onRename={(newChar) => void renameChar(row.char, newChar, row.value)}
          onWrite={(next) => void writeChar(row.char, next)}
          onRemove={() => void clearChar(row.char)}
        />
      ))}
      <Button size="sm" onClick={() => void writeChar(nextAvailableChar(rows), imageAssets[0]?.id ?? '')}>
        <Icon name="plus" size={10} /> Add tile char
      </Button>
    </div>
  );
}

/**
 * Fallback for a component field that doesn't match any typed branch below —
 * Jake's bar is "no raw JSON for a typed field, ever," so this deliberately
 * does NOT fall back to a JSON textarea (that used to be JsonField, now
 * retired). Read-only by design: showing an editable raw-JSON escape hatch
 * here would silently defeat the "every field gets a real control" contract
 * the moment a new schema field shipped without one. Warns once in dev so
 * whoever adds the next component field notices immediately instead of
 * finding out from a bug report.
 */
function UnsupportedField({ value, property }: { value: unknown; property: string }) {
  useEffect(() => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        `Inspector: "${property}" has no typed control and is showing read-only. Add a branch for it instead of falling back to raw JSON.`,
      );
    }
  }, [property]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 'var(--text-sm)' }}>
        {JSON.stringify(value)}
      </span>
      <span className="field-fallback-note">
        No typed control for this field yet — shown read-only. Edit it through your agent or the
        hearth CLI.
      </span>
    </div>
  );
}

const GENERIC_FONT_FAMILIES = ['monospace', 'sans-serif', 'serif', 'cursive', 'fantasy'] as const;
const CUSTOM_FONT_OPTION = '__custom__';

function isKnownFontValue(value: string, fontAssets: AssetItem[]): boolean {
  return (
    fontAssets.some((a) => a.name === value) ||
    (GENERIC_FONT_FAMILIES as readonly string[]).includes(value)
  );
}

/**
 * Text.fontFamily: a select grouping project font assets and the five
 * generic CSS families, plus a "Custom…" option that reveals a plain
 * TextField. An arbitrary value already on the entity (set by a script, or
 * from before a font asset existed) renders as the custom value rather than
 * being silently overwritten — the select shows "Custom…" and the text
 * field carries the real value.
 */
function FontFamilyField({
  value,
  fontAssets,
  onCommit,
}: {
  value: string;
  fontAssets: AssetItem[];
  onCommit: (v: string) => void;
}) {
  const [forceCustom, setForceCustom] = useState(() => !isKnownFontValue(value, fontAssets));
  const showCustom = forceCustom || !isKnownFontValue(value, fontAssets);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <select
        className="select"
        value={showCustom ? CUSTOM_FONT_OPTION : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM_FONT_OPTION) {
            setForceCustom(true);
          } else {
            setForceCustom(false);
            onCommit(e.target.value);
          }
        }}
      >
        {fontAssets.length > 0 && (
          <optgroup label="Project fonts">
            {fontAssets.map((a) => (
              <option key={a.id} value={a.name}>
                {a.name}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Generic">
          {GENERIC_FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </optgroup>
        <option value={CUSTOM_FONT_OPTION}>Custom…</option>
      </select>
      {showCustom && <TextField value={value} onCommit={onCommit} />}
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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** Tilemap.tileAssets shape: values are plain asset ids (sprite mode) or autotile rule objects (the object arm) — never anything else. */
function isTileAssetsRecord(v: unknown): v is Record<string, TileAsset> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'string' || (typeof x === 'object' && x !== null && !Array.isArray(x)))
  );
}

/** Resolve a component's `assetId` field to its asset, if any. */
function resolveAsset(assets: AssetItem[], assetId: unknown): AssetItem | undefined {
  return typeof assetId === 'string' ? assets.find((a) => a.id === assetId) : undefined;
}

export function Inspector() {
  const scene = useEditor((s) => s.scene);
  const sceneId = useEditor((s) => s.sceneId);
  const selection = useEditor((s) => s.selection);
  const assets = useEditor((s) => s.assets);
  const info = useEditor((s) => s.info);
  const componentDocs = useEditor((s) => s.componentDocs);
  const exec = useEditor((s) => s.exec);
  const query = useEditor((s) => s.query);
  const select = useEditor((s) => s.select);
  const log = useEditor((s) => s.log);
  const openAnimatorFor = useEditor((s) => s.openAnimatorFor);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [syncAllTarget, setSyncAllTarget] = useState<{ asset: string; count: number } | null>(null);
  // "Sync all"'s instance-count preflight (countPrefabInstances) is a
  // multi-scene round-trip — while it's in flight the user can click Sync
  // all again or select a different entity. The token guards "no newer
  // request started"; the ref guards "selection hasn't moved on" (selection
  // is stale in the closure once we're past the `await`).
  const syncPreflightRef = useRef(createSyncPreflight());
  const selectionRef = useRef(selection);
  const [pendingSyncAllFor, setPendingSyncAllFor] = useState<string | null>(null);
  // Per-field override state for the SELECTED entity, resolved fresh from
  // inspectEntity (the raw scene payload only carries the prefab marker on
  // an instance's root, not per-field override info, and only inspectEntity
  // resolves membership for a non-root instance member). Refetched whenever
  // selection or scene data changes — `entity` gets a new reference on every
  // scene refresh (which every mutating exec() triggers), so this follows
  // the same "journal feed causes a refetch" idiom as CodePanel/Timeline
  // without needing journalFeed itself as a dependency.
  const [prefabInfo, setPrefabInfo] = useState<EntityPrefabInfo | null>(null);
  const [confirmRevertAll, setConfirmRevertAll] = useState(false);
  const [revertingAll, setRevertingAll] = useState(false);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const entity = useMemo(
    () => scene?.entities.find((e) => e.id === selection),
    [scene, selection],
  );

  useEffect(() => {
    let cancelled = false;
    if (!sceneId || !entity) {
      setPrefabInfo(null);
      return;
    }
    void query<{ prefab?: EntityPrefabInfo }>('inspectEntity', { scene: sceneId, entity: entity.id }).then(
      (data) => {
        if (!cancelled) setPrefabInfo(data?.prefab ?? null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [query, sceneId, entity]);

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

  const prefabAssetId = entity.prefab?.asset;
  const prefabAsset = prefabAssetId ? assets.find((a) => a.id === prefabAssetId) : undefined;
  // The raw scene marker (root entities only) carries the FULL override list
  // for the whole instance — every member entity's overrides, not just the
  // root's own (unlike the per-entity `prefabInfo.overridden` used for field
  // dots above). SceneEntity's public type only declares `{ asset }`; the
  // extra fields are the real runtime shape (schema/scene.ts EntitySchema).
  const instanceOverrides = (entity.prefab as { overrides?: RawPrefabOverride[] } | undefined)?.overrides ?? [];
  const overrideCount = instanceOverrideCount(instanceOverrides);

  const handleUpdatePrefab = async () => {
    if (!prefabAssetId) return;
    await exec('updatePrefab', { prefab: prefabAssetId, scene: sceneId, entity: entity.id });
  };

  // One revertPrefabOverride call per exact recorded path under this field
  // (see overriddenPathsUnder — a "Position" row can carry two separately
  // recorded axis overrides that a single path="position" call wouldn't
  // match). Awaited sequentially so concurrent calls don't race mutating the
  // same root marker's overrides list.
  const handleRevertField = async (component: string, field: string) => {
    for (const path of overriddenPathsUnder(prefabInfo, component, field)) {
      await exec('revertPrefabOverride', { scene: sceneId, entity: entity.id, component, path });
    }
  };

  const handleRevertAll = async () => {
    setRevertingAll(true);
    try {
      // One revertPrefabOverride call per distinct member entity (no
      // component/path narrows the scope, so each call clears every override
      // on that entity) — the minimal command count for "clear everything on
      // this instance", rather than one call per individual override record.
      for (const memberId of overriddenEntityIds(instanceOverrides)) {
        await exec('revertPrefabOverride', { scene: sceneId, entity: memberId });
      }
    } finally {
      setRevertingAll(false);
    }
  };

  const openSyncAllConfirm = async () => {
    if (!prefabAssetId) return;
    const requestEntityId = entity.id;
    const token = syncPreflightRef.current.begin();
    setPendingSyncAllFor(requestEntityId);
    try {
      const count = await countPrefabInstances(exec, info?.scenes.map((s) => s.id) ?? [], prefabAssetId);
      // Drop the result silently if a newer Sync all click has started, or
      // selection has since moved to a different entity — either way this
      // count is no longer for what's on screen and must not pop a
      // destructive confirm dialog for it.
      if (syncPreflightRef.current.isCurrent(token) && selectionRef.current === requestEntityId) {
        setSyncAllTarget({ asset: prefabAssetId, count });
      }
    } catch (err) {
      log('error', 'editor', `Could not count prefab instances: ${(err as Error).message}`);
    } finally {
      setPendingSyncAllFor((id) => (id === requestEntityId ? null : id));
    }
  };

  return (
    <>
      <div className="panel-header">
        <span>Inspector</span>
        <span className="mono panel-header-detail">{entity.id}</span>
      </div>
      {entity.prefab && (
        <div className="prefab-banner">
          <span className="prefab-banner-icon">
            <Icon name="prefab" size={12} />
          </span>
          <span className="prefab-banner-text">
            Instance of <strong>{prefabAsset?.name ?? entity.prefab.asset}</strong>
          </span>
          {overrideCount > 0 && (
            <span className="prefab-banner-overrides">
              {overrideCount} override{overrideCount === 1 ? '' : 's'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {overrideCount > 0 && (
            <Button size="sm" disabled={revertingAll} onClick={() => setConfirmRevertAll(true)}>
              {revertingAll ? 'Reverting…' : 'Revert all'}
            </Button>
          )}
          <Button size="sm" onClick={() => void handleUpdatePrefab()}>
            Update prefab
          </Button>
          <Button
            size="sm"
            disabled={pendingSyncAllFor === entity.id}
            onClick={() => void openSyncAllConfirm()}
          >
            {pendingSyncAllFor === entity.id ? 'Syncing…' : 'Sync instances'}
          </Button>
        </div>
      )}
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
                <IconButton
                  bare
                  className="icon-btn danger"
                  icon="cross"
                  iconSize={10}
                  label={`Remove ${type}`}
                  onClick={() => setConfirmRemove(type)}
                />
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
                  // SpriteRenderer.frame only means anything when the assigned
                  // asset is a sliced sheet (getSheetFrames > 0) — a plain
                  // image or an unset assetId has no frames to pick, so the
                  // field is hidden rather than showing a raw text input.
                  if (type === 'SpriteRenderer' && field === 'frame') {
                    const asset = resolveAsset(
                      assets,
                      (component as Record<string, unknown>).assetId,
                    );
                    if (!asset || getSheetFrames(asset).length === 0) {
                      return null;
                    }
                  }
                  const property = `${type}.${field}`;
                  const rowKey = `${entity.id}.${property}`;
                  let control: React.ReactNode;
                  if (field === 'assetId' && type === 'AnimationStateMachine' && typeof value === 'string') {
                    // AnimationStateMachine.assetId picks from state-machine
                    // assets, with an inline Edit that opens the Animator
                    // editor for the chosen machine (mirrors SpriteAnimator's
                    // animation-asset dropdown below).
                    const options = assets.filter((a) => a.type === 'stateMachine');
                    control = (
                      <div className="asset-with-edit">
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
                        <Tooltip content={value ? 'Edit this state machine' : 'Assign a state machine to edit it'}>
                          <Button size="sm" disabled={!value} onClick={() => value && openAnimatorFor(value)}>
                            <Icon name="animator" size={11} /> Edit
                          </Button>
                        </Tooltip>
                      </div>
                    );
                  } else if (field === 'assetId' && type === 'SpriteAnimator' && typeof value === 'string') {
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
                  } else if (
                    type === 'SpriteRenderer' &&
                    field === 'frame' &&
                    (typeof value === 'string' || value === null)
                  ) {
                    // Reachable only when the hide-check above found frames.
                    const asset = resolveAsset(
                      assets,
                      (component as Record<string, unknown>).assetId,
                    );
                    const frames = asset ? getSheetFrames(asset) : [];
                    control = (
                      <select
                        key={rowKey}
                        className="select"
                        value={(value as string | null) ?? ''}
                        onChange={(e) => setProperty(property, e.target.value === '' ? null : e.target.value)}
                      >
                        <option value="">(whole image)</option>
                        {frames.map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    );
                  } else if (type === 'Text' && field === 'fontFamily' && typeof value === 'string') {
                    const fontAssets = assets.filter((a) => a.type === 'font');
                    control = (
                      <FontFamilyField
                        key={rowKey}
                        value={value}
                        fontAssets={fontAssets}
                        onCommit={(v) => setProperty(property, v)}
                      />
                    );
                  } else if (typeof value === 'string' && (doc?.enums[field]?.length ?? 0) > 0) {
                    // Any string field with schema-declared enum options (see
                    // COMPONENT_ENUMS) gets a dropdown instead of falling
                    // through to a raw text input — e.g. SpriteRenderer.shape,
                    // Text.align, UILayout.direction/align.
                    const options = doc!.enums[field];
                    control = (
                      <select
                        key={rowKey}
                        className="select"
                        value={value}
                        onChange={(e) => setProperty(property, e.target.value)}
                      >
                        {options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
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
                  } else if (isStringArray(value) && (value.length > 0 || field === 'collidesWith')) {
                    // String arrays get the row editor (never raw JSON). An EMPTY
                    // array is shapeless, so only trust the `collidesWith` field
                    // name for it. Collider.collidesWith defaults to ['*']; empty
                    // array is allowed (no collisions).
                    control = (
                      <StringListField
                        key={rowKey}
                        value={value}
                        onCommit={(list) => setProperty(property, list)}
                      />
                    );
                  } else if (type === 'Tilemap' && field === 'tileAssets' && isTileAssetsRecord(value)) {
                    control = (
                      <TileAssetsField
                        key={rowKey}
                        value={value}
                        assets={assets}
                        sceneId={sceneId}
                        entityId={entity.id}
                        exec={exec}
                      />
                    );
                  } else if (type === 'Camera' && field === 'postEffects' && Array.isArray(value)) {
                    // Camera.postEffects is a PostEffect[] (a 6-variant
                    // discriminated union) — never raw JSON. The stack
                    // editor lives in PostEffectsField.tsx/postEffectsList.ts
                    // so it stays unit-testable without a DOM, matching
                    // Vec2ListField/TileAssetsField. SpriteEffects needs no
                    // equivalent special case: it's flat scalars/colors/bools
                    // that already render via the branches above.
                    control = (
                      <PostEffectsField
                        key={rowKey}
                        value={value as PostEffect[]}
                        onCommit={(next) => setProperty(property, next)}
                      />
                    );
                  } else {
                    control = <UnsupportedField key={rowKey} value={value} property={property} />;
                  }
                  // A field carries the ember "overridden" dot + a per-field
                  // revert action once it (or a nested sub-path under it, or
                  // an ancestor field it's nested under) has a recorded
                  // instance override — see isFieldOverridden's ancestor/
                  // descendant handling for why a Vec2 axis-only edit still
                  // lights up the single "Position" row.
                  const overridden = isFieldOverridden(prefabInfo, type, field);
                  return (
                    <div className="inspector-row" key={field}>
                      <label className="field-label" title={property}>
                        {overridden && <span className="field-override-dot" aria-hidden="true" />}
                        {humanizeFieldLabel(field)}
                      </label>
                      {control}
                      {/* Render this 3rd grid cell on every field row of a prefab
                          instance member, overridden or not — see
                          .field-revert-slot in styles.css for why: it keeps the
                          control column the same width on every field row. On
                          non-instance entities (prefabInfo == null) no row can
                          ever be overridden, so the slot is omitted entirely and
                          the control column recovers its width — per-row
                          consistency within the card is preserved because the
                          gate is per-entity, never per-row. */}
                      {prefabInfo != null && (
                        <div className="field-revert-slot">
                          {overridden && (
                            <Tooltip content="Revert to the prefab's value">
                              <Button
                                size="sm"
                                className="field-revert-btn"
                                onClick={() => void handleRevertField(type, field)}
                              >
                                Revert
                              </Button>
                            </Tooltip>
                          )}
                        </div>
                      )}
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
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={11} /> Delete entity
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${entity.name}”?`}
        body="Its children are kept and re-parented one level up. This shows up in your undo history, so Ctrl/Cmd+Z brings it back."
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
      <ConfirmDialog
        open={syncAllTarget !== null}
        title="Sync all instances?"
        body={syncConfirmBody(syncAllTarget?.count ?? 0)}
        confirmLabel="Sync instances"
        danger
        onCancel={() => setSyncAllTarget(null)}
        onConfirm={() => {
          const target = syncAllTarget;
          setSyncAllTarget(null);
          if (target) void exec('syncPrefabInstances', { prefab: target.asset });
        }}
      />
      <ConfirmDialog
        open={confirmRevertAll}
        title="Revert all overrides?"
        body={revertAllConfirmBody(overrideCount)}
        confirmLabel="Revert all"
        danger
        onCancel={() => setConfirmRevertAll(false)}
        onConfirm={() => {
          setConfirmRevertAll(false);
          void handleRevertAll();
        }}
      />
    </>
  );
}
