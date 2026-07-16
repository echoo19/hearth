import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { getSheetFrames, SOUND_PRESETS } from '@hearth/core';
import { useEditor } from '../store';
import { apiImportAssets, fileUrl } from '../api';
import type { AssetItem } from '../types';
import { ConfirmDialog, Icon, Modal } from './ui';
import { Button, IconButton } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { ContextMenu, type MenuItem } from './ui/Menu';
import { frameCrop, parseFrameRef, readSheetSize } from '../assetPreview';
import { countPrefabInstances, createSyncPreflight, syncConfirmBody } from '../prefabActions';
import { collectDropEntries, entriesFromDataTransferItems } from '../dropEntries';
import { CreateStateMachineDialog } from './CreateStateMachineDialog';

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

// SliceDialog only ever mounts once a spritesheet asset is selected and
// "Slice…" is clicked, so lazy-loading it costs nothing on the common
// (no-dialog) path and keeps its module out of the panel's initial chunk.
const SliceDialog = lazy(() => import('./SliceDialog').then((m) => ({ default: m.SliceDialog })));

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

// Asset cards are clickable divs, not native buttons — Enter/Space is the
// keyboard equivalent of the click that (de)selects a card. Exported (module
// scope, not a closure) so it's unit-testable without a DOM.
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/**
 * Roving-tabindex grid navigation (L-047 / ASSETS-6): the index an arrow /
 * Home / End keydown moves focus to, given the rendered card count and the
 * grid's current column count. Left/Right step ±1 clamped at the ends;
 * Up/Down step a whole row (Down from a full row above a shorter last row
 * lands on the last card). Pure — exported for unit tests.
 */
export function gridNavIndex(
  count: number,
  columns: number,
  current: number,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
): number {
  if (count <= 0) return 0;
  const cols = Math.max(1, columns);
  const last = count - 1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowLeft':
      return Math.max(0, current - 1);
    case 'ArrowRight':
      return Math.min(last, current + 1);
    case 'ArrowUp':
      return current - cols >= 0 ? current - cols : current;
    case 'ArrowDown': {
      if (current + cols <= last) return current + cols;
      // On a row above a shorter final row: land on the last card. Already on
      // the last row (nothing below): stay put.
      const lastRowStart = Math.floor(last / cols) * cols;
      return current >= lastRowStart ? current : last;
    }
  }
}

/** Search-filter predicate for the panel's name/type filter box — matches
 * substrings of either the asset's name or its type label, case-insensitive.
 * Exported (module scope) for unit tests. */
export function matchesAssetQuery(asset: Pick<AssetItem, 'name' | 'type'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return asset.name.toLowerCase().includes(q) || asset.type.toLowerCase().includes(q);
}

/** Humanized skip-reason for an unsupported import extension (ASSETS-8):
 * lead with the actual problem instead of the full images/audio/fonts
 * capability list — that list already lives in the Import button's tooltip. */
export function unsupportedExtensionReason(filename: string): string {
  const ext = extensionOf(filename);
  return ext ? `".${ext}" files aren't supported` : "files without an extension aren't supported";
}

/** What assigning `asset` to `entity` would set — `null` when the asset type
 * and the entity's components aren't a compatible pair. One shared rule for
 * the details-row Assign button, double-click, and the card's context menu. */
