/**
 * Scene view: an SVG rendering of the scene JSON with grid, pan/zoom,
 * click-select, and drag-to-move (drag release posts a moveEntity command).
 * This is deliberately not the game runtime — it draws the authored data.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { TilemapComponent } from '@hearth/core';
import { useEditor } from '../store';
import { fileUrl } from '../api';
import {
  edgeMidpoints,
  insertVertexOnEdge,
  polygonLocalToWorld,
  polygonWorldToLocal,
  removeVertex,
  roundPoints,
  type PolygonFrame,
} from '../polygonEditing';
import {
  addStrokeCell,
  clampRectToGrid,
  filterInBounds,
  isCellInBounds,
  normalizeRect,
  worldToCell,
  type Cell,
  type Rect,
  type TileCell,
} from '../tilemapPaint';
import { ERASER_CHAR, TilemapPainter } from './TilemapPainter';
import type { AssetItem, SceneEntity, Vec2 } from '../types';

interface ViewTransform {
  s: number; // scale: screen px per world px
  tx: number;
  ty: number;
}

interface DragState {
  entityId: string;
  pointerId: number;
  startScreen: Vec2;
  startLocal: Vec2;
  moved: boolean;
}

interface PanState {
  pointerId: number;
  start: Vec2;
  startView: ViewTransform;
}

interface VertexDragState {
  pointerId: number;
  index: number;
}

interface PaintStrokeState {
  pointerId: number;
  entityId: string;
  tileSize: number;
  /** Entity world position at stroke start (the paint tool doesn't support rotated/scaled tilemaps). */
  origin: Vec2;
  grid: string[];
  /** The palette char selected when the stroke began. */
  char: string;
  /** True when the stroke was started with shift held (rect-fill mode). */
  rectMode: boolean;
  startCell: Cell;
  /** Accumulated unique cells for a freehand stroke; unused in rect mode. */
  cells: TileCell[];
}

type PaintPreview = { rectMode: false; cells: TileCell[] } | { rectMode: true; rect: Rect };

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 12;

