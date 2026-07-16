/**
 * Tilemap paint tool UI: the small toolbar chip that toggles paint mode, and
 * (while active) the palette overlay — one swatch per tileAssets char plus
 * an eraser, and a "Resize…" affordance. Actual pointer-to-cell painting
 * (click/drag → paintTiles, shift-drag → fillTilemapRect) lives in
 * SceneView.tsx alongside its other canvas drag interactions (entity drag,
 * vertex drag, pan); the pure cell/stroke math both share lives in
 * ../tilemapPaint.ts. This component only renders the chip + palette + the
 * tiny resize modal and reports intent back via props.
 */
import React, { useEffect, useState } from 'react';
import type { TilemapComponent } from '@hearth/core';
import { fileUrl } from '../api';
import type { AssetItem } from '../types';
import { Icon, Modal } from './ui';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';

/** Reserved chars: always empty, never assignable to an asset. */
export const ERASER_CHAR = '.';

export function TilemapPainter({
  tilemap,
  assets,
  projectPath,
  paintMode,
  onTogglePaintMode,
  selectedChar,
  onSelectChar,
  onResize,
}: {
  tilemap: TilemapComponent;
  assets: AssetItem[];
  projectPath: string | null;
  paintMode: boolean;
  onTogglePaintMode: () => void;
  selectedChar: string;
  onSelectChar: (char: string) => void;
  onResize: (width: number, height: number) => void;
}) {
  const [resizeOpen, setResizeOpen] = useState(false);
  const currentCols = tilemap.grid[0]?.length ?? 0;
  const currentRows = tilemap.grid.length;
  const [width, setWidth] = useState(currentCols || 8);
  const [height, setHeight] = useState(currentRows || 8);

  // Reseed the draft size from the live grid every time the dialog opens, so
  // reopening it after a resize (or an undo) doesn't show stale numbers.
  useEffect(() => {
    if (resizeOpen) {
      setWidth(currentCols || 8);
      setHeight(currentRows || 8);
    }
  }, [resizeOpen, currentCols, currentRows]);

  const chars = Object.entries(tilemap.tileAssets);
  const widthInvalid = !Number.isInteger(width) || width < 1 || width > 1024;
  const heightInvalid = !Number.isInteger(height) || height < 1 || height > 1024;

  return (
    <>
      <div className="tilemap-paint-toggle">
        {paintMode ? (
          <Button variant="primary" size="sm" onClick={onTogglePaintMode}>
            Done painting
          </Button>
        ) : (
          <Tooltip content="Paint this tilemap's cells in the scene">
            <Button size="sm" onClick={onTogglePaintMode}>
              <Icon name="pencil" size={11} /> Paint tiles
            </Button>
          </Tooltip>
        )}
      </div>

      {paintMode && (
        <div className="tilemap-palette">
          <div className="tilemap-palette-swatches">
            <Tooltip content="Erase a cell">
              <button
                type="button"
                className={`tilemap-swatch${selectedChar === ERASER_CHAR ? ' selected' : ''}`}
                onClick={() => onSelectChar(ERASER_CHAR)}
              >
                <span className="tilemap-swatch-thumb tilemap-swatch-eraser">
                  <Icon name="cross" size={12} />
                </span>
                <span className="tilemap-swatch-label">eraser</span>
              </button>
            </Tooltip>
            {chars.map(([char, assetId]) => {
              const asset = assets.find((a) => a.id === assetId);
              return (
                <Tooltip key={char} content={asset ? `"${char}" → ${asset.name}` : `"${char}" (mapped asset not found)`}>
                  <button
                    type="button"
                    className={`tilemap-swatch${selectedChar === char ? ' selected' : ''}`}
                    onClick={() => onSelectChar(char)}
                  >
                    <span className="tilemap-swatch-thumb checkerboard-bg">
                      {asset && projectPath ? (
                        <img src={fileUrl(projectPath, asset.path)} alt="" />
                      ) : (
                        <span className="tilemap-swatch-fallback">{char}</span>
                      )}
                    </span>
                    <span className="tilemap-swatch-label mono">{char}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
          {chars.length === 0 && (
            <div className="tilemap-palette-hint">
              No tile chars mapped yet. Add some in the Inspector's Tilemap fields.
            </div>
          )}
          <Button size="sm" onClick={() => setResizeOpen(true)}>
            <Icon name="grid" size={11} /> Resize…
          </Button>
          <div className="tilemap-palette-hint">shift-drag to fill a rectangle</div>
        </div>
      )}

      <Modal open={resizeOpen} title="Resize tilemap" onClose={() => setResizeOpen(false)}>
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label">Width × height (cells)</label>
            <div className="vec2-pair">
              <input
                className={`input${widthInvalid ? ' invalid' : ''}`}
                type="number"
                min={1}
                max={1024}
                autoFocus
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
              />
              <input
                className={`input${heightInvalid ? ' invalid' : ''}`}
                type="number"
                min={1}
                max={1024}
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
              />
            </div>
          </div>
          <p style={{ color: 'var(--ink-faint)', fontSize: 'var(--text-sm)' }}>
            Growing pads new cells/rows as empty; shrinking crops from the right and bottom edges.
          </p>
        </div>
        <div className="modal-actions">
          <Button onClick={() => setResizeOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={widthInvalid || heightInvalid}
            onClick={() => {
              onResize(width, height);
              setResizeOpen(false);
            }}
          >
            Resize
          </Button>
        </div>
      </Modal>
    </>
  );
}
