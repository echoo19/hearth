/**
 * Game settings panel: the project's buildSettings — window size/title,
 * background, the game loop rates, the exported player's loading screen, and
 * the native app icon. No JSON textareas: every control is typed, mirroring
 * InputSettings/Inspector (NumberField/TextField/ColorField from ui.tsx, and
 * the same sprite-asset dropdown pattern the Inspector uses for assetId).
 *
 * Every edit is a single `updateSettings` exec carrying ONLY the field that
 * changed — the command deep-merges buildSettings (and buildSettings.loading)
 * field-by-field, so there's no lost-update race the way InputSettings' bulk
 * top-level replace keys have. That lets this panel read straight from
 * `info.buildSettings` (refreshed by exec on every mutation) instead of owning
 * optimistic local state. Undo/journal/live-patch all come for free from the
 * command path.
 *
 * The patch builders and the width/height validator are pulled to module
 * scope and exported so they're unit-testable without a DOM (this repo has no
 * jsdom/RTL — see consoleLinkClick.test.ts).
 */
import React, { useEffect, useState } from 'react';
import { useEditor } from '../store';
import type { AssetItem, LoadingSettings } from '../types';
import { fileUrl } from '../api';
import { ColorField, Icon, NumberField, TextField } from './ui';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Top-level buildSettings fields this panel edits with a raw scalar/id value. */
export type BuildField = 'title' | 'width' | 'height' | 'backgroundColor' | 'targetFps' | 'fixedTimestep' | 'icon';

/** updateSettings params for a single top-level buildSettings field — nothing else is touched. */
export function topPatch(field: BuildField, value: string | number | null): { buildSettings: Record<string, unknown> } {
  return { buildSettings: { [field]: value } };
}

/** updateSettings params for a single loading field — deep-merged, so only this field changes. */
export function loadingPatch(
  field: keyof LoadingSettings,
  value: string | boolean | null,
): { buildSettings: { loading: Record<string, unknown> } } {
  return { buildSettings: { loading: { [field]: value } } };
}

/**
 * Parse a width/height/rate draft into a positive integer, or null when it's
 * not a whole number ≥ `min`. The controls reject a null client-side (revert +
 * inline hint) rather than sending an invalid value the command would refuse.
 */
export function parsePositiveInt(raw: string, min = 1): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < min) return null;
  return n;
}

/**
 * The image-like assets an icon/loading-image picker offers (thumbnails
 * resolve from these) — sprite OR tile, matching the Inspector's own
 * assetId pickers (`a.type === 'sprite' || a.type === 'tile'`); a
 * tile-typed image (e.g. an autotile sheet reused as a loading image or
 * app icon) must not be a silent, unreachable capability gap here
 * (GAMESETTINGS-2 / L-074).
 */
export function spriteAssets(assets: AssetItem[]): AssetItem[] {
  return assets.filter((a) => a.type === 'sprite' || a.type === 'tile');
}

/** A picker's raw <select> value → asset id, mapping the empty "None" option to null. */
export function pickerValueToAssetId(raw: string): string | null {
  return raw === '' ? null : raw;
}

// A referenced-but-deleted asset id renders as a disabled sentinel option so
// the current value is never silently dropped (mirrors Inspector's assetId).
const MISSING_ASSET = '__missing__';

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * Whole-number field with a minimum. Like NumberField, but rejects a
 * non-integer / below-min draft client-side: it reverts to the committed value
 * and shows an inline hint instead of committing (used for width/height/rates).
 */
function IntField({
  value,
  min = 1,
  id,
  onCommit,
}: {
  value: number;
  min?: number;
  /** DOM id for the input, so a `<label htmlFor>` can associate with it (L-109). */
  id?: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(String(value));
    setError('');
  }, [value]);
  const commit = () => {
    const parsed = parsePositiveInt(draft, min);
    if (parsed === null) {
      setDraft(String(value));
      setError(`Must be a whole number ≥ ${min}`);
      return;
    }
    setError('');
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <div className="int-field">
      <input
        id={id}
        className={`input${error ? ' invalid' : ''}`}
        type="number"
        min={min}
        step="1"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(String(value));
            setError('');
          }
        }}
      />
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

/**
 * Sprite-asset dropdown with a "None" option — the icon/loading-image picker.
 * Optionally shows a thumbnail of the current sprite (from the project file
 * URL, same as the Assets panel). A value pointing at a deleted asset shows a
 * disabled "(missing asset)" option so it isn't silently lost.
 */
