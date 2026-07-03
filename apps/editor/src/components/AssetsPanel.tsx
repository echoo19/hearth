import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import { apiImportAsset, fileUrl } from '../api';
import type { AssetItem } from '../types';
import { Icon, Modal } from './ui';

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
const IMPORT_EXTENSIONS = [...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS];
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

export function AssetsPanel() {
  const projectPath = useEditor((s) => s.projectPath);
  const assets = useEditor((s) => s.assets);
  const scene = useEditor((s) => s.scene);
  const sceneId = useEditor((s) => s.sceneId);
  const selection = useEditor((s) => s.selection);
  const exec = useEditor((s) => s.exec);
  const refresh = useEditor((s) => s.refresh);
  const log = useEditor((s) => s.log);

  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [spriteDialog, setSpriteDialog] = useState(false);
  const [tileDialog, setTileDialog] = useState(false);

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

  async function importFiles(files: Iterable<File>) {
    if (!projectPath) return;
    setImporting(true);
    let imported = 0;
    try {
      for (const file of files) {
        const ext = extensionOf(file.name);
        if (!IMPORT_EXTENSIONS.includes(ext)) {
          log(
            'warn',
            'editor',
            `Skipped "${file.name}": images (${IMAGE_EXTENSIONS.join(', ')}) and audio (${AUDIO_EXTENSIONS.join(', ')}) can be imported.`,
          );
          continue;
        }
        if (file.size > MAX_IMPORT_BYTES) {
          log('warn', 'editor', `Skipped "${file.name}": larger than the 25 MB import limit.`);
          continue;
        }
        try {
          const result = await apiImportAsset(projectPath, file.name, await fileToBase64(file));
          if (result.success) {
            imported++;
            const asset = (result.data as { asset?: AssetItem } | null)?.asset;
            log('info', 'editor', `Imported "${asset?.name ?? file.name}"${asset ? ` → ${asset.path}` : ''}`);
          } else {
            for (const err of result.errors) log('error', 'command', `importAsset: ${err.message}`);
          }
        } catch (err) {
          log('error', 'editor', `Import of "${file.name}" failed: ${(err as Error).message}`);
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
    const icon = asset.type === 'animation' ? 'play' : 'entity';
    return (
      <span style={{ color: 'var(--ink-faint)' }}>
        <Icon name={icon} size={20} />
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
          title="Import images (png, jpg, svg, webp, gif) and audio (wav, mp3, ogg). You can also drop files onto this panel."
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
              generate via createSpriteAsset), or bring your own images and sounds with Import… — dropping
              files onto this panel works too.
            </span>
          </div>
        ) : (
          <div className="asset-grid">
            {assets.map((asset) => (
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
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedAsset && (
        <div className="asset-details">
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
        </div>
      )}

      {dropping && (
        <div className="drop-target" aria-hidden="true">
          <span>Drop images or audio to import</span>
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
    </div>
  );
}