export function assignTarget(
  asset: Pick<AssetItem, 'type'> | null | undefined,
  entity: { components: Record<string, unknown> } | null | undefined,
): { property: string } | null {
  if (!asset || !entity) return null;
  if ((asset.type === 'sprite' || asset.type === 'tile') && entity.components.SpriteRenderer !== undefined) {
    return { property: 'SpriteRenderer.assetId' };
  }
  if (asset.type === 'audio' && entity.components.AudioSource !== undefined) {
    return { property: 'AudioSource.assetId' };
  }
  return null;
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
  const openAnimatorFor = useEditor((s) => s.openAnimatorFor);

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
  const [spError, setSpError] = useState<string | null>(null);

  // tile dialog state
  const [tName, setTName] = useState('');
  const [tColor, setTColor] = useState('#2ecc71');
  const [tSize, setTSize] = useState(32);
  const [tError, setTError] = useState<string | null>(null);

  // state machine create dialog — the shared CreateStateMachineDialog
  // (T9-U8 unified this with AnimatorEditor's copy; it owns its own state).
  const [smDialog, setSmDialog] = useState(false);

  // "+ Sound" create dialog (L-049 / ASSETS-9): name + preset over the
  // engine's real createSound presets.
  const [soundDialog, setSoundDialog] = useState(false);
  const [sndName, setSndName] = useState('');
  const [sndPreset, setSndPreset] = useState<string>(SOUND_PRESETS[0]);
  const [sndError, setSndError] = useState<string | null>(null);

  // name/type filter (ASSETS-4)
  const [filterQuery, setFilterQuery] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);
  const filteredAssets = useMemo(
    () => assets.filter((a) => matchesAssetQuery(a, filterQuery)),
    [assets, filterQuery],
  );

  // Arrow-key grid navigation (L-047): roving tabindex — one card is the tab
  // stop, arrows/Home/End move DOM focus between cards. The column count is
  // read from the grid's computed style at keydown time so it tracks panel
  // resizes for free.
  const gridRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  function onCardNavKey(e: React.KeyboardEvent, index: number) {
    const key = e.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return false;
    e.preventDefault();
    const grid = gridRef.current;
    const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1;
    const target = filteredAssets[gridNavIndex(filteredAssets.length, columns, index, key)];
    if (target) cardRefs.current.get(target.id)?.focus();
    return true;
  }

  // delete (ASSETS-1): a confirm step, then — on a referenced-by CONFLICT —
  // the command's own message surfaced verbatim in a second dialog rather
  // than summarized away.
  const [deletingAsset, setDeletingAsset] = useState<AssetItem | null>(null);
  const [deleteError, setDeleteError] = useState<{ name: string; message: string } | null>(null);

  // right-click context menu (ASSETS-1), rendered via the shared ContextMenu
  // primitive (viewport clamping + dismiss + focus-restore contracts).
  // `returnFocus` is the invoking card so dismissal doesn't strand keyboard
  // focus on the body.
  const [contextMenu, setContextMenu] = useState<{
    asset: AssetItem;
    x: number;
    y: number;
    returnFocus: HTMLElement | null;
  } | null>(null);

  // file import (button + drag-and-drop)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<{ name: string; reason: string }[]>([]);

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
  const assignment = assignTarget(selectedAsset, selectedEntity);

  /** Assign `asset` to the currently selected entity's matching component —
   * shared by the details-row Assign button, double-click, and the
   * context-menu's "Assign to selection" item so all three agree on exactly
   * one compatibility rule (`assignTarget`). */
  function assignAssetToSelection(asset: AssetItem) {
    const target = assignTarget(asset, selectedEntity);
    if (!target || !selectedEntity || !sceneId) return;
    void exec('setComponentProperty', {
      scene: sceneId,
      entity: selectedEntity.id,
      property: target.property,
      value: asset.id,
    });
  }

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
      setSpError(null);
    } else {
      // Surface the failure inline (e.g. a name CONFLICT) instead of only a
      // Console tab badge — the dialog otherwise looks like a silent no-op.
      setSpError(result.errors[0]?.message ?? 'Could not create the sprite.');
    }
  }

  async function createTile() {
    const result = await exec('createTileAsset', { name: tName.trim(), color: tColor, size: tSize });
    if (result.success) {
      setTileDialog(false);
      setTName('');
      setTError(null);
    } else {
      setTError(result.errors[0]?.message ?? 'Could not create the tile.');
    }
  }

  // "+ Sound" (L-049): a procedural sound from the engine's createSound
  // command — name + preset, nothing more (the seed stays the command's
  // deterministic default so the editor and an agent produce identical audio).
  async function createSound() {
    const result = await exec<{ asset: { id: string } }>('createSound', {
      name: sndName.trim(),
      preset: sndPreset,
    });
    if (result.success) {
      setSoundDialog(false);
      setSndName('');
      setSndError(null);
      if (result.data) setSelectedAssetId(result.data.asset.id);
    } else {
      setSndError(result.errors[0]?.message ?? 'Could not create the sound.');
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

  // Delete (ASSETS-1). removeAsset's delete-while-referenced protection
  // already produces an excellent message ("Asset "X" is still referenced
  // by: …") — on failure it's shown verbatim in deleteError, not summarized.
  async function confirmDelete() {
    const asset = deletingAsset;
    setDeletingAsset(null);
    if (!asset) return;
    const result = await exec('removeAsset', { asset: asset.id, deleteFile: true });
    if (result.success) {
      setSelectedAssetId((cur) => (cur === asset.id ? null : cur));
    } else {
      setDeleteError({ name: asset.name, message: result.errors[0]?.message ?? `Could not delete "${asset.name}".` });
    }
  }

  // Double-click (ASSETS-5): perform the asset's primary action instead of
  // toggling selection twice (which used to read as a select/deselect
  // flicker). Judged per type — stateMachine opens the Animator, audio
  // toggles its preview, a prefab drops into the current scene, and
  // everything else (sprite/tile/font/animation/data/other) assigns to the
  // selected entity when a compatible component is present.
  function primaryAction(asset: AssetItem) {
    if (asset.type === 'stateMachine') {
      openAnimatorFor(asset.id);
      return;
    }
    if (asset.type === 'audio') {
      togglePreview(asset);
      return;
    }
    if (asset.type === 'prefab') {
      if (sceneId) void addPrefabToScene(asset);
      return;
    }
    assignAssetToSelection(asset);
  }

  /** One-line summary of what double-click does for this asset — the card's
   * native `title`, since every card getting a full Tooltip would be one
   * mount per card in a grid that can hold hundreds of assets. */
  function primaryActionHint(asset: AssetItem): string {
    switch (asset.type) {
      case 'stateMachine':
        return 'Double-click to edit in the Animator';
      case 'audio':
        return 'Double-click to play/stop the preview';
      case 'prefab':
        return sceneId ? 'Double-click to add to the current scene' : 'Open a scene, then double-click to add an instance';
      default:
        return 'Double-click to assign to the selected entity';
    }
  }

  /** Right-click menu (ASSETS-1): the same actions as the details row, laid
   * out per the Menu primitive so Delete/Copy id/Assign/Add to scene/Edit
   * are reachable without first selecting the card and hunting the row. */
  function buildContextMenuItems(asset: AssetItem): MenuItem[] {
    const items: MenuItem[] = [];
    if (asset.type === 'stateMachine') {
      items.push({ label: 'Edit state machine', icon: 'animator', onSelect: () => openAnimatorFor(asset.id) });
    } else if (asset.type === 'sprite' || asset.type === 'tile') {
      items.push({
        label: 'Slice…',
        icon: 'grid',
        onSelect: () => {
          setSelectedAssetId(asset.id);
          setSliceDialog(true);
        },
      });
    } else if (asset.type === 'audio') {
      const playing = playingAssetId === asset.id;
      items.push({
        label: playing ? 'Stop preview' : 'Play preview',
        icon: playing ? 'stop' : 'play',
        onSelect: () => togglePreview(asset),
      });
    }
    if (asset.type === 'prefab') {
      items.push({
        label: 'Add to scene',
        icon: 'plus',
        disabled: !sceneId,
        disabledReason: sceneId ? undefined : 'Open a scene first',
        onSelect: () => void addPrefabToScene(asset),
      });
    }
    if (asset.type !== 'stateMachine' && asset.type !== 'prefab') {
      const target = assignTarget(asset, selectedEntity);
      items.push({
        label: 'Assign to selection',
        icon: 'check',
        disabled: !target,
        disabledReason: target
          ? undefined
          : asset.type === 'audio'
            ? 'Select an entity with an AudioSource to assign'
            : 'Select an entity with a SpriteRenderer to assign',
        onSelect: () => assignAssetToSelection(asset),
      });
    }
    items.push({ separator: true });
    items.push({
      label: 'Copy id',
      icon: 'copy',
      onSelect: () => {
        void navigator.clipboard.writeText(asset.id);
        log('info', 'editor', `Copied asset id ${asset.id}`);
      },
    });
    items.push({ separator: true });
    items.push({ label: 'Delete…', icon: 'trash', danger: true, onSelect: () => setDeletingAsset(asset) });
    return items;
  }

  /** Group skip reasons for the summary line: "unsupported type ×2, missing (...)" reads at a glance instead of one entry per file. */
  function summarizeSkipReasons(failed: { name: string; reason: string }[]): string {
    const counts = new Map<string, number>();
    for (const f of failed) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
    return [...counts.entries()].map(([reason, count]) => (count > 1 ? `${reason} ×${count}` : reason)).join(', ');
  }

  /** The whole FileList (however it was gathered — file picker or a drag-drop, folders already flattened) goes through ONE importAssets call: one atomic undo/journal entry, one collision-safe naming pass. */
  async function importFiles(files: Iterable<File>) {
    if (!projectPath) return;
    const fileList = Array.from(files);
    if (fileList.length === 0) return;
    setImporting(true);
    setImportErrors([]);
    let imported = 0;
    const failed: { name: string; reason: string }[] = [];
    try {
      const okFiles: File[] = [];
      for (const file of fileList) {
        const ext = extensionOf(file.name);
        if (!IMPORT_EXTENSIONS.includes(ext)) {
          // ASSETS-8: lead with the problem, not the full capability list —
          // that list already lives in the Import button's tooltip.
          const reason = unsupportedExtensionReason(file.name);
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
        okFiles.push(file);
      }

      if (okFiles.length > 0) {
        try {
          const payload = await Promise.all(
            okFiles.map(async (file) => ({ filename: file.name, dataBase64: await fileToBase64(file) })),
          );
          const result = await apiImportAssets(projectPath, payload);
          if (result.success) {
            const data = result.data as {
              imported: { path: string; assetId: string; name: string; type: string }[];
              skipped: { path: string; code: string; message: string }[];
            } | null;
            imported = data?.imported.length ?? 0;
            for (const item of data?.imported ?? []) {
              log('info', 'editor', `Imported "${item.name}" (${item.type})`);
            }
            for (const item of data?.skipped ?? []) {
              const reason = item.message || item.code;
              log('warn', 'editor', `Skipped "${item.path}": ${reason}`);
              failed.push({ name: item.path, reason });
            }
          } else {
            const reason = result.errors.map((e) => e.message).join('; ') || 'import failed';
            for (const err of result.errors) log('error', 'command', `importAssets: ${err.message}`);
            for (const file of okFiles) failed.push({ name: file.name, reason });
          }
        } catch (err) {
          const reason = (err as Error).message;
          log('error', 'editor', `Import failed: ${reason}`);
          for (const file of okFiles) failed.push({ name: file.name, reason });
        }
      }

      // Summary toast: one line covering the whole drop/pick, however many
      // files it contained — a partial failure reads at a glance instead of
      // scrolling per-file console history.
      const summary = `Imported ${imported}, skipped ${failed.length}${
        failed.length > 0 ? ` (${summarizeSkipReasons(failed)})` : ''
      }`;
      log(failed.length > 0 ? 'warn' : 'info', 'editor', summary);
    } finally {
      setImporting(false);
      setImportErrors(failed);
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
        <Tooltip content={playing ? 'Stop preview' : 'Play preview'}>
          <button
            className={`audio-preview-btn${playing ? ' playing' : ''}`}
            aria-label={playing ? `Stop ${asset.name}` : `Play ${asset.name}`}
            onClick={(e) => {
              e.stopPropagation();
              togglePreview(asset);
            }}
          >
            <Icon name={playing ? 'stop' : 'play'} size={13} />
          </button>
        </Tooltip>
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
      // Unresolved (no thumb-worthy first frame yet, or resolution failed):
      // a flat glyph tile, not a near-invisible icon on the checkerboard
      // (ASSETS-10 — the checkerboard implies "transparent image", which this
      // isn't).
      return (
        <span className="asset-thumb-glyph">
          <Icon name="play" size={22} />
        </span>
      );
    }
    if (asset.type === 'prefab') {
      return (
        <span className="asset-thumb-glyph">
          <Icon name="prefab" size={22} />
        </span>
      );
    }
    if (asset.type === 'stateMachine') {
      return (
        <span className="asset-thumb-glyph">
          <Icon name="animator" size={22} />
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
        // webkitGetAsEntry() must be read synchronously off the drop event —
        // it (and the DataTransfer it comes from) isn't guaranteed valid once
        // this handler returns. The resulting entries stay walkable async.
        const entries = entriesFromDataTransferItems(e.dataTransfer.items);
        if (entries.length > 0) {
          void collectDropEntries(entries).then((files) => importFiles(files));
        } else {
          void importFiles(Array.from(e.dataTransfer.files));
        }
      }}
      onKeyDown={(e) => {
        // Cmd/Ctrl+F while the panel is focused jumps to the filter box
        // (ASSETS-4) — cheap since it's just a ref focus, no global listener.
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          filterInputRef.current?.focus();
        }
      }}
    >
      <div className="panel-toolbar">
        <Button size="sm" icon="plus" onClick={() => setSpriteDialog(true)}>
          Sprite
        </Button>
        <Button size="sm" icon="plus" onClick={() => setTileDialog(true)}>
          Tile
        </Button>
        <Button size="sm" icon="plus" onClick={() => setSoundDialog(true)}>
          Sound
        </Button>
        <Button size="sm" icon="plus" onClick={() => setSmDialog(true)}>
          State machine
        </Button>
        <span className="divider" style={{ width: 1, height: 16, background: 'var(--border-strong)' }} />
        <Tooltip content="Import images, audio, or fonts">
          <Button size="sm" icon="upload" disabled={importing} onClick={() => fileInputRef.current?.click()}>
            {importing ? 'Importing…' : 'Import…'}
          </Button>
        </Tooltip>
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

      {assets.length > 0 && (
        <div className="assets-filter-row">
          <Icon name="search" size={11} />
          <input
            ref={filterInputRef}
            className="input assets-filter-input"
            placeholder="Filter by name or type…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filterQuery !== '') {
                e.stopPropagation();
                setFilterQuery('');
              }
            }}
            aria-label="Filter assets by name or type"
          />
          {filterQuery !== '' && (
            <button className="assets-filter-clear" aria-label="Clear filter" onClick={() => setFilterQuery('')}>
              <Icon name="cross" size={9} />
            </button>
          )}
        </div>
      )}

      {importErrors.length > 0 && (
        <div className="export-errors export-errors-dismissible" role="alert" style={{ margin: '8px 10px 0' }}>
          <button
            className="export-errors-dismiss"
            aria-label="Dismiss import errors"
            onClick={() => setImportErrors([])}
          >
            <Icon name="cross" size={9} />
          </button>
          {importErrors.map((f, i) => (
            <p key={i}>
              {f.name}: {f.reason}
            </p>
          ))}
        </div>
      )}

      <div className="panel-body">
        {assets.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="image" size={16} />
            </span>
            <span>No assets yet</span>
            <span className="hint">
              Create a procedural placeholder sprite or tile above (agents can generate these too), or bring
              your own images, sounds, and fonts with Import. You can also drop files onto this panel.
            </span>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="search" size={16} />
            </span>
            <span>No assets match "{filterQuery}"</span>
            <Button size="sm" onClick={() => setFilterQuery('')}>
              Clear filter
            </Button>
          </div>
        ) : (
          <div className="asset-grid" ref={gridRef}>
            {filteredAssets.map((asset, index) => {
              const isSheet = asset.type === 'sprite' || asset.type === 'tile';
              const frameCount = isSheet ? getSheetFrames(asset).length : 0;
              const prefabEntityCount = asset.type === 'prefab' ? (asset.prefab?.entityCount ?? null) : null;
              // Roving tabindex (L-047): the selected card is the grid's one
              // tab stop (the first card when nothing is selected); arrows
              // move focus between cards.
              const tabbableId =
                selectedAssetId && filteredAssets.some((a) => a.id === selectedAssetId)
                  ? selectedAssetId
                  : filteredAssets[0]?.id;
              return (
                <div
                  key={asset.id}
                  ref={(el) => {
                    if (el) cardRefs.current.set(asset.id, el);
                    else cardRefs.current.delete(asset.id);
                  }}
                  className={`asset-card${selectedAssetId === asset.id ? ' selected' : ''}`}
                  role="button"
                  aria-pressed={selectedAssetId === asset.id}
                  tabIndex={asset.id === tabbableId ? 0 : -1}
                  onClick={() => setSelectedAssetId(asset.id === selectedAssetId ? null : asset.id)}
                  onDoubleClick={() => {
                    // Always end up selected (never the select/deselect
                    // flicker toggling twice would otherwise produce), then
                    // run the type-appropriate primary action.
                    setSelectedAssetId(asset.id);
                    primaryAction(asset);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelectedAssetId(asset.id);
                    setContextMenu({ asset, x: e.clientX, y: e.clientY, returnFocus: e.currentTarget });
                  }}
                  onKeyDown={(e) => {
                    if (onCardNavKey(e, index)) return;
                    if (isActivationKey(e.key)) {
                      e.preventDefault();
                      setSelectedAssetId(asset.id === selectedAssetId ? null : asset.id);
                    }
                  }}
                >
                  <div className="asset-thumb">{preview(asset)}</div>
                  {/* Non-interactive span — the name (truncated by CSS) plus
                      the double-click hint (ASSETS-5), both fine as a native
                      title here (Gate D only bars titles on interactive
                      elements; the card itself carries no title). */}
                  <span className="asset-name" title={`${asset.name}: ${primaryActionHint(asset)}`}>
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
                  <span className="asset-card-actions" onClick={(e) => e.stopPropagation()}>
                    <IconButton
                      bare
                      className="icon-btn danger"
                      icon="trash"
                      iconSize={11}
                      label="Delete"
                      onClick={() => setDeletingAsset(asset)}
                    />
                  </span>
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(selectedAsset.id);
                log('info', 'editor', `Copied asset id ${selectedAsset.id}`);
              }}
            >
              <Icon name="copy" size={11} /> Copy id
            </Button>
            <span style={{ flex: 1 }} />
            {(selectedAsset.type === 'sprite' || selectedAsset.type === 'tile') && (
              <Button size="sm" onClick={() => setSliceDialog(true)}>
                <Icon name="grid" size={11} /> Slice…
              </Button>
            )}
            {selectedAsset.type === 'prefab' ? (
              <>
                <Tooltip content={sceneId ? `Instantiate into "${scene?.name}" at the viewport center` : 'Open a scene first'}>
                  <Button size="sm" disabled={!sceneId} onClick={() => void addPrefabToScene(selectedAsset)}>
                    <Icon name="plus" size={11} /> Add to scene
                  </Button>
                </Tooltip>
                <Button
                  size="sm"
                  disabled={pendingSyncAssetId === selectedAsset.id}
                  onClick={() => void openSyncConfirm(selectedAsset)}
                >
                  <Icon name="prefab" size={11} />{' '}
                  {pendingSyncAssetId === selectedAsset.id ? 'Syncing…' : 'Sync instances'}
                </Button>
              </>
            ) : selectedAsset.type === 'stateMachine' ? (
              <Button size="sm" onClick={() => openAnimatorFor(selectedAsset.id)}>
                <Icon name="animator" size={11} /> Edit state machine
              </Button>
            ) : (
              <Tooltip
                content={
                  assignment
                    ? `Set ${selectedEntity?.name}'s ${assignment.property}`
                    : selectedAsset.type === 'audio'
                      ? 'Select an entity with an AudioSource to assign'
                      : 'Select an entity with a SpriteRenderer to assign'
                }
              >
                <Button size="sm" disabled={!assignment} onClick={() => assignAssetToSelection(selectedAsset)}>
                  Assign to {selectedEntity ? `"${selectedEntity.name}"` : 'selection'}
                </Button>
              </Tooltip>
            )}
          </div>

          {projectPath &&
            (selectedAsset.type === 'sprite' || selectedAsset.type === 'tile') &&
            getSheetFrames(selectedAsset).length > 0 && <FrameGrid projectPath={projectPath} asset={selectedAsset} />}

          {selectedAsset.type === 'font' &&
            (loadedFontNames.has(selectedAsset.name) ? (
              <span className="font-sample" style={{ fontFamily: `"${selectedAsset.name}"` }}>
                Aa Bb 0123 · Hearth
              </span>
            ) : (
              <span style={{ color: 'var(--ink-faint)', fontSize: 'var(--text-sm)' }}>Loading font preview…</span>
            ))}
        </div>
      )}

      {dropping && (
        <div className="drop-target" aria-hidden="true">
          <span>Drop images, audio, or fonts to import</span>
        </div>
      )}

      {/* Create sprite */}
      <Modal
        open={spriteDialog}
        title="Create procedural sprite"
        onClose={() => {
          setSpriteDialog(false);
          setSpError(null);
        }}
      >
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label">Name</label>
            <input
              className={`input${spError ? ' invalid' : ''}`}
              value={spName}
              onChange={(e) => {
                setSpName(e.target.value);
                if (spError) setSpError(null);
              }}
              autoFocus
              placeholder="coin"
            />
            {spError && <span className="field-error">{spError}</span>}
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
          <Button onClick={() => setSpriteDialog(false)}>Cancel</Button>
          <Button variant="primary" disabled={!spName.trim()} onClick={() => void createSprite()}>
            Create sprite
          </Button>
        </div>
      </Modal>

      {/* Create tile */}
      <Modal
        open={tileDialog}
        title="Create procedural tile"
        onClose={() => {
          setTileDialog(false);
          setTError(null);
        }}
      >
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label">Name</label>
            <input
              className={`input${tError ? ' invalid' : ''}`}
              value={tName}
              onChange={(e) => {
                setTName(e.target.value);
                if (tError) setTError(null);
              }}
              autoFocus
              placeholder="grass"
            />
            {tError && <span className="field-error">{tError}</span>}
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
          <Button onClick={() => setTileDialog(false)}>Cancel</Button>
          <Button variant="primary" disabled={!tName.trim()} onClick={() => void createTile()}>
            Create tile
          </Button>
        </div>
      </Modal>

      {sliceDialog && (
        <Suspense fallback={null}>
          <SliceDialog open={sliceDialog} asset={selectedAsset} onClose={() => setSliceDialog(false)} />
        </Suspense>
      )}

      {/* Create state machine — the shared dialog (T9-U8 unification) */}
      <CreateStateMachineDialog open={smDialog} onClose={() => setSmDialog(false)} />

      {/* Create sound (L-049): name + preset over the engine's real preset list */}
      <Modal
        open={soundDialog}
        title="Create procedural sound"
        onClose={() => {
          setSoundDialog(false);
          setSndError(null);
        }}
      >
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label" htmlFor="create-sound-name">
              Name
            </label>
            <input
              id="create-sound-name"
              className={`input${sndError ? ' invalid' : ''}`}
              value={sndName}
              onChange={(e) => {
                setSndName(e.target.value);
                if (sndError) setSndError(null);
              }}
              autoFocus
              placeholder="coin-pickup"
            />
            {sndError && <span className="field-error">{sndError}</span>}
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor="create-sound-preset">
              Preset
            </label>
            <select
              id="create-sound-preset"
              className="select"
              value={sndPreset}
              onChange={(e) => setSndPreset(e.target.value)}
            >
              {SOUND_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <p className="animator-empty">
            Generates a deterministic WAV: the same preset always sounds the same. Preview it from the new
            card's play button.
          </p>
        </div>
        <div className="modal-actions">
          <Button
            onClick={() => {
              setSoundDialog(false);
              setSndError(null);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={!sndName.trim()} onClick={() => void createSound()}>
            Create sound
          </Button>
        </div>
      </Modal>

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

      {/* Delete (ASSETS-1) */}
      <ConfirmDialog
        open={deletingAsset !== null}
        title={`Delete "${deletingAsset?.name ?? ''}"?`}
        body="Its file moves to the project trash and every reference to it stops resolving. This shows up in your undo history, so Ctrl/Cmd+Z brings it back."
        confirmLabel="Delete asset"
        danger
        onCancel={() => setDeletingAsset(null)}
        onConfirm={() => void confirmDelete()}
      />

      {/* removeAsset's own referenced-by message, shown verbatim rather than
          summarized away — the command-side messaging is already excellent. */}
      <Modal
        open={deleteError !== null}
        title={`Can't delete "${deleteError?.name ?? ''}"`}
        onClose={() => setDeleteError(null)}
      >
        <div className="modal-body">
          <p>{deleteError?.message}</p>
        </div>
        <div className="modal-actions">
          <Button variant="primary" onClick={() => setDeleteError(null)} autoFocus>
            OK
          </Button>
        </div>
      </Modal>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenuItems(contextMenu.asset)}
          label={`${contextMenu.asset.name} actions`}
          onClose={() => setContextMenu(null)}
          returnFocus={contextMenu.returnFocus}
        />
      )}
    </div>
  );
}