export function SceneView() {
  const projectPath = useEditor((s) => s.projectPath);
  const info = useEditor((s) => s.info);
  const scene = useEditor((s) => s.scene);
  const sceneId = useEditor((s) => s.sceneId);
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);
  const setSceneViewCenter = useEditor((s) => s.setSceneViewCenter);

  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewTransform>({ s: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Drag state lives in refs (pointer events can arrive before React flushes
  // state); dragPos is mirrored into state purely to re-render the ghost.
  const dragRef = useRef<DragState | null>(null);
  const dragPosRef = useRef<Vec2 | null>(null);
  const [dragPos, setDragPosState] = useState<Vec2 | null>(null);
  const panRef = useRef<PanState | null>(null);
  const fittedScene = useRef<string | null>(null);

  // Point editing ("Edit points" mode), shared by the polygon Collider and
  // LineRenderer vertex editors (see pointsSourceFor/pointsSelection below).
  // Draft points live in a ref (pointer events outrun React state) and are
  // mirrored into state to re-render the handles, like dragPos above.
  const [editingPoints, setEditingPoints] = useState(false);
  const vertexDragRef = useRef<VertexDragState | null>(null);
  const [draggingVertex, setDraggingVertex] = useState(false);
  const draftPointsRef = useRef<Vec2[] | null>(null);
  const [draftPoints, setDraftPointsState] = useState<Vec2[] | null>(null);

  // Tilemap paint mode: click/drag paints the selected palette char (one
  // `paintTiles` per stroke), shift-drag previews and fills a rect (one
  // `fillTilemapRect` per stroke). Like dragPos/draftPoints above, the
  // in-progress stroke lives in a ref (pointer events outrun React state)
  // and is mirrored into state purely to re-render the preview overlay. The
  // cell/stroke math itself is in ../tilemapPaint.ts — see TilemapPainter.tsx
  // for the palette UI this mode drives.
  const [paintMode, setPaintMode] = useState(false);
  const [paintChar, setPaintChar] = useState<string>(ERASER_CHAR);
  const paintRef = useRef<PaintStrokeState | null>(null);
  const paintPreviewRef = useRef<PaintPreview | null>(null);
  const [paintPreview, setPaintPreviewState] = useState<PaintPreview | null>(null);

  function setDragPos(pos: Vec2 | null) {
    dragPosRef.current = pos;
    setDragPosState(pos);
  }

  function setDraftPoints(points: Vec2[] | null) {
    draftPointsRef.current = points;
    setDraftPointsState(points);
  }

  function setPaintPreview(preview: PaintPreview | null) {
    paintPreviewRef.current = preview;
    setPaintPreviewState(preview);
  }

  const assetById = useMemo(() => {
    const map = new Map<string, AssetItem>();
    for (const a of assets) map.set(a.id, a);
    return map;
  }, [assets]);

  const entityById = useMemo(() => {
    const map = new Map<string, SceneEntity>();
    for (const e of scene?.entities ?? []) map.set(e.id, e);
    return map;
  }, [scene]);

  /** Local Transform position, honoring the live drag override. */
  function localPos(e: SceneEntity): Vec2 {
    if (dragRef.current && dragPos && e.id === dragRef.current.entityId) return dragPos;
    const p = (e.components.Transform as { position?: Vec2 } | undefined)?.position;
    return { x: p?.x ?? 0, y: p?.y ?? 0 };
  }

  /** World position = own local position plus ancestor translation offsets. */
  function worldPos(e: SceneEntity): Vec2 {
    let { x, y } = localPos(e);
    let parentId = e.parentId;
    let guard = 0;
    while (parentId && guard++ < 64) {
      const parent = entityById.get(parentId);
      if (!parent) break;
      const p = localPos(parent);
      x += p.x;
      y += p.y;
      parentId = parent.parentId;
    }
    return { x, y };
  }

  // ---- fit view to the build viewport when a scene first shows up ----------
  // The host lives in a dockview panel, so it can be zero-sized on first
  // render (hidden tab, layout still settling). A ResizeObserver bumps
  // viewportEpoch so the fit retries once the panel actually has a size.
  const [viewportEpoch, setViewportEpoch] = useState(0);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewportEpoch((n) => n + 1));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !info || !sceneId) return;
    if (fittedScene.current === sceneId) return;
    const { clientWidth: cw, clientHeight: ch } = host;
    if (cw === 0 || ch === 0) return;
    const { width: W, height: H } = info.buildSettings;
    const s = Math.min(cw / (W + 160), ch / (H + 120), 1.5);
    fittedScene.current = sceneId;
    setView({ s, tx: (cw - W * s) / 2, ty: (ch - H * s) / 2 });
  }, [info, sceneId, scene, viewportEpoch]);

  // Publish the viewport's world-space center to the store on every
  // pan/zoom/fit/resize, so panels outside SceneView (AssetsPanel's "Add to
  // scene") can place new entities in view without reaching into this
  // component's internals. Cleared on unmount so a stale center from a
  // closed/hidden SceneView never survives into another panel's placement.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { clientWidth: cw, clientHeight: ch } = host;
    if (cw === 0 || ch === 0) return;
    setSceneViewCenter({ x: (cw / 2 - view.tx) / view.s, y: (ch / 2 - view.ty) / view.s });
  }, [view, viewportEpoch, setSceneViewCenter]);
  useEffect(() => () => setSceneViewCenter(null), [setSceneViewCenter]);

  // ---- wheel zoom (non-passive so we can preventDefault) -------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s * factor));
        const wx = (cx - v.tx) / v.s;
        const wy = (cy - v.ty) / v.s;
        return { s, tx: cx - wx * s, ty: cy - wy * s };
      });
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  // ---- space-to-pan --------------------------------------------------------
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ---- point editing ("Edit points" mode) -----------------------------------
  // Shared by the polygon Collider and LineRenderer vertex editors: the
  // transform math (polygonLocalToWorld/WorldToLocal) and edge helpers are
  // identical, only the source component/property and minimum point count
  // differ. See polygonEditing.ts's module doc for the shared transform.
  interface PointsSource {
    component: 'Collider' | 'LineRenderer';
    property: string;
    /** LineRenderer needs 2 points to draw a line; a polygon collider needs 3. */
    min: number;
    /** Whether the last→first edge is real (polygon colliders always are; LineRenderer per its `closed` field). */
    closed: boolean;
  }

  function pointsSourceFor(entity: SceneEntity | undefined): PointsSource | null {
    if (!entity) return null;
    const collider = entity.components.Collider as { shape?: string } | undefined;
    if (collider?.shape === 'polygon') {
      return { component: 'Collider', property: 'Collider.points', min: 3, closed: true };
    }
    const line = entity.components.LineRenderer as { closed?: boolean } | undefined;
    if (line) return { component: 'LineRenderer', property: 'LineRenderer.points', min: 2, closed: line.closed === true };
    return null;
  }

  const selectedForRender = selection ? entityById.get(selection) : undefined;
  const canEditPoints = pointsSourceFor(selectedForRender) !== null;

  /** The selected entity + its editable points (Collider polygon or LineRenderer), or null when not editable. */
  function pointsSelection(): { entity: SceneEntity; source: PointsSource; frame: PolygonFrame; points: Vec2[] } | null {
    const entity = selection ? entityById.get(selection) : undefined;
    const source = pointsSourceFor(entity);
    if (!entity || !source) return null;
    const tf = entity.components.Transform as any;
    // LineRenderer has no offset field; only Collider.offset applies.
    const offset =
      source.component === 'Collider'
        ? ((entity.components.Collider as { offset?: Vec2 } | undefined)?.offset ?? { x: 0, y: 0 })
        : { x: 0, y: 0 };
    const frame: PolygonFrame = {
      worldPos: worldPos(entity),
      offset: { x: offset.x ?? 0, y: offset.y ?? 0 },
      rotation: tf?.rotation ?? 0,
      scale: { x: tf?.scale?.x ?? 1, y: tf?.scale?.y ?? 1 },
    };
    const raw = (entity.components[source.component] as { points?: Vec2[] } | undefined)?.points;
    const points = draftPointsRef.current ?? (Array.isArray(raw) ? raw : []);
    return { entity, source, frame, points };
  }

  function exitPointEditing() {
    vertexDragRef.current = null;
    setDraggingVertex(false);
    setDraftPoints(null);
    setEditingPoints(false);
  }

  // The mode only makes sense while an editable-points entity is selected.
  useEffect(() => {
    if (editingPoints && !canEditPoints) exitPointEditing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPoints, canEditPoints]);

  useEffect(() => {
    if (!editingPoints) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitPointEditing();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPoints]);

  // ---- tilemap paint mode ----------------------------------------------
  const selectedTilemap = selectedForRender?.components.Tilemap as TilemapComponent | undefined;
  const canPaintTiles = selectedTilemap !== undefined;

  function exitPaintMode() {
    paintRef.current = null;
    setPaintPreview(null);
    setPaintMode(false);
  }

  function togglePaintMode() {
    if (paintMode) {
      exitPaintMode();
      return;
    }
    if (editingPoints) exitPointEditing();
    setPaintMode(true);
  }

  // The mode only makes sense while a Tilemap entity is selected (mirrors
  // the editingPoints/canEditPoints guard above).
  useEffect(() => {
    if (paintMode && !canPaintTiles) exitPaintMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintMode, canPaintTiles]);

  useEffect(() => {
    if (!paintMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;
      // A native <dialog> (e.g. the tilemap Resize modal) handles its own
      // Escape-to-close; don't also exit paint mode on the same keypress.
      if (document.querySelector('dialog[open]')) return;
      exitPaintMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintMode]);

  // Keeps the selected palette char valid when the selection switches to a
  // different tilemap with a different char set (eraser is always valid).
  useEffect(() => {
    if (!paintMode || !selectedTilemap) return;
    const keys = Object.keys(selectedTilemap.tileAssets);
    if (paintChar !== ERASER_CHAR && !keys.includes(paintChar)) {
      setPaintChar(keys[0] ?? ERASER_CHAR);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintMode, selectedTilemap]);

  function startPaint(e: React.PointerEvent, entity: SceneEntity) {
    const tm = entity.components.Tilemap as TilemapComponent | undefined;
    if (!tm) return;
    const tileSize = tm.tileSize > 0 ? tm.tileSize : 32;
    const origin = worldPos(entity);
    const cell = worldToCell(screenToWorld(screenOf(e)), origin, tileSize);
    const rectMode = e.shiftKey;
    const state: PaintStrokeState = {
      pointerId: e.pointerId,
      entityId: entity.id,
      tileSize,
      origin,
      grid: tm.grid,
      char: paintChar,
      rectMode,
      startCell: cell,
      cells: rectMode ? [] : filterInBounds([{ ...cell, char: paintChar }], tm.grid),
    };
    paintRef.current = state;
    setPaintPreview(
      rectMode ? { rectMode: true, rect: normalizeRect(cell, cell) } : { rectMode: false, cells: state.cells },
    );
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function handleResizeTilemap(width: number, height: number) {
    if (!sceneId || !selectedForRender) return;
    void exec('resizeTilemap', { scene: sceneId, entity: selectedForRender.id, width, height });
  }

  function commitPaint() {
    const paint = paintRef.current;
    const preview = paintPreviewRef.current;
    paintRef.current = null;
    setPaintPreview(null);
    if (!paint || !sceneId) return;
    if (paint.rectMode) {
      const rect = preview && preview.rectMode ? preview.rect : normalizeRect(paint.startCell, paint.startCell);
      const clamped = clampRectToGrid(rect, paint.grid);
      if (!clamped) return;
      void exec('fillTilemapRect', {
        scene: sceneId,
        entity: paint.entityId,
        x: clamped.x,
        y: clamped.y,
        width: clamped.width,
        height: clamped.height,
        char: paint.char,
      });
    } else if (paint.cells.length > 0) {
      void exec('paintTiles', { scene: sceneId, entity: paint.entityId, cells: paint.cells });
    }
  }

  function commitPoints(points: Vec2[]) {
    const sel = pointsSelection();
    if (!sel || !sceneId) {
      setDraftPoints(null);
      return;
    }
    void exec(
      'setComponentProperty',
      {
        scene: sceneId,
        entity: sel.entity.id,
        property: sel.source.property,
        value: roundPoints(points),
      },
      { quiet: true },
    ).finally(() => setDraftPoints(null));
  }

  function beginVertexDrag(e: React.PointerEvent, points: Vec2[], index: number) {
    vertexDragRef.current = { pointerId: e.pointerId, index };
    setDraftPoints(points.map((p) => ({ ...p })));
    setDraggingVertex(true);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function onVertexPointerDown(e: React.PointerEvent, index: number) {
    if (spaceHeld) return; // pan wins
    e.stopPropagation();
    const sel = pointsSelection();
    if (!sel) return;
    if (e.button === 2 || (e.button === 0 && e.altKey)) {
      const next = removeVertex(sel.points, index, sel.source.min);
      if (!next) {
        log(
          'warn',
          'editor',
          sel.source.component === 'Collider'
            ? 'A polygon collider needs at least 3 points.'
            : 'A LineRenderer needs at least 2 points.',
        );
        return;
      }
      commitPoints(next);
      return;
    }
    if (e.button !== 0) return;
    beginVertexDrag(e, sel.points, index);
  }

  function onMidpointPointerDown(e: React.PointerEvent, edgeIndex: number) {
    if (e.button !== 0 || spaceHeld) return;
    e.stopPropagation();
    const sel = pointsSelection();
    if (!sel) return;
    // Insert the new vertex and immediately start dragging it; a plain click
    // (no movement) commits it at the edge midpoint.
    const next = insertVertexOnEdge(sel.points, edgeIndex);
    vertexDragRef.current = { pointerId: e.pointerId, index: edgeIndex + 1 };
    setDraftPoints(next);
    setDraggingVertex(true);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  // ---- pointer handlers ----------------------------------------------------
  function screenOf(e: React.PointerEvent): Vec2 {
    const rect = hostRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function screenToWorld(p: Vec2): Vec2 {
    const v = viewRef.current;
    return { x: (p.x - v.tx) / v.s, y: (p.y - v.ty) / v.s };
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      panRef.current = { pointerId: e.pointerId, start: screenOf(e), startView: viewRef.current };
      svgRef.current?.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else if (e.button === 0 && !editingPoints && !paintMode) {
      // While editing points or painting tiles, a background click is not a
      // deselect (Escape or Done leaves the mode).
      select(null);
    }
  }

  function onEntityPointerDown(e: React.PointerEvent, entity: SceneEntity) {
    if (editingPoints) return; // point handles own the pointer in edit mode
    if (paintMode) {
      // Only the painted tilemap itself responds; other entities are inert
      // while in paint mode, same as editingPoints above.
      if (e.button === 0 && entity.id === selection) {
        e.stopPropagation();
        startPaint(e, entity);
      }
      return;
    }
    if (e.button === 1 || (e.button === 0 && spaceHeld)) return; // background handler pans
    if (e.button !== 0) return;
    e.stopPropagation();
    select(entity.id);
    const start = localPos(entity);
    dragRef.current = {
      entityId: entity.id,
      pointerId: e.pointerId,
      startScreen: screenOf(e),
      startLocal: start,
      moved: false,
    };
    setDragPos(start);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const pan = panRef.current;
    if (pan && e.pointerId === pan.pointerId) {
      const now = screenOf(e);
      setView({
        s: pan.startView.s,
        tx: pan.startView.tx + (now.x - pan.start.x),
        ty: pan.startView.ty + (now.y - pan.start.y),
      });
      return;
    }
    const vDrag = vertexDragRef.current;
    if (vDrag && e.pointerId === vDrag.pointerId) {
      const sel = pointsSelection();
      const draft = draftPointsRef.current;
      if (!sel || !draft) return;
      const local = polygonWorldToLocal(screenToWorld(screenOf(e)), sel.frame);
      setDraftPoints(draft.map((p, i) => (i === vDrag.index ? local : p)));
      return;
    }
    const drag = dragRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      const now = screenOf(e);
      const dx = (now.x - drag.startScreen.x) / viewRef.current.s;
      const dy = (now.y - drag.startScreen.y) / viewRef.current.s;
      if (!drag.moved && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      drag.moved = true;
      setDragPos({ x: drag.startLocal.x + dx, y: drag.startLocal.y + dy });
      return;
    }
    const paint = paintRef.current;
    if (paint && e.pointerId === paint.pointerId) {
      const cell = worldToCell(screenToWorld(screenOf(e)), paint.origin, paint.tileSize);
      if (paint.rectMode) {
        setPaintPreview({ rectMode: true, rect: normalizeRect(paint.startCell, cell) });
      } else if (isCellInBounds(cell, paint.grid)) {
        paint.cells = addStrokeCell(paint.cells, { ...cell, char: paint.char });
        setPaintPreview({ rectMode: false, cells: paint.cells });
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (panRef.current && e.pointerId === panRef.current.pointerId) {
      panRef.current = null;
      return;
    }
    const vDrag = vertexDragRef.current;
    if (vDrag && e.pointerId === vDrag.pointerId) {
      vertexDragRef.current = null;
      setDraggingVertex(false);
      const draft = draftPointsRef.current;
      if (draft) commitPoints(draft);
      return;
    }
    const paint = paintRef.current;
    if (paint && e.pointerId === paint.pointerId) {
      commitPaint();
      return;
    }
    const drag = dragRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      const finalPos = dragPosRef.current;
      dragRef.current = null;
      if (drag.moved && finalPos && sceneId) {
        void exec('moveEntity', {
          scene: sceneId,
          entity: drag.entityId,
          position: { x: Math.round(finalPos.x), y: Math.round(finalPos.y) },
        }).finally(() => setDragPos(null));
      } else {
        setDragPos(null);
      }
    }
  }

  // ---- renderers -----------------------------------------------------------
  function renderSprite(entity: SceneEntity): React.ReactNode {
    const sr = entity.components.SpriteRenderer as any;
    if (!sr || sr.visible === false) return null;
    const w = sr.width ?? 32;
    const h = sr.height ?? 32;
    const flip = `scale(${sr.flipX ? -1 : 1} ${sr.flipY ? -1 : 1})`;
    const asset = sr.assetId ? assetById.get(sr.assetId) : undefined;
    let visual: React.ReactNode;
    if (asset && projectPath) {
      visual = (
        <image
          href={fileUrl(projectPath, asset.path)}
          x={-w / 2}
          y={-h / 2}
          width={w}
          height={h}
          preserveAspectRatio="none"
        />
      );
    } else if (sr.shape === 'circle') {
      visual = <ellipse rx={w / 2} ry={h / 2} fill={sr.color ?? '#ffffff'} />;
    } else if (sr.shape === 'triangle') {
      visual = <polygon points={`0,${-h / 2} ${w / 2},${h / 2} ${-w / 2},${h / 2}`} fill={sr.color ?? '#ffffff'} />;
    } else if (sr.shape === 'none') {
      visual = null;
    } else {
      visual = <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={sr.color ?? '#ffffff'} />;
    }
    return (
      <g transform={flip} opacity={sr.opacity ?? 1}>
        {visual}
      </g>
    );
  }

  function renderText(entity: SceneEntity): React.ReactNode {
    const t = entity.components.Text as any;
    if (!t || t.visible === false) return null;
    const anchor = t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start';
    return (
      <text
        fill={t.color ?? '#ffffff'}
        fontSize={t.fontSize ?? 16}
        fontFamily={t.fontFamily ?? 'monospace'}
        textAnchor={anchor}
        dominantBaseline="middle"
      >
        {t.content ?? ''}
      </text>
    );
  }

  function renderTilemap(entity: SceneEntity): React.ReactNode {
    const tm = entity.components.Tilemap as any;
    if (!tm) return null;
    const size = tm.tileSize ?? 32;
    const grid: string[] = Array.isArray(tm.grid) ? tm.grid : [];
    const cells: React.ReactNode[] = [];
    grid.forEach((row: string, ry: number) => {
      [...row].forEach((ch, cx) => {
        if (ch === '.' || ch === ' ') return;
        const assetId = tm.tileAssets?.[ch];
        const asset = assetId ? assetById.get(assetId) : undefined;
        if (asset && projectPath) {
          cells.push(
            <image
              key={`${cx}-${ry}`}
              href={fileUrl(projectPath, asset.path)}
              x={cx * size}
              y={ry * size}
              width={size}
              height={size}
              preserveAspectRatio="none"
            />,
          );
        } else {
          cells.push(
            <rect
              key={`${cx}-${ry}`}
              x={cx * size}
              y={ry * size}
              width={size}
              height={size}
              fill="oklch(0.5 0.02 55)"
              stroke="oklch(0.35 0.02 55)"
              strokeWidth={1}
            />,
          );
        }
      });
    });
    return <g>{cells}</g>;
  }

  /**
   * Live feedback for an in-progress tilemap paint stroke: highlighted cells
   * for a freehand stroke, or a translucent rect for a shift-drag fill.
   * Drawn in the same local space as renderTilemap (cx*size / ry*size)
   * inside the same entity group, only for the entity currently being
   * painted.
   */
  function renderPaintPreview(entity: SceneEntity): React.ReactNode {
    if (!paintPreview) return null;
    const tm = entity.components.Tilemap as TilemapComponent | undefined;
    if (!tm) return null;
    const size = tm.tileSize > 0 ? tm.tileSize : 32;
    if (paintPreview.rectMode) {
      const r = paintPreview.rect;
      return (
        <rect
          x={r.x * size}
          y={r.y * size}
          width={r.width * size}
          height={r.height * size}
          fill="var(--accent)"
          fillOpacity={0.22}
          stroke="var(--accent)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      );
    }
    return (
      <g pointerEvents="none">
        {paintPreview.cells.map((c) => (
          <rect
            key={`${c.x}-${c.y}`}
            x={c.x * size}
            y={c.y * size}
            width={size}
            height={size}
            fill={c.char === ERASER_CHAR ? 'none' : 'var(--accent)'}
            fillOpacity={c.char === ERASER_CHAR ? 0.06 : 0.32}
            stroke="var(--accent)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
    );
  }

  function renderCameraGizmo(entity: SceneEntity): React.ReactNode {
    const cam = entity.components.Camera as any;
    if (!cam || !info) return null;
    const zoom = cam.zoom > 0 ? cam.zoom : 1;
    const w = info.buildSettings.width / zoom;
    const h = info.buildSettings.height / zoom;
    return (
      // A debug overlay, like the Light2D/ParticleEmitter gizmos below — it
      // must not steal clicks from whatever's actually inside the viewport
      // (a Tilemap's default layer of -10 puts it behind the camera in
      // z-order, so without this a click meant to select/paint the tilemap
      // hit this rect's real fill instead).
      <g pointerEvents="none">
        <rect
          x={-w / 2}
          y={-h / 2}
          width={w}
          height={h}
          fill={cam.backgroundColor ?? '#1a1a2e'}
          fillOpacity={0.18}
          stroke="var(--info)"
          strokeDasharray="6 4"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        <text
          x={-w / 2}
          y={-h / 2 - 6 / view.s}
          fill="var(--info)"
          fontSize={11 / view.s}
          fontFamily="var(--font-mono)"
        >
          {entity.name}
          {cam.isMain ? ' • main' : ''}
        </text>
      </g>
    );
  }

  /**
   * LineRenderer: the real polyline/polygon (points/width/color/closed/
   * opacity), at the entity transform like renderSprite/renderText. Vertex
   * drag handles are drawn separately, only while selected and in point-edit
   * mode (the same overlay the polygon Collider editor uses).
   */
  function renderLineRenderer(entity: SceneEntity): React.ReactNode {
    const lr = entity.components.LineRenderer as any;
    if (!lr || lr.visible === false) return null;
    const points: Vec2[] = Array.isArray(lr.points) ? lr.points : [];
    if (points.length < 2) return null;
    const attr = points.map((p) => `${p.x},${p.y}`).join(' ');
    // Width is world-space (matching the runtime's Pixi stroke), so it zooms
    // with the rest of the scene — non-scaling-stroke is reserved for UI
    // overlays like the selection outline.
    const shared = {
      fill: 'none',
      stroke: lr.color ?? '#ffffff',
      strokeWidth: lr.width ?? 2,
      strokeLinecap: 'round' as const,
      strokeLinejoin: 'round' as const,
      opacity: lr.opacity ?? 1,
    };
    return lr.closed ? <polygon points={attr} {...shared} /> : <polyline points={attr} {...shared} />;
  }

  /**
   * Light2D: dashed radius circle in the light's color + a small bulb glyph.
   * Drawn at the entity's world position only (no rotation/scale) — the
   * runtime's debug overlay draws the same radius circle unscaled, and a
   * light's radius has no orientation.
   */
  function renderLightGizmo(entity: SceneEntity): React.ReactNode {
    const light = entity.components.Light2D as any;
    if (!light || light.enabled === false) return null;
    const color = light.color ?? '#ffffff';
    const radius = light.radius ?? 200;
    const g = 5 / view.s; // fixed on-screen glyph size, like the polygon vertex handles
    return (
      <g pointerEvents="none">
        <circle
          cx={0}
          cy={0}
          r={radius}
          fill="none"
          stroke={color}
          strokeOpacity={0.4}
          strokeWidth={1.5}
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
        {/* vector-effect is per-shape (not inherited), hence on each element */}
        <g stroke={color} strokeWidth={1.3} fill="none">
          <circle cx={0} cy={0} r={g} vectorEffect="non-scaling-stroke" />
          <path
            d={`M ${-g * 0.4} ${g * 1.2} L ${g * 0.4} ${g * 1.2} M ${-g * 0.22} ${g * 1.7} L ${g * 0.22} ${g * 1.7}`}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </g>
    );
  }

  /**
   * ParticleEmitter: a small fountain glyph plus two lines showing the
   * `direction ± spread` cone. Drawn unrotated/unscaled by the entity
   * transform, matching how spawnOne() computes particle velocity from
   * emitter.direction directly against world position (no transform.rotation
   * applied) — see packages/runtime/src/particles.ts.
   */
  function renderParticleGizmo(entity: SceneEntity): React.ReactNode {
    const pe = entity.components.ParticleEmitter as any;
    if (!pe) return null;
    const color = pe.startColor ?? '#ffffff';
    const dir = ((pe.direction ?? 0) * Math.PI) / 180;
    const spread = ((pe.spread ?? 0) * Math.PI) / 180;
    const len = 48 / view.s; // fixed ~48 on-screen px, a glyph rather than a true travel distance
    const a = (angle: number) => ({ x: Math.cos(angle) * len, y: Math.sin(angle) * len });
    const p1 = a(dir - spread);
    const p2 = a(dir + spread);
    const r = 4 / view.s;
    return (
      <g pointerEvents="none" stroke={color} strokeOpacity={0.75} strokeWidth={1.3} fill="none">
        <line x1={0} y1={0} x2={p1.x} y2={p1.y} vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={0} x2={p2.x} y2={p2.y} vectorEffect="non-scaling-stroke" />
        {/* fountain glyph: basin + a jet splitting into two droplets */}
        <path
          d={`M ${-r} ${r * 1.4} L ${r} ${r * 1.4} M 0 ${r * 1.4} L 0 ${-r * 0.4} M 0 ${-r * 0.4} L ${-r * 0.7} ${r * 0.6} M 0 ${-r * 0.4} L ${r * 0.7} ${r * 0.6}`}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    );
  }

  /** Visual bounds in local space, for hit-testing and the selection outline. */
  function boundsOf(entity: SceneEntity): { x: number; y: number; w: number; h: number } {
    const sr = entity.components.SpriteRenderer as any;
    if (sr) {
      const w = sr.width ?? 32;
      const h = sr.height ?? 32;
      return { x: -w / 2, y: -h / 2, w, h };
    }
    const t = entity.components.Text as any;
    if (t) {
      const fs = t.fontSize ?? 16;
      const w = Math.max(20, String(t.content ?? '').length * fs * 0.62);
      return t.align === 'center'
        ? { x: -w / 2, y: -fs * 0.75, w, h: fs * 1.5 }
        : t.align === 'right'
          ? { x: -w, y: -fs * 0.75, w, h: fs * 1.5 }
          : { x: 0, y: -fs * 0.75, w, h: fs * 1.5 };
    }
    const tm = entity.components.Tilemap as any;
    if (tm) {
      const size = tm.tileSize ?? 32;
      const rows: string[] = Array.isArray(tm.grid) ? tm.grid : [];
      const cols = rows.reduce((m: number, r: string) => Math.max(m, r.length), 1);
      return { x: 0, y: 0, w: Math.max(cols, 1) * size, h: Math.max(rows.length, 1) * size };
    }
    const lr = entity.components.LineRenderer as any;
    if (lr && Array.isArray(lr.points) && lr.points.length > 0) {
      const pad = (lr.width ?? 2) / 2 + 4;
      const xs = lr.points.map((p: Vec2) => p.x);
      const ys = lr.points.map((p: Vec2) => p.y);
      const minX = Math.min(...xs) - pad;
      const maxX = Math.max(...xs) + pad;
      const minY = Math.min(...ys) - pad;
      const maxY = Math.max(...ys) + pad;
      return { x: minX, y: minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) };
    }
    const m = 24;
    return { x: -m / 2, y: -m / 2, w: m, h: m };
  }

  function layerOf(entity: SceneEntity): number {
    const sr = entity.components.SpriteRenderer as any;
    const t = entity.components.Text as any;
    const tm = entity.components.Tilemap as any;
    const lr = entity.components.LineRenderer as any;
    return (tm?.layer ?? sr?.layer ?? t?.layer ?? lr?.layer ?? 0) as number;
  }

  const sorted = useMemo(() => {
    const entities = [...(scene?.entities ?? [])];
    entities.sort((a, b) => layerOf(a) - layerOf(b));
    return entities;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  const selectedEntity = selection ? entityById.get(selection) : undefined;

  return (
    <div
      ref={hostRef}
      className={`scene-view${spaceHeld ? ' panning' : ''}${draggingVertex ? ' vertex-dragging' : ''}${paintMode ? ' painting-tiles' : ''}`}
    >
      <svg
        ref={svgRef}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
          {/* grid */}
          <defs>
            <pattern id="scene-grid" width={32} height={32} patternUnits="userSpaceOnUse">
              <path d="M 32 0 L 0 0 0 32" fill="none" stroke="var(--grid-line)" strokeWidth={1 / view.s} />
            </pattern>
          </defs>
          <rect x={-20000} y={-20000} width={40000} height={40000} fill="url(#scene-grid)" pointerEvents="none" />
          <line x1={-20000} y1={0} x2={20000} y2={0} stroke="var(--grid-axis)" strokeWidth={1 / view.s} />
          <line x1={0} y1={-20000} x2={0} y2={20000} stroke="var(--grid-axis)" strokeWidth={1 / view.s} />

          {/* entities */}
          {sorted.map((entity) => {
            const wp = worldPos(entity);
            const tf = entity.components.Transform as any;
            const rot = tf?.rotation ?? 0;
            const sx = tf?.scale?.x ?? 1;
            const sy = tf?.scale?.y ?? 1;
            const b = boundsOf(entity);
            return (
              <g
                key={entity.id}
                transform={`translate(${wp.x} ${wp.y})`}
                opacity={entity.enabled ? 1 : 0.35}
                style={{
                  cursor: spaceHeld || editingPoints || (paintMode && entity.id !== selection) ? undefined : paintMode ? 'crosshair' : 'move',
                }}
                onPointerDown={(e) => onEntityPointerDown(e, entity)}
              >
                <g transform={`rotate(${rot}) scale(${sx} ${sy})`}>
                  {renderTilemap(entity)}
                  {paintMode && entity.id === selection && renderPaintPreview(entity)}
                  {renderSprite(entity)}
                  {renderText(entity)}
                  {renderLineRenderer(entity)}
                  {renderCameraGizmo(entity)}
                  {/* hit area */}
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="transparent" stroke="none" />
                </g>
                {/* Light2D/ParticleEmitter gizmos: world position only, not the
                    entity's own rotation/scale — see their render fns for why. */}
                {renderLightGizmo(entity)}
                {renderParticleGizmo(entity)}
              </g>
            );
          })}

          {/* selection outline, drawn on top */}
          {selectedEntity &&
            (() => {
              const wp = worldPos(selectedEntity);
              const tf = selectedEntity.components.Transform as any;
              const b = boundsOf(selectedEntity);
              return (
                <g
                  transform={`translate(${wp.x} ${wp.y}) rotate(${tf?.rotation ?? 0}) scale(${tf?.scale?.x ?? 1} ${tf?.scale?.y ?? 1})`}
                  pointerEvents="none"
                >
                  <rect
                    x={b.x - 2 / view.s}
                    y={b.y - 2 / view.s}
                    width={b.w + 4 / view.s}
                    height={b.h + 4 / view.s}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })()}

          {/* point editor: polygon Collider or LineRenderer vertex handles */}
          {editingPoints &&
            (() => {
              const sel = pointsSelection();
              if (!sel) return null;
              const localPts = draftPoints ?? sel.points;
              const worldPts = localPts.map((p) => polygonLocalToWorld(p, sel.frame));
              if (worldPts.length === 0) return null;
              // Only the real edges get a midpoint (add-vertex) handle: all of
              // them for a polygon collider, but for an open LineRenderer the
              // last→first "edge" edgeMidpoints reports doesn't actually exist.
              const mids = edgeMidpoints(worldPts).slice(0, sel.source.closed ? worldPts.length : worldPts.length - 1);
              const r = 4 / view.s; // 8px vertex handles on screen
              const mr = 3 / view.s; // slightly smaller midpoint handles
              const hit = 9 / view.s; // comfortable hit area around both
              const outlineProps = {
                points: worldPts.map((p) => `${p.x},${p.y}`).join(' '),
                fill: sel.source.component === 'Collider' ? 'var(--accent)' : 'none',
                fillOpacity: 0.08,
                stroke: 'var(--accent)',
                strokeWidth: 1.5,
                vectorEffect: 'non-scaling-stroke' as const,
                pointerEvents: 'none' as const,
              };
              return (
                <g>
                  {sel.source.closed || worldPts.length < 2 ? (
                    <polygon {...outlineProps} />
                  ) : (
                    <polyline {...outlineProps} />
                  )}
                  {mids.map((m, i) => (
                    <g key={`mid-${i}`} className="poly-mid" onPointerDown={(e) => onMidpointPointerDown(e, i)}>
                      <circle cx={m.x} cy={m.y} r={hit} fill="transparent" stroke="none" />
                      <rect
                        x={m.x - mr}
                        y={m.y - mr}
                        width={mr * 2}
                        height={mr * 2}
                        transform={`rotate(45 ${m.x} ${m.y})`}
                        className="poly-mid-dot"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  ))}
                  {worldPts.map((p, i) => (
                    <g key={`vtx-${i}`} className="poly-vertex" onPointerDown={(e) => onVertexPointerDown(e, i)}>
                      <circle cx={p.x} cy={p.y} r={hit} fill="transparent" stroke="none" />
                      <circle cx={p.x} cy={p.y} r={r} className="poly-vertex-dot" vectorEffect="non-scaling-stroke" />
                    </g>
                  ))}
                </g>
              );
            })()}
        </g>
      </svg>

      {canEditPoints && (
        <div className="scene-edit-points">
          {editingPoints ? (
            <button className="btn btn-primary btn-sm" onClick={exitPointEditing}>
              Done
            </button>
          ) : (
            <button
              className="btn btn-sm"
              title="Edit the polygon collider's or LineRenderer's points in the scene"
              onClick={() => {
                if (paintMode) exitPaintMode();
                setEditingPoints(true);
              }}
            >
              Edit points
            </button>
          )}
        </div>
      )}

      {canPaintTiles && selectedTilemap && (
        <TilemapPainter
          tilemap={selectedTilemap}
          assets={assets}
          projectPath={projectPath}
          paintMode={paintMode}
          onTogglePaintMode={togglePaintMode}
          selectedChar={paintChar}
          onSelectChar={setPaintChar}
          onResize={handleResizeTilemap}
        />
      )}

      <div className="scene-hud">
        <span>{Math.round(view.s * 100)}%</span>
        {selectedEntity && (
          <span>
            {Math.round(worldPos(selectedEntity).x)}, {Math.round(worldPos(selectedEntity).y)}
          </span>
        )}
      </div>
      <div className="scene-hint">
        {editingPoints
          ? 'drag a point · click an edge midpoint to add one · alt-click a point to delete · esc or Done to finish'
          : paintMode
            ? 'click or drag to paint · shift-drag to fill a rect · esc or Done painting to finish'
            : 'scroll to zoom · space+drag or middle-drag to pan · drag an entity to move it'}
      </div>
    </div>
  );
}
