import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getSheetFrames } from '@hearth/core';
import { useEditor } from '../store';
import { apiImportAsset, fileUrl } from '../api';
import type { AssetItem } from '../types';
import { ConfirmDialog, Icon, Modal } from './ui';
import { SliceDialog } from './SliceDialog';
import { frameCrop, parseFrameRef, readSheetSize } from '../assetPreview';
import { countPrefabInstances, createSyncPreflight, syncConfirmBody } from '../prefabActions';

/** One animation asset's resolved first-frame thumbnail (fetched from its
 * .anim.json), or null once we've tried and found nothing showable. */
type AnimThumb =
  | { kind: 'sprite'; assetRef: string }
  | { kind: 'crop'; sheetRef: string; frameName: string }
  | null;

const SPRITE_SHAPES = [
  'rectangle',
  'circle',
  'triangle',
  'diamond',
  'star',
  'capsule',
  'polygon',
  'character',
  'enemy',
  'coin',
  'heart',
] as const;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif'];
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg'];
const FONT_EXTENSIONS = ['ttf', 'otf', 'woff', 'woff2'];
const IMPORT_EXTENSIONS = [...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...FONT_EXTENSIONS];
const IMPORT_ACCEPT = IMPORT_EXTENSIONS.map((e) => `.${e}`).join(',');
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Animation frame refs are asset ids from createAnimationAsset, but agents
 * (and createAnimationFromSheet's suggestion text) may hand-write a name —
 * accept either, id first. */
function resolveAssetRef(assets: AssetItem[], ref: string): AssetItem | null {
  return assets.find((a) => a.id === ref) ?? assets.find((a) => a.name === ref) ?? null;
}

/** Sliced-sheet detail view: every frame cropped to a small swatch with its
 * name beneath, laid out as a wrapping grid (never raw JSON). */
function FrameGrid({ projectPath, asset }: { projectPath: string; asset: AssetItem }) {
  const frames = getSheetFrames(asset);
  const sheetSize = readSheetSize(asset);
  if (frames.length === 0 || !sheetSize) return null;
  const imageUrl = fileUrl(projectPath, asset.path);
  return (
    <div className="frame-grid">
      {frames.map((frame) => {
        const crop = frameCrop(imageUrl, sheetSize, frame, 44);
        return (
          <div className="frame-cell-wrap" key={frame.name}>
            <div className="frame-cell checkerboard-bg" style={{ width: crop.width, height: crop.height }}>
              <div style={crop.style} />
            </div>
            <span className="frame-cell-name mono" title={frame.name}>
              {frame.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function AssetsPanel() {
  const projectPath = useEditor((s) => s.projectPath);
  const assets = useEditor((s) => s.assets);
  const info = useEditor((s) => s.info);
  const scene = useEditor((s) => s.scene);
  const sceneId = useEditor((s) => s.sceneId);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const exec = useEditor((s) => s.exec);
  const refresh = useEditor((s) => s.refresh);
  const log = useEditor((s) => s.log);
  const sceneViewCenter = useEditor((s) => s.sceneViewCenter);

  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [spriteDialog, setSpriteDialog] = useState(false);
  const [tileDialog, setTileDialog] = useState(false);
  const [sliceDialog, setSliceDialog] = useState(false);
  const [syncTarget, setSyncTarget] = useState<{ asset: AssetItem; count: number } | null>(null);
  // Sync's instance-count preflight (countPrefabInstances) is a multi-scene
  // round-trip — while it's in flight the user can click Sync again (same or
  // a different asset) or select a different asset entirely. The token
  // guards "no newer request started"; the ref guards "the asset the user is
  // still looking at hasn't changed" (selectedAssetId is stale in the
  // closure once we're past the `await`).
  const syncPreflightRef = useRef(createSyncPreflight());
  const selectedAssetIdRef = useRef<string | null>(null);
  const [pendingSyncAssetId, setPendingSyncAssetId] = useState<string | null>(null);

  // animation card thumbnails: resolved lazily from each animation's
  // .anim.json (first frame ref), cached per asset id so re-renders don't
  // refetch.
  const [animThumbs, setAnimThumbs] = useState<Record<string, AnimThumb>>({});
  const animFetchedRef = useRef<Set<string>>(new Set());

  // font previews: FontFace is loaded once per family (asset name) and
  // cached — document.fonts keeps it registered for the panel's lifetime,
  // this ref just stops us from re-issuing the same load.
  const fontAttemptedRef = useRef<Set<string>>(new Set());
  const [loadedFontNames, setLoadedFontNames] = useState<ReadonlySet<string>>(new Set());

  // sprite dialog state
  const [spName, setSpName] = useState('');
  const [spShape, setSpShape] = useState<string>('rectangle');
  const [spColor, setSpColor] = useState('#3498db');
  const [spWidth, setSpWidth] = useState(32);
  const [spHeight, setSpHeight] = useState(32);

  // tile dialog state
  const [tName, setTName] = useState('');
  const [tColor, setTColor] = useState('#2ecc71');
  const [tSize, setTSize] = useState(32);

  // file import (button + drag-and-drop)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);
  const [importing, setImporting] = useState(false);

  // audio preview: one element at a time
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingAssetId, setPlayingAssetId] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    selectedAssetIdRef.current = selectedAssetId;
  }, [selectedAssetId]);

  // Animation cards show a first-frame thumbnail: fetch each animation
  // asset's .anim.json once and remember whether frame[0] is a plain
  // sprite/tile ref or a "<sheetId>#<frameName>" sheet crop.
  useEffect(() => {
    if (!projectPath) return;
    const pending = assets.filter((a) => a.type === 'animation' && !animFetchedRef.current.has(a.id));
    if (pending.length === 0) return;
    for (const asset of pending) animFetchedRef.current.add(asset.id);
    void (async () => {
      const resolved: Record<string, AnimThumb> = {};
      for (const asset of pending) {
        try {
          const res = await fetch(fileUrl(projectPath, asset.path));
          const data = (await res.json()) as { frames?: unknown };
          const first = Array.isArray(data.frames) ? data.frames[0] : undefined;
          if (typeof first !== 'string' || first.length === 0) {
            resolved[asset.id] = null;
            continue;
          }
          const { assetRef, frameName } = parseFrameRef(first);
          resolved[asset.id] = frameName === null ? { kind: 'sprite', assetRef } : { kind: 'crop', sheetRef: assetRef, frameName };
        } catch {
          resolved[asset.id] = null;
        }
      }
      setAnimThumbs((prev) => ({ ...prev, ...resolved }));
    })();
  }, [assets, projectPath]);

  // Font cards/details render a live sample once the family is loaded.
  useEffect(() => {
    if (!projectPath || typeof FontFace === 'undefined') return;
    const fonts = assets.filter((a) => a.type === 'font' && !fontAttemptedRef.current.has(a.name));
    for (const asset of fonts) {
      fontAttemptedRef.current.add(asset.name);
      const url = fileUrl(projectPath, asset.path);
      const face = new FontFace(asset.name, `url("${url.replace(/[\\"]/g, '\\$&')}")`);
      void face
        .load()
        .then((loaded) => {
          document.fonts.add(loaded);
          setLoadedFontNames((prev) => new Set(prev).add(asset.name));
        })
        .catch((err: Error) => {
          log('warn', 'editor', `Could not load font "${asset.name}": ${err.message}`);
        });
    }
  }, [assets, projectPath, log]);

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingAssetId(null);
  }

  function togglePreview(asset: AssetItem) {
    if (playingAssetId === asset.id) {
      stopPreview();
      return;
    }
    if (!projectPath) return;
    audioRef.current?.pause();
    const el = new Audio(fileUrl(projectPath, asset.path));
    el.onended = () => setPlayingAssetId((id) => (id === asset.id ? null : id));
    el.onerror = () => {
      log('error', 'editor', `Could not play ${asset.name} (${asset.path})`);
      setPlayingAssetId((id) => (id === asset.id ? null : id));
    };
    audioRef.current = el;
    setPlayingAssetId(asset.id);
    void el.play().catch((err: Error) => {
      log('error', 'editor', `Could not play ${asset.name}: ${err.message}`);
      setPlayingAssetId((id) => (id === asset.id ? null : id));
    });
  }

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  );
  const selectedEntity = useMemo(
    () => scene?.entities.find((e) => e.id === selection),
    [scene, selection],
  );
  const canAssignSprite =
    selectedAsset !== null &&
    (selectedAsset.type === 'sprite' || selectedAsset.type === 'tile') &&
    selectedEntity?.components.SpriteRenderer !== undefined;
  const canAssignAudio =
    selectedAsset !== null &&
    selectedAsset.type === 'audio' &&
    selectedEntity?.components.AudioSource !== undefined;
  const canAssign = canAssignSprite || canAssignAudio;
  const assignProperty = canAssignAudio ? 'AudioSource.assetId' : 'SpriteRenderer.assetId';

  async function createSprite() {
    const result = await exec('createSpriteAsset', {
      name: spName.trim(),
      shape: spShape,
      color: spColor,
      width: spWidth,
      height: spHeight,
    });
    if (result.success) {
      setSpriteDialog(false);
      setSpName('');
    }
  }

  async function createTile() {
    const result = await exec('createTileAsset', { name: tName.trim(), color: tColor, size: tSize });
    if (result.success) {
      setTileDialog(false);
      setTName('');
    }
  }

  async function addPrefabToScene(asset: AssetItem) {
    if (!sceneId) return;
    // Falls back to (0,0) when no SceneView has mounted/measured yet (e.g.
    // the Scene panel is closed) — no seam into SceneView internals beyond
    // the store's published sceneViewCenter.
    const position = sceneViewCenter ?? { x: 0, y: 0 };
    const result = await exec<{ entity: { id: string } }>('instantiatePrefab', {
      prefab: asset.id,
      scene: sceneId,
      position,
    });
    if (result.success && result.data) select(result.data.entity.id);
  }

  async function openSyncConfirm(asset: AssetItem) {
    const token = syncPreflightRef.current.begin();
    setPendingSyncAssetId(asset.id);
    try {
      const count = await countPrefabInstances(exec, info?.scenes.map((s) => s.id) ?? [], asset.id);
      // Drop the result silently if a newer Sync click has started, or the
      // user has since selected a different asset — either way this count
      // is no longer for what's on screen and must not pop a destructive
      // confirm dialog for it.
      if (syncPreflightRef.current.isCurrent(token) && selectedAssetIdRef.current === asset.id) {
        setSyncTarget({ asset, count });
      }
    } catch (err) {
      log('error', 'editor', `Could not count "${asset.name}" instances: ${(err as Error).message}`);
    } finally {
      setPendingSyncAssetId((id) => (id === asset.id ? null : id));
    }
  }

  async function importFiles(files: Iterable<File>) {
    if (!projectPath) return;
    const fileList = Array.from(files);
    if (fileList.length === 0) return;
    setImporting(true);
    let imported = 0;
    const failed: { name: string; reason: string }[] = [];
    try {
      for (const file of fileList) {
        const ext = extensionOf(file.name);
        if (!IMPORT_EXTENSIONS.includes(ext)) {
          const reason = `images (${IMAGE_EXTENSIONS.join(', ')}), audio (${AUDIO_EXTENSIONS.join(', ')}), and fonts (${FONT_EXTENSIONS.join(', ')}) can be imported`;
          log('warn', 'editor', `Skipped "${file.name}": ${reason}.`);
          failed.push({ name: file.name, reason });
          continue;
        }
        if (file.size > MAX_IMPORT_BYTES) {
          const reason = 'larger than the 25 MB import limit';
          log('warn', 'editor', `Skipped "${file.name}": ${reason}.`);
          failed.push({ name: file.name, reason });
          continue;
        }
        try {
          const result = await apiImportAsset(projectPath, file.name, await fileToBase64(file));
          if (result.success) {
            imported++;
            const asset = (result.data as { asset?: AssetItem } | null)?.asset;
            log('info', 'editor', `Imported "${asset?.name ?? file.name}"${asset ? ` → ${asset.path}` : ''}`);
          } else {
            const reason = result.errors.map((e) => e.message).join('; ') || 'import failed';
            for (const err of result.errors) log('error', 'command', `importAsset: ${err.message}`);
            failed.push({ name: file.name, reason });
          }
        } catch (err) {
          const reason = (err as Error).message;
          log('error', 'editor', `Import of "${file.name}" failed: ${reason}`);
          failed.push({ name: file.name, reason });
        }
      }
      // A per-file breakdown already went to the console above; for a
      // multi-file batch also fold it into one summary line so a partial
      // failure ("imported 3, failed 1: coin.exe (...)") reads at a glance
      // instead of scrolling console history.
      if (fileList.length > 1) {
        if (failed.length === 0) {
          log('info', 'editor', `Imported ${imported}/${fileList.length} files.`);
        } else {
          log(
            'warn',
            'editor',
            `Imported ${imported}, failed ${failed.length}: ${failed.map((f) => `${f.name} (${f.reason})`).join(', ')}`,
          );
        }
      }
    } finally {
      setImporting(false);
    }
    if (imported > 0) await refresh();
  }

  function dragHasFiles(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }

  function preview(asset: AssetItem): React.ReactNode {
    if (asset.type === 'audio') {
      const playing = playingAssetId === asset.id;
      return (
        <button
          className={`audio-preview-btn${playing ? ' playing' : ''}`}
          title={playing ? 'Stop preview' : 'Play preview'}
          aria-label={playing ? `Stop ${asset.name}` : `Play ${asset.name}`}
          onClick={(e) => {
            e.stopPropagation();
            togglePreview(asset);
          }}
        >
          <Icon name={playing ? 'stop' : 'play'} size={13} />
        </button>
      );
    }
    if (projectPath && (asset.type === 'sprite' || asset.type === 'tile')) {
      return <img src={fileUrl(projectPath, asset.path)} alt="" />;
    }
    if (projectPath && asset.type === 'animation') {
      const thumb = animThumbs[asset.id];
      if (thumb?.kind === 'sprite') {
        const frameAsset = resolveAssetRef(assets, thumb.assetRef);
        if (frameAsset && (frameAsset.type === 'sprite' || frameAsset.type === 'tile')) {
          return <img src={fileUrl(projectPath, frameAsset.path)} alt="" />;
        }
      } else if (thumb?.kind === 'crop') {
        const sheetAsset = resolveAssetRef(assets, thumb.sheetRef);
        const sheetSize = sheetAsset ? readSheetSize(sheetAsset) : null;
        const frame = sheetAsset ? getSheetFrames(sheetAsset).find((f) => f.name === thumb.frameName) : undefined;
        if (sheetAsset && sheetSize && frame) {
          const crop = frameCrop(fileUrl(projectPath, sheetAsset.path), sheetSize, frame, 40);
          return (
            <div
              className="checkerboard-bg"
              style={{ position: 'relative', width: crop.width, height: crop.height, borderRadius: 'var(--radius-sm)' }}
            >
              <div style={crop.style} />
            </div>
          );
        }
      }
      return (
        <span style={{ color: 'var(--ink-faint)' }}>
          <Icon name="play" size={20} />
        </span>
      );
    }
    if (asset.type === 'prefab') {
      return (
        <span style={{ color: 'var(--ink-faint)' }}>
          <Icon name="prefab" size={20} />
        </span>
      );
    }
    if (asset.type === 'font') {
      if (loadedFontNames.has(asset.name)) {
        return (
          <span className="font-thumb-sample" style={{ fontFamily: `"${asset.name}"` }}>
            Aa
          </span>
        );
      }
      return (
        <span style={{ color: 'var(--ink-faint)' }}>
          <Icon name="text" size={20} />
        </span>
      );
    }
    return (
      <span style={{ color: 'var(--ink-faint)' }}>
        <Icon name="entity" size={20} />
      </span>
    );
  }

  return (
    <div
      className={`assets-panel${dropping ? ' dropping' : ''}`}
      onDragEnter={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        dragDepth.current++;
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (dragHasFiles(e)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!dragHasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropping(false);
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        void importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="panel-toolbar">
        <button className="btn btn-sm" onClick={() => setSpriteDialog(true)}>
          <Icon name="plus" /> Sprite
        </button>
        <button className="btn btn-sm" onClick={() => setTileDialog(true)}>
          <Icon name="plus" /> Tile
        </button>
        <span className="divider" style={{ width: 1, height: 16, background: 'var(--border-strong)' }} />
        <button
          className="btn btn-sm"
          disabled={importing}
          title="Import images (png, jpg, svg, webp, gif), audio (wav, mp3, ogg), and fonts (ttf, otf, woff, woff2). You can also drop files onto this panel."
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="upload" /> {importing ? 'Importing…' : 'Import…'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={IMPORT_ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            if (files.length > 0) void importFiles(files);
          }}
        />
      </div>

      <div className="panel-body">
        {assets.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="image" size={16} />
            </span>
            <span>No assets yet</span>
            <span className="hint">
              Create a procedural placeholder sprite or tile above (deterministic SVGs that agents can also
              generate via createSpriteAsset), or bring your own images, sounds, and fonts with Import… —
              dropping files onto this panel works too.
            </span>
          </div>
        ) : (
          <div className="asset-grid">
            {assets.map((asset) => {
              const isSheet = asset.type === 'sprite' || asset.type === 'tile';
              const frameCount = isSheet ? getSheetFrames(asset).length : 0;
              const prefabEntityCount = asset.type === 'prefab' ? (asset.prefab?.entityCount ?? null) : null;
              return (
                <div
                  key={asset.id}
                  className={`asset-card${selectedAssetId === asset.id ? ' selected' : ''}`}
                  onClick={() => setSelectedAssetId(asset.id === selectedAssetId ? null : asset.id)}
                >
                  <div className="asset-thumb">{preview(asset)}</div>
                  <span className="asset-name" title={asset.name}>
                    {asset.name}
                  </span>
                  <span className="asset-type">{asset.type}</span>
                  {frameCount > 0 && (
                    <span className="asset-count-badge">
                      {frameCount} frame{frameCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {prefabEntityCount !== null && (
                    <span className="asset-count-badge">
                      {prefabEntityCount} entit{prefabEntityCount === 1 ? 'y' : 'ies'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedAsset && (
        <div className="asset-details">
          <div className="asset-details-row">
            <strong>{selectedAsset.name}</strong>
            <span className="mono">{selectedAsset.path}</span>
            <span className="mono" style={{ color: 'var(--ink-faint)' }}>
              {selectedAsset.id}
            </span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(selectedAsset.id);
                log('info', 'editor', `Copied asset id ${selectedAsset.id}`);
              }}
            >
              <Icon name="copy" size={11} /> Copy id
            </button>
            <span style={{ flex: 1 }} />
            {(selectedAsset.type === 'sprite' || selectedAsset.type === 'tile') && (
              <button className="btn btn-sm" onClick={() => setSliceDialog(true)}>
                <Icon name="grid" size={11} /> Slice…
              </button>
            )}
            {selectedAsset.type === 'prefab' ? (
              <>
                <button
                  className="btn btn-sm"
                  disabled={!sceneId}
                  title={sceneId ? `Instantiate into "${scene?.name}" at the viewport center` : 'Open a scene first'}
                  onClick={() => void addPrefabToScene(selectedAsset)}
                >
                  <Icon name="plus" size={11} /> Add to scene
                </button>
                <button
                  className="btn btn-sm"
                  disabled={pendingSyncAssetId === selectedAsset.id}
                  onClick={() => void openSyncConfirm(selectedAsset)}
                >
                  <Icon name="prefab" size={11} />{' '}
                  {pendingSyncAssetId === selectedAsset.id ? 'Syncing…' : 'Sync instances'}
                </button>
              </>
            ) : (
              <button
                className="btn btn-sm"
                disabled={!canAssign}
                title={
                  canAssign
                    ? `Set ${selectedEntity?.name}'s ${assignProperty}`
                    : selectedAsset.type === 'audio'
                      ? 'Select an entity with an AudioSource to assign'
                      : 'Select an entity with a SpriteRenderer to assign'
                }
                onClick={() =>
                  selectedEntity &&
                  sceneId &&
                  void exec('setComponentProperty', {
                    scene: sceneId,
                    entity: selectedEntity.id,
                    property: assignProperty,
                    value: selectedAsset.id,
                  })
                }
              >
                Assign to {selectedEntity ? `“${selectedEntity.name}”` : 'selection'}
              </button>
            )}
          </div>

          {projectPath &&
            (selectedAsset.type === 'sprite' || selectedAsset.type === 'tile') &&
            getSheetFrames(selectedAsset).length > 0 && <FrameGrid projectPath={projectPath} asset={selectedAsset} />}

          {selectedAsset.type === 'font' &&
            (loadedFontNames.has(selectedAsset.name) ? (
              <span className="font-sample" style={{ fontFamily: `"${selectedAsset.name}"` }}>
                Aa Bb 0123 — Hearth
              </span>
            ) : (
              <span style={{ color: 'var(--ink-faint)', fontSize: 12 }}>Loading font preview…</span>
            ))}
        </div>
      )}

      {dropping && (
        <div className="drop-target" aria-hidden="true">
          <span>Drop images, audio, or fonts to import</span>
        </div>
      )}

      {/* Create sprite */}
      <Modal open={spriteDialog} title="Create procedural sprite" onClose={() => setSpriteDialog(false)}>
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label">Name</label>
            <input className="input" value={spName} onChange={(e) => setSpName(e.target.value)} autoFocus placeholder="coin" />
          </div>
          <div className="form-field">
            <label className="field-label">Shape</label>
            <select className="select" value={spShape} onChange={(e) => setSpShape(e.target.value)}>
              {SPRITE_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="inspector-row">
            <label className="field-label">Color</label>
            <div className="color-pair">
              <input type="color" value={spColor} onChange={(e) => setSpColor(e.target.value)} />
              <input className="input mono" value={spColor} onChange={(e) => setSpColor(e.target.value)} />
            </div>
          </div>
          <div className="inspector-row">
            <label className="field-label">Size</label>
            <div className="vec2-pair">
              <input
                className="input"
                type="number"
                min={1}
                max={1024}
                value={spWidth}
                onChange={(e) => setSpWidth(Number(e.target.value) || 32)}
              />
              <input
                className="input"
                type="number"
                min={1}
                max={1024}
                value={spHeight}
                onChange={(e) => setSpHeight(Number(e.target.value) || 32)}
              />
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setSpriteDialog(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!spName.trim()} onClick={() => void createSprite()}>
            Create sprite
          </button>
        </div>
      </Modal>

      {/* Create tile */}
      <Modal open={tileDialog} title="Create procedural tile" onClose={() => setTileDialog(false)}>
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label">Name</label>
            <input className="input" value={tName} onChange={(e) => setTName(e.target.value)} autoFocus placeholder="grass" />
          </div>
          <div className="inspector-row">
            <label className="field-label">Color</label>
            <div className="color-pair">
              <input type="color" value={tColor} onChange={(e) => setTColor(e.target.value)} />
              <input className="input mono" value={tColor} onChange={(e) => setTColor(e.target.value)} />
            </div>
          </div>
          <div className="inspector-row">
            <label className="field-label">Size (px)</label>
            <input
              className="input"
              type="number"
              min={1}
              max={256}
              value={tSize}
              onChange={(e) => setTSize(Number(e.target.value) || 32)}
            />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setTileDialog(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!tName.trim()} onClick={() => void createTile()}>
            Create tile
          </button>
        </div>
      </Modal>

      <SliceDialog open={sliceDialog} asset={selectedAsset} onClose={() => setSliceDialog(false)} />

      <ConfirmDialog
        open={syncTarget !== null}
        title={`Sync "${syncTarget?.asset.name ?? ''}" instances?`}
        body={syncConfirmBody(syncTarget?.count ?? 0)}
        confirmLabel="Sync instances"
        danger
        onCancel={() => setSyncTarget(null)}
        onConfirm={() => {
          const target = syncTarget;
          setSyncTarget(null);
          if (target) void exec('syncPrefabInstances', { prefab: target.asset.id });
        }}
      />
    </div>
  );
}