function SpriteAssetPicker({
  value,
  options,
  projectPath,
  showThumbnail = false,
  noneLabel = '(none)',
  ariaLabel,
  id,
  onCommit,
}: {
  value: string | null;
  options: AssetItem[];
  projectPath: string | null;
  showThumbnail?: boolean;
  noneLabel?: string;
  ariaLabel?: string;
  /** DOM id for the select, so a `<label htmlFor>` can associate with it (L-109). */
  id?: string;
  onCommit: (id: string | null) => void;
}) {
  const selected = value != null ? options.find((a) => a.id === value) : undefined;
  const missing = value != null && !selected;
  return (
    <div className="sprite-picker">
      {showThumbnail && (
        <span className="asset-thumb sprite-picker-thumb" aria-hidden="true">
          {selected && projectPath ? (
            <img src={fileUrl(projectPath, selected.path)} alt="" />
          ) : (
            <Icon name="image" size={16} />
          )}
        </span>
      )}
      <select
        id={id}
        className={`select${missing ? ' invalid' : ''}`}
        aria-label={ariaLabel}
        value={missing ? MISSING_ASSET : (value ?? '')}
        onChange={(e) => {
          if (e.target.value === MISSING_ASSET) return;
          onCommit(pickerValueToAssetId(e.target.value));
        }}
      >
        <option value="">{noneLabel}</option>
        {missing && (
          <option value={MISSING_ASSET} disabled>
            (missing asset)
          </option>
        )}
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function GameSettings() {
  const info = useEditor((s) => s.info);
  const assets = useEditor((s) => s.assets);
  const projectPath = useEditor((s) => s.projectPath);
  const exec = useEditor((s) => s.exec);

  // No `if (!info)` guard here: App.tsx only mounts the Workspace (and this
  // panel with it) once `projectPath` is set, and store.ts's `afterOpen`/
  // `closeProject` always set `projectPath` and `info` together in the same
  // `set()` call — there is no render where this panel is mounted with
  // `info` null. Confirmed unreachable and removed rather than kept as dead
  // defensive code (GAMESETTINGS-8 / L-079).
  const bs = info!.buildSettings;
  const sprites = spriteAssets(assets);

  const setField = (field: BuildField, value: string | number | null) =>
    void exec('updateSettings', topPatch(field, value), { quiet: true });
  const setLoading = (field: keyof LoadingSettings, value: string | boolean | null) =>
    void exec('updateSettings', loadingPatch(field, value), { quiet: true });

  return (
    <>
      <div className="panel-header">
        <span>Game Settings</span>
      </div>
      {/* game-settings-body layers a CSS-only scroll shadow on top of the
          shared .panel-body scroll (GAMESETTINGS-6 / L-075): at default dock
          height only Window + part of Loop are visible, with Fixed timestep,
          Loading, and all of Shipping (incl. the Icon field) below the fold
          and no other cue that there's more to scroll to. */}
      <div className="panel-body game-settings-body">
        <div className="diff-section">
          <h4>Window</h4>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-title">
              Title
            </label>
            <TextField
              id="game-title"
              value={bs.title}
              placeholder="My game"
              onCommit={(v) => {
                // A blank window title is meaningless — reject client-side
                // (revert + inline reason) rather than silently commit "".
                if (!v.trim()) return 'Title can’t be empty.';
                setField('title', v);
              }}
            />
          </div>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-width">
              Width
            </label>
            <IntField id="game-width" value={bs.width} min={1} onCommit={(v) => setField('width', v)} />
          </div>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-height">
              Height
            </label>
            <IntField id="game-height" value={bs.height} min={1} onCommit={(v) => setField('height', v)} />
          </div>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-bg">
              Background
            </label>
            <ColorField id="game-bg" value={bs.backgroundColor} onCommit={(v) => setField('backgroundColor', v)} />
          </div>
        </div>

        <div className="diff-section">
          <h4>Loop</h4>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-fps" title="Target frames per second">
              Target FPS
            </label>
            <IntField id="game-fps" value={bs.targetFps} min={1} onCommit={(v) => setField('targetFps', v)} />
          </div>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-timestep" title="Fixed physics/update timestep in Hz">
              Fixed timestep
            </label>
            <IntField id="game-timestep" value={bs.fixedTimestep} min={1} onCommit={(v) => setField('fixedTimestep', v)} />
          </div>
        </div>

        <div className="diff-section">
          <h4>Loading</h4>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-loading-bg">
              Background
            </label>
            <ColorField
              id="game-loading-bg"
              value={bs.loading.backgroundColor}
              onCommit={(v) => setLoading('backgroundColor', v)}
            />
          </div>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-loading-image">
              Image
            </label>
            <SpriteAssetPicker
              id="game-loading-image"
              value={bs.loading.image}
              options={sprites}
              projectPath={projectPath}
              showThumbnail
              ariaLabel="Loading image"
              onCommit={(id) => setLoading('image', id)}
            />
          </div>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-loading-spinner">
              Spinner
            </label>
            <input
              id="game-loading-spinner"
              type="checkbox"
              checked={bs.loading.spinner}
              onChange={(e) => setLoading('spinner', e.target.checked)}
            />
          </div>
        </div>

        <div className="diff-section">
          <h4>Shipping</h4>
          <div className="inspector-row">
            <label className="field-label" htmlFor="game-icon">
              Icon
            </label>
            <SpriteAssetPicker
              id="game-icon"
              value={bs.icon}
              options={sprites}
              projectPath={projectPath}
              showThumbnail
              ariaLabel="App icon"
              onCommit={(id) => setField('icon', id)}
            />
          </div>
          <p className="field-fallback-note game-settings-hint">Used as the desktop app icon.</p>
        </div>
      </div>
    </>
  );
}
