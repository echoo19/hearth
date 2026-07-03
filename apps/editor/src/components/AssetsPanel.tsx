import React, { useMemo, useState } from 'react';
import { useEditor } from '../store';
import { fileUrl } from '../api';
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

export function AssetsPanel() {
  const projectPath = useEditor((s) => s.projectPath);
  const assets = useEditor((s) => s.assets);
  const scene = useEditor((s) => s.scene);
  const sceneId = useEditor((s) => s.sceneId);
  const selection = useEditor((s) => s.selection);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);

  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [spriteDialog, setSpriteDialog] = useState(false);
  const [tileDialog, setTileDialog] = useState(false);
  const [importPath, setImportPath] = useState('');

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

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  );
  const selectedEntity = useMemo(
    () => scene?.entities.find((e) => e.id === selection),
    [scene, selection],
  );
  const canAssign =
    selectedAsset !== null &&
    (selectedAsset.type === 'sprite' || selectedAsset.type === 'tile') &&
    selectedEntity?.components.SpriteRenderer !== undefined;

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

  async function importAsset() {
    const sourcePath = importPath.trim();
    if (!sourcePath) return;
    const result = await exec('importAsset', { sourcePath });
    if (result.success) setImportPath('');
  }

  function preview(asset: AssetItem): React.ReactNode {
    if (projectPath && (asset.type === 'sprite' || asset.type === 'tile')) {
      return <img src={fileUrl(projectPath, asset.path)} alt="" />;
    }
    const icon = asset.type === 'audio' ? 'audio' : asset.type === 'animation' ? 'play' : 'entity';
    return (
      <span style={{ color: 'var(--ink-faint)' }}>
        <Icon name={icon} size={20} />
      </span>
    );
  }

  return (
    <>
      <div className="panel-toolbar">
        <button className="btn btn-sm" onClick={() => setSpriteDialog(true)}>
          <Icon name="plus" /> Sprite
        </button>
        <button className="btn btn-sm" onClick={() => setTileDialog(true)}>
          <Icon name="plus" /> Tile
        </button>
        <span className="divider" style={{ width: 1, height: 16, background: 'var(--border-strong)' }} />
        <input
          className="input mono"
          style={{ width: 280 }}
          placeholder="Import by path: /absolute/or/project-relative/file.png"
          value={importPath}
          onChange={(e) => setImportPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void importAsset();
          }}
        />
        <button className="btn btn-sm" disabled={!importPath.trim()} onClick={() => void importAsset()}>
          Import
        </button>
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
              generate via createSpriteAsset), or import an existing image by path.
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
                ? `Set ${selectedEntity?.name}'s SpriteRenderer.assetId`
                : 'Select an entity with a SpriteRenderer to assign'
            }
            onClick={() =>
              selectedEntity &&
              sceneId &&
              void exec('setComponentProperty', {
                scene: sceneId,
                entity: selectedEntity.id,
                property: 'SpriteRenderer.assetId',
                value: selectedAsset.id,
              })
            }
          >
            Assign to {selectedEntity ? `“${selectedEntity.name}”` : 'selection'}
          </button>
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
    </>
  );
}
