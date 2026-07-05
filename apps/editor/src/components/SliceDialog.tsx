/**
 * "Slice…" dialog: turns a sprite/tile sheet into named frames via the
 * sliceSpritesheet command. The live grid overlay mirrors the command's own
 * row-major columns/rows formula exactly (packages/core/src/commands/
 * assetCommands.ts), so what's previewed here is what gets written to
 * asset.metadata.frames.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { slugify } from '@hearth/core';
import { useEditor } from '../store';
import { fileUrl } from '../api';
import type { AssetItem } from '../types';
import { Modal } from './ui';
import { readSheetGrid } from '../assetPreview';

const MAX_PREVIEW_PX = 360;

/** Above this many frames the per-cell overlay is skipped (a 2048×2048 atlas
 * at 8×8 would mean ~65k SVG rects rebuilt per keystroke) — the "N frames
 * (C × R)" readout stays exact and the outer grid bounds are still drawn.
 * Typical character sheets (≤ a few hundred frames) remain fully previewed. */
const MAX_OVERLAY_CELLS = 512;

interface GridComputation {
  columns: number;
  rows: number;
  frameCount: number;
  /** Per-frame cell origins; left empty when frameCount > MAX_OVERLAY_CELLS. */
  cells: { x: number; y: number }[];
  cellsOmitted: boolean;
  error: string | null;
}

function computeGrid(
  imgWidth: number,
  imgHeight: number,
  frameWidth: number,
  frameHeight: number,
  margin: number,
  spacing: number,
): GridComputation {
  const empty = (error: string): GridComputation => ({
    columns: 0,
    rows: 0,
    frameCount: 0,
    cells: [],
    cellsOmitted: false,
    error,
  });
  if (!Number.isInteger(frameWidth) || frameWidth < 1) {
    return empty('Frame width must be a whole number of at least 1px.');
  }
  if (!Number.isInteger(frameHeight) || frameHeight < 1) {
    return empty('Frame height must be a whole number of at least 1px.');
  }
  if (!Number.isInteger(margin) || margin < 0) {
    return empty('Margin must be a whole number, 0 or more.');
  }
  if (!Number.isInteger(spacing) || spacing < 0) {
    return empty('Spacing must be a whole number, 0 or more.');
  }

  const columns = Math.floor((imgWidth - 2 * margin + spacing) / (frameWidth + spacing));
  const rows = Math.floor((imgHeight - 2 * margin + spacing) / (frameHeight + spacing));
  if (columns < 1 || rows < 1) {
    // Same wording as the command's own INVALID_INPUT error (assetCommands.ts)
    // so the inline message and a server-side rejection read identically.
    return empty(
      `Frame size ${frameWidth}×${frameHeight} does not fit in image ${imgWidth}×${imgHeight} with margin ${margin} and spacing ${spacing}`,
    );
  }
  const frameCount = columns * rows;
  const cellsOmitted = frameCount > MAX_OVERLAY_CELLS;
  const cells: { x: number; y: number }[] = [];
  if (!cellsOmitted) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        cells.push({ x: margin + col * (frameWidth + spacing), y: margin + row * (frameHeight + spacing) });
      }
    }
  }
  return { columns, rows, frameCount, cells, cellsOmitted, error: null };
}

type ImageProbe = 'loading' | 'error' | { width: number; height: number };

export function SliceDialog({
  open,
  asset,
  onClose,
}: {
  open: boolean;
  asset: AssetItem | null;
  onClose: () => void;
}) {
  const projectPath = useEditor((s) => s.projectPath);
  const exec = useEditor((s) => s.exec);

  const [frameWidth, setFrameWidth] = useState(32);
  const [frameHeight, setFrameHeight] = useState(32);
  const [margin, setMargin] = useState(0);
  const [spacing, setSpacing] = useState(0);
  const [namePrefix, setNamePrefix] = useState('');
  const [imgProbe, setImgProbe] = useState<ImageProbe>('loading');
  const [submitting, setSubmitting] = useState(false);
  const [confirmErrors, setConfirmErrors] = useState<string[]>([]);

  // Reset per-asset state each time the dialog opens: prefill from an
  // existing grid when re-slicing an already-sliced sheet, sane defaults
  // otherwise. imgProbe always restarts at 'loading' so a stale sheet's
  // dimensions never leak onto a newly opened asset.
  useEffect(() => {
    if (!open || !asset) return;
    const existing = readSheetGrid(asset);
    setFrameWidth(existing?.frameWidth ?? 32);
    setFrameHeight(existing?.frameHeight ?? 32);
    setMargin(existing?.margin ?? 0);
    setSpacing(existing?.spacing ?? 0);
    setNamePrefix('');
    setImgProbe('loading');
    setSubmitting(false);
    setConfirmErrors([]);
  }, [open, asset]);

  const imageUrl = projectPath && asset ? fileUrl(projectPath, asset.path) : '';
  const dimensionsKnown = typeof imgProbe === 'object';
  const fieldsDisabled = imgProbe === 'error';

  const grid = useMemo(() => {
    if (typeof imgProbe !== 'object') return null;
    return computeGrid(imgProbe.width, imgProbe.height, frameWidth, frameHeight, margin, spacing);
  }, [imgProbe, frameWidth, frameHeight, margin, spacing]);

  const display = useMemo(() => {
    if (typeof imgProbe !== 'object') return null;
    const maxDim = Math.max(imgProbe.width, imgProbe.height);
    const scale =
      maxDim <= MAX_PREVIEW_PX ? Math.max(1, Math.floor(MAX_PREVIEW_PX / maxDim)) : MAX_PREVIEW_PX / maxDim;
    return { width: Math.round(imgProbe.width * scale), height: Math.round(imgProbe.height * scale), scale };
  }, [imgProbe]);

  const canConfirm = dimensionsKnown && grid !== null && grid.error === null && !submitting;

  const frameWidthInvalid = !Number.isInteger(frameWidth) || frameWidth < 1;
  const frameHeightInvalid = !Number.isInteger(frameHeight) || frameHeight < 1;
  const marginInvalid = !Number.isInteger(margin) || margin < 0;
  const spacingInvalid = !Number.isInteger(spacing) || spacing < 0;

  async function handleConfirm() {
    if (!asset || !canConfirm) return;
    setSubmitting(true);
    setConfirmErrors([]);
    const trimmedPrefix = namePrefix.trim();
    const result = await exec('sliceSpritesheet', {
      asset: asset.id,
      frameWidth,
      frameHeight,
      margin,
      spacing,
      ...(trimmedPrefix ? { namePrefix: trimmedPrefix } : {}),
    });
    setSubmitting(false);
    if (result.success) {
      onClose();
    } else {
      setConfirmErrors(result.errors.map((e) => e.message));
    }
  }

  if (!asset) return null;

  return (
    <Modal open={open} title={`Slice “${asset.name}”`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) void handleConfirm();
        }}
      >
        <div className="modal-body">
          <div className="slice-preview">
            {imgProbe === 'loading' && <span className="slice-preview-status">Loading image…</span>}
            {imgProbe === 'error' && (
              <span className="field-error">
                Can&rsquo;t determine this image&rsquo;s pixel dimensions, so it can&rsquo;t be sliced.
              </span>
            )}
            <div
              className="slice-preview-canvas checkerboard-bg"
              style={{
                width: display?.width ?? 0,
                height: display?.height ?? 0,
                display: dimensionsKnown ? 'block' : 'none',
              }}
            >
              <img
                src={imageUrl}
                alt=""
                style={{
                  width: display?.width,
                  height: display?.height,
                  imageRendering: display && display.scale >= 1 ? 'pixelated' : 'auto',
                }}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    setImgProbe({ width: img.naturalWidth, height: img.naturalHeight });
                  } else {
                    setImgProbe('error');
                  }
                }}
                onError={() => setImgProbe('error')}
              />
              {grid && !grid.error && display && (
                <svg
                  className="slice-grid-overlay"
                  width={display.width}
                  height={display.height}
                  viewBox={`0 0 ${display.width} ${display.height}`}
                  aria-hidden="true"
                >
                  {grid.cellsOmitted ? (
                    <rect
                      className="slice-grid-cell"
                      x={margin * display.scale}
                      y={margin * display.scale}
                      width={(grid.columns * frameWidth + (grid.columns - 1) * spacing) * display.scale}
                      height={(grid.rows * frameHeight + (grid.rows - 1) * spacing) * display.scale}
                    />
                  ) : (
                    grid.cells.map((cell, i) => (
                      <rect
                        key={i}
                        className="slice-grid-cell"
                        x={cell.x * display.scale}
                        y={cell.y * display.scale}
                        width={frameWidth * display.scale}
                        height={frameHeight * display.scale}
                      />
                    ))
                  )}
                </svg>
              )}
            </div>
          </div>

          {dimensionsKnown && grid && (
            <div className="slice-readout">
              {grid.error
                ? `Sheet is ${(imgProbe as { width: number }).width}×${(imgProbe as { height: number }).height}px`
                : `${grid.frameCount} frame${grid.frameCount === 1 ? '' : 's'} (${grid.columns} × ${grid.rows})`}
              {!grid.error && grid.cellsOmitted && (
                <span className="slice-readout-note"> — grid preview hidden above {MAX_OVERLAY_CELLS} frames</span>
              )}
            </div>
          )}
          {grid?.error && <div className="field-error">{grid.error}</div>}

          <div className="inspector-row">
            <label className="field-label">Frame size</label>
            <div className="vec2-pair">
              <input
                className={`input${frameWidthInvalid ? ' invalid' : ''}`}
                type="number"
                min={1}
                autoFocus
                disabled={fieldsDisabled}
                value={frameWidth}
                onChange={(e) => setFrameWidth(Number(e.target.value))}
              />
              <input
                className={`input${frameHeightInvalid ? ' invalid' : ''}`}
                type="number"
                min={1}
                disabled={fieldsDisabled}
                value={frameHeight}
                onChange={(e) => setFrameHeight(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="inspector-row">
            <label className="field-label">Margin / spacing</label>
            <div className="vec2-pair">
              <input
                className={`input${marginInvalid ? ' invalid' : ''}`}
                type="number"
                min={0}
                disabled={fieldsDisabled}
                value={margin}
                onChange={(e) => setMargin(Number(e.target.value))}
              />
              <input
                className={`input${spacingInvalid ? ' invalid' : ''}`}
                type="number"
                min={0}
                disabled={fieldsDisabled}
                value={spacing}
                onChange={(e) => setSpacing(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="form-field">
            <label className="field-label">Name prefix</label>
            <input
              className="input"
              disabled={fieldsDisabled}
              value={namePrefix}
              onChange={(e) => setNamePrefix(e.target.value)}
              placeholder={slugify(asset.name)}
            />
          </div>

          {confirmErrors.length > 0 && (
            <div className="export-errors" role="alert">
              {confirmErrors.map((message, i) => (
                <p key={i}>{message}</p>
              ))}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canConfirm}>
            {submitting ? 'Slicing…' : 'Slice'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
