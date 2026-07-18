/**
 * Scene view: an SVG rendering of the scene JSON with grid, pan/zoom,
 * click-select, and drag-to-move (drag release posts a moveEntity command).
 * This is deliberately not the game runtime — it draws the authored data.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ParticleEmitterComponent, TilemapComponent } from '@hearth/core';
import { useEditor } from '../store';
import { fileUrl } from '../api';
import { isInteractiveTarget, isTypingTarget } from '../keybinds';
import { ParticlePreview, particleVisual, type Particle, type PreviewTarget } from '../particlePreview';
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
  applyCenterHandleDrag,
  cursorFor,
  handlePositions,
  hitHandle,
  planDragCommit,
  resolveHandleTarget,
  type DragResult,
  type HandleId,
  type ResolvedHandleTarget,
  type SelectionBox,
} from '../transformHandles';
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
import { resolveUiPositions } from '@hearth/runtime/ui';
import { readSheetSize } from '../assetPreview';
import { overlayStrokeCells, resolveTileVisual, type TileAsset, type TileVisual } from '../tileAutotileVisual';
import { ERASER_CHAR, TilemapPainter } from './TilemapPainter';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
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

/** An in-progress transform-handle drag (resize or rotate gizmo). */
interface HandleDragState {
  pointerId: number;
  entityId: string;
  handleId: HandleId;
  /** Which component/property the gesture edits, resolved at drag start. */
  target: ResolvedHandleTarget;
  /** The world-space selection box at drag start. */
  startBox: SelectionBox;
  startWorld: Vec2;
  moved: boolean;
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
/** Multiplicative step for the =/- keyboard-zoom shortcuts (a 25% step per press). */
const KEY_ZOOM_FACTOR = 1.25;

/** The scene grid pitch, in world px — matches the drawn `#scene-grid` pattern. Shift-drag move snaps to this (L-029). */
export const GRID_SIZE = 32;

/** Snap a world coordinate to the nearest grid multiple (used by shift-drag move). */
export function snapToGrid(v: number, grid: number = GRID_SIZE): number {
  return Math.round(v / grid) * grid + 0; // `+ 0` normalizes -0 to 0
}

/**
 * Whether a bare Space keydown should begin canvas panning. Yields to any
 * focusable interactive control (via isInteractiveTarget) — input/textarea,
 * CodeMirror's contenteditable surface (so Space types a space in the Code
 * panel, L-053 / CODE-1) AND buttons/links/role-controls, so a focused button
 * still activates on Space anywhere in the app instead of having its native
 * Space-activation silently preventDefault'd by this window-level handler
 * (L-121 / CODE-PLAY-1).
 */
export function panSpaceKey(e: { code: string; target: unknown }): boolean {
  return e.code === 'Space' && !isInteractiveTarget(e.target);
}

/**
 * Map a runtime screen-space UIElement position (0..W, 0..H, top-left origin —
 * see packages/runtime/src/ui.ts uiScreenPosition/resolveUiPositions) into the
 * Scene view's world space, placed 1:1 over the active camera's viewport so it
 * overlays exactly what that camera frames (L-024).
 *
 * The runtime draws UIElement entities in a screen-space overlay container that
 * is fixed to the canvas and ignores camera zoom (packages/runtime/src/pixi
 * updateNode), so the HUD is represented here at its true 1:1 pixel size,
 * centered on the camera. With the runtime's default camera (no Camera entity →
 * center = {W/2, H/2}) this reduces to the identity screen→world mapping, which
 * is also where `fitView` frames the scene — so a default HUD lands over the
 * build viewport at world origin, matching the game.
 */
export function uiScreenToWorld(screen: Vec2, camCenter: Vec2, size: { w: number; h: number }): Vec2 {
  return { x: camCenter.x + screen.x - size.w / 2, y: camCenter.y + screen.y - size.h / 2 };
}

/**
 * Zoom by `factor` around a fixed screen-space point (keeps that point under
 * the cursor/center as the scale changes), clamped to [MIN_ZOOM, MAX_ZOOM].
 * Shared by wheel-zoom (continuous factor from deltaY) and the discrete
 * =/- keyboard shortcuts — same math, different factor source.
 */
export function zoomBy(view: ViewTransform, factor: number, center: Vec2): ViewTransform {
  const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.s * factor));
  const wx = (center.x - view.tx) / view.s;
  const wy = (center.y - view.ty) / view.s;
  return { s, tx: center.x - wx * s, ty: center.y - wy * s };
}

/**
 * What a wheel event means over the Scene view. Pure so it can be tested
 * without a canvas, mirroring `sceneZoomKey` below.
 *
 * A trackpad two-finger scroll and a mouse wheel both arrive as `wheel`, and
 * telling the devices apart is only ever a guess (deltaMode and delta
 * magnitudes vary by browser and OS), so this maps the GESTURE, not the
 * device — the 2D-canvas convention Figma and Sketch use:
 *
 *  - ctrl/meta held -> zoom. Browsers synthesize `ctrlKey` for a trackpad
 *    PINCH, so pinch-to-zoom lands here for free, as does ctrl+wheel on a
 *    mouse.
 *  - otherwise -> pan, honoring `deltaX` so a trackpad's horizontal axis
 *    works instead of being dropped on the floor.
 *
 * Zooming on a plain wheel (what this used to do) left a trackpad with no pan
 * gesture at all: two-finger scroll zoomed, and panning meant holding Space.
 * Mouse users zoom with ctrl+wheel, the =/- keys, or 0 to fit.
 */
export function sceneWheelAction(e: {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}): { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number } {
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: Math.exp(-e.deltaY * 0.0015) };
  return { kind: 'pan', dx: -e.deltaX, dy: -e.deltaY };
}

/** Scale + center a `buildSize`-sized scene inside a `hostSize`-sized viewport, with padding. */
export function fitView(hostSize: { w: number; h: number }, buildSize: { w: number; h: number }): ViewTransform {
  const s = Math.min(hostSize.w / (buildSize.w + 160), hostSize.h / (buildSize.h + 120), 1.5);
  return { s, tx: (hostSize.w - buildSize.w * s) / 2, ty: (hostSize.h - buildSize.h * s) / 2 };
}

/**
 * Decide what (if anything) a keydown should do for the bare =/-/0 zoom
 * shortcuts: null when it's not a zoom key, a typing target has focus (the
 * same guard the global registry's isTypingTarget enforces), or a modifier
 * is held — bare keys only, since Mod+=/Mod+-/Mod+0 are the browser's own
 * page-zoom shortcuts and this app also ships in the browser. Pure and
 * DOM-free so it's unit-testable without mounting SceneView.
 */
export function sceneZoomKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
}): 'in' | 'out' | 'fit' | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  if (e.key === '=') return 'in';
  if (e.key === '-') return 'out';
  if (e.key === '0') return 'fit';
  return null;
}

export function SceneView() {
  const projectPath = useEditor((s) => s.projectPath);
  const info = useEditor((s) => s.info);
  const scene = useEditor((s) => s.scene);
  const sceneId = useEditor((s) => s.sceneId);
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection);
  const playing = useEditor((s) => s.playing);
  const select = useEditor((s) => s.select);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);
  const setSceneViewCenter = useEditor((s) => s.setSceneViewCenter);
  const focusSelectionRequest = useEditor((s) => s.focusSelectionRequest);

  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Whether the pointer is currently over the Scene host — space-to-pan only
  // engages when this view is the pointer's context (L-121 scoping).
  const hoverRef = useRef(false);
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

  // Transform-handle gizmo drag (resize/rotate on the selection). Like the
  // move drag above: the drag lives in a ref, and the live DragResult ghost
  // is mirrored into state purely to re-render the preview.
  const handleDragRef = useRef<HandleDragState | null>(null);
  const handleGhostRef = useRef<DragResult | null>(null);
  const [handleGhost, setHandleGhostState] = useState<DragResult | null>(null);

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

  function setHandleGhost(result: DragResult | null) {
    handleGhostRef.current = result;
    setHandleGhostState(result);
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

  const buildW = info?.buildSettings.width ?? 0;
  const buildH = info?.buildSettings.height ?? 0;

  // ---- UIElement placement (L-024) ----------------------------------------
  // UIElement entities are screen-space (anchor + offset), NOT world-space
  // Transforms — every HUD entity in a real scene sits at Transform {0,0} and
  // gets its real position from anchor+offset alone (packages/runtime/src/ui.ts
  // uiScreenPosition, which never reads Transform.position). Resolving them
  // through resolveUiPositions — the SAME function the runtime and pixi host
  // call — reuses the exact anchor/offset/UILayout math, so the Scene view is a
  // truthful HUD preview instead of a pile of overlapping text at world origin.
  const uiScreenPositions = useMemo(() => {
    const entities = scene?.entities;
    if (!entities || buildW === 0 || buildH === 0) return new Map<string, Vec2>();
    return resolveUiPositions(
      entities as unknown as Parameters<typeof resolveUiPositions>[0],
      buildW,
      buildH,
    );
  }, [scene, buildW, buildH]);

  /** Local Transform position, honoring the live drag override. */
  function localPos(e: SceneEntity): Vec2 {
    if (dragRef.current && dragPos && e.id === dragRef.current.entityId) return dragPos;
    const p = (e.components.Transform as { position?: Vec2 } | undefined)?.position;
    return { x: p?.x ?? 0, y: p?.y ?? 0 };
  }

  /**
   * The active camera's world center — mirrors runtime.ts's `camera` getter
   * (isMain wins, else the first Camera entity, else the build-viewport center
   * {W/2, H/2}). UIElement entities are placed 1:1 over this so the HUD overlays
   * exactly what the camera frames (see uiScreenToWorld). Cameras never carry a
   * UIElement, so worldPos(cam) here can't recurse back into UI placement.
   */
  function activeCameraCenter(): Vec2 {
    const cams = (scene?.entities ?? []).filter(
      (e) => e.enabled !== false && e.components.Camera,
    );
    const cam = cams.find((e) => (e.components.Camera as { isMain?: boolean }).isMain) ?? cams[0];
    if (!cam) return { x: buildW / 2, y: buildH / 2 };
    return worldPos(cam);
  }

  /** World position: UIElement entities resolve via anchor+offset over the camera; everyone else walks the Transform parent chain. */
  function worldPos(e: SceneEntity): Vec2 {
    if (e.components.UIElement) {
      const screen = uiScreenPositions.get(e.id);
      if (screen) return uiScreenToWorld(screen, activeCameraCenter(), { w: buildW, h: buildH });
    }
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

  /** Summed ancestor translation (world − local), so a world-space grid snap maps back to a local Transform.position. */
  function ancestorOffset(e: SceneEntity): Vec2 {
    let x = 0;
    let y = 0;
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
  // The same "zero-sized while hidden" behavior (dockview detaches an
  // inactive tab's content from the DOM) doubles as the particle preview's
  // "is the Scene panel actually visible" gate below — no dockview API
  // wiring needed, just this already-observed size.
  const [viewportEpoch, setViewportEpoch] = useState(0);
  const [panelVisible, setPanelVisible] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setViewportEpoch((n) => n + 1);
      setPanelVisible(host.clientWidth > 0 && host.clientHeight > 0);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // ---- editor-only live particle preview for the selected emitter ---------
  // See particlePreview.ts for the ticker/gating/reset design. One
  // ParticlePreview instance per SceneView mount; disposed on unmount so its
  // rAF ticker never outlives the component. The cleanup also clears the ref
  // (not just calling dispose()) so React 18 StrictMode's dev-only
  // mount→unmount→remount cycle doesn't permanently poison a disposed
  // instance that the render-phase guard below would otherwise never
  // replace — without this, the remounted component keeps reusing the same
  // (now-disposed, un-recoverable) ParticlePreview and the preview silently
  // never starts.
  const particlePreviewRef = useRef<ParticlePreview | null>(null);
  if (!particlePreviewRef.current) particlePreviewRef.current = new ParticlePreview();
  const particlePreview = particlePreviewRef.current;
  useEffect(() => {
    return () => {
      particlePreview.dispose();
      if (particlePreviewRef.current === particlePreview) particlePreviewRef.current = null;
    };
  }, [particlePreview]);

  // Re-render on every stepped preview frame (only fires while the ticker is
  // actually gated on — see ParticlePreview.sync/isActive).
  const [, bumpParticleTick] = useState(0);
  useEffect(() => particlePreview.subscribe(() => bumpParticleTick((n) => n + 1)), [particlePreview]);

  useEffect(() => particlePreview.setVisible(panelVisible), [particlePreview, panelVisible]);
  // Emitter preview is always-on for the selected emitter now (object-owned,
  // Unity/Godot model) — the floating "Particles" toggle + its localStorage
  // pref were removed per JAKE-STEER (L-027). Gating is purely panel-visible +
  // selection (a single target is set below), so the ticker still never runs
  // for an unselected emitter or a hidden panel.
  useEffect(() => particlePreview.setToggleEnabled(true), [particlePreview]);
  useEffect(() => {
    const fixedTimestep = info?.buildSettings.fixedTimestep;
    particlePreview.setFixedDt(fixedTimestep && fixedTimestep > 0 ? 1 / fixedTimestep : 1 / 60);
  }, [particlePreview, info?.buildSettings.fixedTimestep]);

  // Only the selected entity's ParticleEmitter (if any, and if enabled) ever
  // gets a target — perf guard: nothing else in the scene simulates. Reruns
  // on `dragPos` too so a live move-drag (not just an Inspector edit, which
  // already produces a new `entityById`/entity object via the store's
  // full-scene refresh) resets the preview at its new origin.
  const selectedForPreview = selection ? entityById.get(selection) : undefined;
  useEffect(() => {
    const pe = selectedForPreview?.components.ParticleEmitter as ParticleEmitterComponent | undefined;
    const targets: PreviewTarget[] =
      selectedForPreview && selectedForPreview.enabled && pe
        ? [{ entityId: selectedForPreview.id, emitter: pe, origin: worldPos(selectedForPreview) }]
        : [];
    particlePreview.setTargets(targets);
  }, [particlePreview, selectedForPreview, dragPos]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !info || !sceneId) return;
    if (fittedScene.current === sceneId) return;
    const { clientWidth: cw, clientHeight: ch } = host;
    if (cw === 0 || ch === 0) return;
    const { width: W, height: H } = info.buildSettings;
    fittedScene.current = sceneId;
    setView(fitView({ w: cw, h: ch }, { w: W, h: H }));
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

  // ---- focus selection (the `f` shortcut) ----------------------------------
  // Center + fit the camera on the selected entity's world bounds, clamped to
  // the same zoom range as wheel zoom. Fires only when the store nonce bumps
  // (not on mount / selection change), mirroring diffFocusRequest's seam.
  const lastFocusReq = useRef(focusSelectionRequest);
  useEffect(() => {
    if (focusSelectionRequest === lastFocusReq.current) return;
    lastFocusReq.current = focusSelectionRequest;
    const host = hostRef.current;
    const entity = selection ? entityById.get(selection) : undefined;
    if (!host || !entity) return;
    const { clientWidth: cw, clientHeight: ch } = host;
    if (cw === 0 || ch === 0) return;
    const b = boundsOf(entity);
    const tf = entity.components.Transform as { scale?: Vec2 } | undefined;
    const sx = tf?.scale?.x ?? 1;
    const sy = tf?.scale?.y ?? 1;
    const wp = worldPos(entity);
    const w = Math.max(Math.abs(b.w * sx), 1);
    const h = Math.max(Math.abs(b.h * sy), 1);
    const cx = wp.x + (b.x + b.w / 2) * sx;
    const cy = wp.y + (b.y + b.h / 2) * sy;
    const pad = 80; // breathing room around the entity, in screen px
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(cw / (w + pad), ch / (h + pad))));
    setView({ s, tx: cw / 2 - cx * s, ty: ch / 2 - cy * s });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSelectionRequest]);

  // ---- Escape to deselect --------------------------------------------------
  // Only when no scene mode is active (point-edit / paint own their own
  // Escape, below) and no <dialog> is open (it owns Escape natively). Modes
  // still selected keep the selection until their own Escape exits them, so
  // this never fights those handlers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editingPoints || paintMode) return;
      if (typeof document !== 'undefined' && document.querySelector('dialog[open]')) return;
      const t = e.target;
      if (t instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (!selection) return;
      select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPoints, paintMode, selection]);

  // ---- wheel: pan, or zoom while ctrl/meta is held (see sceneWheelAction) --
  // Non-passive so we can preventDefault.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const action = sceneWheelAction(e);
      if (action.kind === 'zoom') {
        const rect = host.getBoundingClientRect();
        const center = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        setView((v) => zoomBy(v, action.factor, center));
        return;
      }
      setView((v) => ({ ...v, tx: v.tx + action.dx, ty: v.ty + action.dy }));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  // ---- keyboard zoom (=/-/0, bare keys — display-only rows in keybinds.ts) -
  // Bare keys deliberately, not Mod+=/Mod+-/Mod+0: those are the browser's
  // own page-zoom shortcuts, unreliable to preventDefault() across browsers,
  // and this editor also ships in the browser. sceneZoomKey carries the
  // typing-target guard so this never fires while typing (an input/textarea,
  // or CodeMirror's contentEditable surface in the Code panel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = sceneZoomKey(e);
      if (!action) return;
      if (typeof document !== 'undefined' && document.querySelector('dialog[open]')) return;
      const host = hostRef.current;
      if (!host) return;
      const { clientWidth: cw, clientHeight: ch } = host;
      if (cw === 0 || ch === 0) return;
      e.preventDefault();
      if (action === 'fit') {
        if (!info) return;
        const { width: W, height: H } = info.buildSettings;
        setView(fitView({ w: cw, h: ch }, { w: W, h: H }));
        return;
      }
      setView((v) => zoomBy(v, action === 'in' ? KEY_ZOOM_FACTOR : 1 / KEY_ZOOM_FACTOR, { x: cw / 2, y: ch / 2 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [info]);

  // ---- space-to-pan --------------------------------------------------------
  // The guard uses the shared isTypingTarget (via panSpaceKey) so it yields to
  // CodeMirror's contenteditable surface, not just INPUT/TEXTAREA — otherwise
  // this window-level handler preventDefault's Space over the Code panel and
  // eats every space typed into a script (L-053 / CODE-1).
  // Scope the global Space grab to when the Scene view is actually the user's
  // context: the host must be visible (dockview hides inactive panels via
  // display:none → offsetParent null) AND either hovered or holding focus.
  // Otherwise pressing Space while working in another panel (Assets, Console,
  // etc.) would be a silent over-reach that eats the keystroke (L-121).
  const pannable = () => {
    const host = hostRef.current;
    if (!host || host.offsetParent === null) return false;
    return hoverRef.current || host.contains(document.activeElement);
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (panSpaceKey(e) && pannable()) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (playing) return; // never mutate the scene under a live run (L-025 / SCENEVIEW-4)
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

  // ---- transform handles (resize/rotate gizmo on the selection) -------------
  // Geometry lives in ../transformHandles.ts; this section resolves what a
  // drag edits (resolveHandleTarget), draws the gizmo, and commits ONE
  // setComponentProperty per gesture on pointer-up (see commitHandleDrag for
  // the one documented exception). Hidden while playing, editing points,
  // painting tiles, with nothing selected, or on a UIElement (screen-space:
  // position is authored via anchor+offset in the Inspector, not a scene drag —
  // see L-024 and onEntityPointerDown).
  const showHandles =
    !playing &&
    !editingPoints &&
    !paintMode &&
    selectedForRender !== undefined &&
    !selectedForRender.components.UIElement;

  /**
   * The selected entity's resolved drag target plus its world-space
   * selection box. Box conventions per target kind:
   * - collider-box / collider-circle: physics ignores Transform scale, and
   *   centers on worldPos + Collider.offset (unscaled, unrotated) — see
   *   packages/runtime/src/physics.ts colliderBox. Extents are the collider's
   *   own width/height/radius*2. The box still carries Transform.rotation so
   *   the rotate handle reads/ghosts consistently across targets (physics
   *   ignores it for these shapes, as does the runtime).
   * - sprite-size: centered on the entity origin, extents scaled by |scale|.
   * - transform-scale: rendered bounds (which may be offset from the origin,
   *   e.g. Tilemap/Text) scaled by |scale|, centered on the bounds center.
   */
  function handleSelection(): { entity: SceneEntity; target: ResolvedHandleTarget; box: SelectionBox } | null {
    const entity = selection ? entityById.get(selection) : undefined;
    if (!entity) return null;
    const b = boundsOf(entity);
    const target = resolveHandleTarget(entity, { w: b.w, h: b.h });
    const tf = entity.components.Transform as { rotation?: number; scale?: Vec2 } | undefined;
    const rotation = tf?.rotation ?? 0;
    const sx = tf?.scale?.x ?? 1;
    const sy = tf?.scale?.y ?? 1;
    const asx = Math.abs(sx) || 1;
    const asy = Math.abs(sy) || 1;
    const wp = worldPos(entity);
    let center: Vec2;
    let width: number;
    let height: number;
    if (target.kind === 'collider-box' || target.kind === 'collider-circle') {
      const off = (entity.components.Collider as { offset?: Vec2 } | undefined)?.offset;
      center = { x: wp.x + (off?.x ?? 0), y: wp.y + (off?.y ?? 0) };
      width = target.width;
      height = target.height;
    } else if (target.kind === 'sprite-size') {
      center = wp;
      width = target.width * asx;
      height = target.height * asy;
    } else {
      // Entity groups render translate → rotate → scale, so the bounds
      // center (a local point) lands at wp + R(rotation)·(scale·center).
      const lx = (b.x + b.w / 2) * sx;
      const ly = (b.y + b.h / 2) * sy;
      const rad = (rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      center = { x: wp.x + lx * cos - ly * sin, y: wp.y + lx * sin + ly * cos };
      width = b.w * asx;
      height = b.h * asy;
    }
    return {
      entity,
      target,
      box: { center, width: Math.max(width, 1), height: Math.max(height, 1), rotation },
    };
  }

  function onHandlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || spaceHeld) return; // pan/context handlers win
    const sel = handleSelection();
    if (!sel) return;
    const point = screenToWorld(screenOf(e));
    // Geometric hit-test (nearest-wins for overlapping handles on tiny
    // boxes); the transparent DOM hit circles only route the event here.
    const id = hitHandle(sel.box, viewRef.current.s, point);
    if (!id) return; // outside the slop: fall through to entity/background
    // A handle grab must never start an entity drag-move or a deselect.
    e.stopPropagation();
    handleDragRef.current = {
      pointerId: e.pointerId,
      entityId: sel.entity.id,
      handleId: id,
      target: sel.target,
      startBox: sel.box,
      startWorld: point,
      moved: false,
    };
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  /**
   * Commit a finished handle gesture. ONE exec() call per gesture ({ quiet:
   * true }, like commitPoints) — so one undo step, always — with values
   * rounded like drag-move (integers; Transform.scale to 2 decimals like
   * roundPoints, since integer scale is useless). Resizes are committed
   * WITHOUT centerShift compensation — i.e. from the center: the history
   * model records one undo entry per command (HearthSession.execute
   * snapshots before every mutating command), so pairing the size command
   * with a moveEntity would make one gesture undo in two steps. See
   * applyCenterHandleDrag, which keeps the ghost consistent with that
   * commit.
   *
   * A CORNER drag on a sprite or box collider edits width AND height, which
   * are two separate scalar schema leaves (there is no vec-shaped size
   * property) — planDragCommit (transformHandles.ts) turns those two
   * commands into a single setProperties batch (Task 2), so even a corner
   * drag commits as one undo step. A single-property drag (edge resize,
   * rotate, circle radius, Transform.scale) still uses the cheaper
   * setComponentProperty directly.
   */
  function commitHandleDrag(hd: HandleDragState, result: DragResult) {
    const clear = () => setHandleGhost(null);
    const entity = entityById.get(hd.entityId);
    if (!sceneId || !entity) {
      clear();
      return;
    }
    const setProp = (property: string, value: unknown) =>
      exec('setComponentProperty', { scene: sceneId, entity: hd.entityId, property, value }, { quiet: true });
    const tf = entity.components.Transform as { rotation?: number; scale?: Vec2 } | undefined;

    if (hd.handleId === 'rotate') {
      if (!tf) {
        clear();
        return;
      }
      const deg = Math.round(result.rotation);
      if (deg === (tf.rotation ?? 0)) {
        clear();
        return;
      }
      void setProp('Transform.rotation', deg).finally(clear);
      return;
    }

    // Which axes this handle edits (corners edit both).
    const editsW = hd.handleId.includes('e') || hd.handleId.includes('w');
    const editsH = hd.handleId.includes('n') || hd.handleId.includes('s');

    if (hd.target.kind === 'collider-circle') {
      // Any handle drags the radius uniformly: take the axis the handle
      // actually moved (dominant change, so corners work too).
      const dw = Math.abs(result.width - hd.startBox.width);
      const dh = Math.abs(result.height - hd.startBox.height);
      const radius = Math.max(1, Math.round((dw >= dh ? result.width : result.height) / 2));
      const current = (entity.components.Collider as { radius?: number } | undefined)?.radius ?? 16;
      if (radius === current) {
        clear();
        return;
      }
      void setProp('Collider.radius', radius).finally(clear);
      return;
    }

    if (hd.target.kind === 'transform-scale') {
      if (!tf) {
        clear();
        return;
      }
      // Scale about the entity origin (the only thing one command can do);
      // base extents are the rendered bounds at scale 1. Signs (flips) are
      // preserved; magnitude is clamped away from 0 so the entity stays
      // recoverable, and rounded to 2 decimals like roundPoints.
      const round2 = (v: number) => Math.round(v * 100) / 100;
      const cur = { x: tf.scale?.x ?? 1, y: tf.scale?.y ?? 1 };
      const mag = (extent: number, base: number) => Math.max(0.01, round2(extent / Math.max(base, 1e-6)));
      const next = {
        x: editsW ? (cur.x < 0 ? -1 : 1) * mag(result.width, hd.target.width) : cur.x,
        y: editsH ? (cur.y < 0 ? -1 : 1) * mag(result.height, hd.target.height) : cur.y,
      };
      if (next.x === cur.x && next.y === cur.y) {
        clear();
        return;
      }
      void setProp('Transform.scale', next).finally(clear);
      return;
    }

    // sprite-size / collider-box. Sprites render scaled by Transform.scale,
    // so world extents divide back to component values; physics ignores
    // scale for box colliders (their width/height ARE world px).
    const comp = hd.target.component;
    const asx = hd.target.kind === 'sprite-size' ? Math.abs(tf?.scale?.x ?? 1) || 1 : 1;
    const asy = hd.target.kind === 'sprite-size' ? Math.abs(tf?.scale?.y ?? 1) || 1 : 1;
    const commands: Array<[string, number]> = [];
    const newW = Math.max(1, Math.round(result.width / asx));
    if (editsW && newW !== Math.round(hd.target.width)) commands.push([`${comp}.width`, newW]);
    const newH = Math.max(1, Math.round(result.height / asy));
    if (editsH && newH !== Math.round(hd.target.height)) commands.push([`${comp}.height`, newH]);
    const plan = planDragCommit(commands);
    if (plan.kind === 'none') {
      clear();
      return;
    }
    if (plan.kind === 'single') {
      void setProp(plan.property, plan.value).finally(clear);
      return;
    }
    void exec(
      'setProperties',
      { scene: sceneId, entity: hd.entityId, properties: plan.properties },
      { quiet: true },
    ).finally(clear);
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
    // A drag must never start (a) while playing — it would mutate the scene
    // under the live run (L-025 / SCENEVIEW-4) — or (b) on a UIElement, whose
    // screen-space position comes from anchor+offset, not Transform.position,
    // so a scene drag would write a value the runtime never reads (L-024).
    // Both still select; the UIElement is edited via the Inspector.
    if (playing || entity.components.UIElement) return;
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
    const hDrag = handleDragRef.current;
    if (hDrag && e.pointerId === hDrag.pointerId) {
      const now = screenOf(e);
      if (!hDrag.moved) {
        // Same dead zone as the entity move drag: ignore sub-half-pixel
        // wiggle so a plain click on a handle commits nothing.
        const world = screenToWorld(now);
        const dx = (world.x - hDrag.startWorld.x) * viewRef.current.s;
        const dy = (world.y - hDrag.startWorld.y) * viewRef.current.s;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        hDrag.moved = true;
      }
      setHandleGhost(
        applyCenterHandleDrag(hDrag.startBox, hDrag.handleId, hDrag.startWorld, screenToWorld(now), {
          shift: e.shiftKey,
        }),
      );
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
      let nx = drag.startLocal.x + dx;
      let ny = drag.startLocal.y + dy;
      // Hold Shift to snap to the drawn 32px grid (L-029 / SCENEVIEW-3). The
      // grid is world-space, so snap the WORLD position and map back through
      // the ancestor offset to the local Transform.position the drag commits.
      if (e.shiftKey) {
        const entity = entityById.get(drag.entityId);
        const off = entity ? ancestorOffset(entity) : { x: 0, y: 0 };
        nx = snapToGrid(nx + off.x) - off.x;
        ny = snapToGrid(ny + off.y) - off.y;
      }
      setDragPos({ x: nx, y: ny });
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
    const hDrag = handleDragRef.current;
    if (hDrag && e.pointerId === hDrag.pointerId) {
      handleDragRef.current = null;
      const result = handleGhostRef.current;
      if (hDrag.moved && result) {
        commitHandleDrag(hDrag, result);
      } else {
        setHandleGhost(null);
      }
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
    let w = sr.width ?? 32;
    let h = sr.height ?? 32;
    // Live resize ghost: while a handle drag targets this sprite, draw the
    // in-progress world extents divided back to component-local size
    // (mirrors the commit math in commitHandleDrag).
    const hd = handleDragRef.current;
    if (handleGhost && hd && hd.entityId === entity.id && hd.target.kind === 'sprite-size') {
      const tf = entity.components.Transform as { scale?: Vec2 } | undefined;
      w = handleGhost.width / (Math.abs(tf?.scale?.x ?? 1) || 1);
      h = handleGhost.height / (Math.abs(tf?.scale?.y ?? 1) || 1);
    }
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

  /**
   * Draws one resolved tile visual (see ../tileAutotileVisual.ts): the whole
   * image for a plain asset id, a cropped `<image>` for an autotile frame
   * (nested `<svg>` whose viewBox is the frame's own pixel rect, sized via
   * the sheet's metadata.width/height — same numbers Assets panel/Slice
   * dialog previews use, see ../assetPreview.ts's readSheetSize), or the
   * same gray placeholder renderTilemap has always shown for an
   * unresolved/missing asset.
   */
  function renderTileVisual(visual: TileVisual | null, x: number, y: number, size: number, key: string): React.ReactNode {
    const asset = visual ? assetById.get(visual.assetId) : undefined;
    const placeholder = (
      <rect
        key={key}
        x={x}
        y={y}
        width={size}
        height={size}
        fill="oklch(0.5 0.02 55)"
        stroke="oklch(0.35 0.02 55)"
        strokeWidth={1}
      />
    );
    if (!visual || !asset || !projectPath) return placeholder;
    const href = fileUrl(projectPath, asset.path);
    if (!visual.frame) {
      return <image key={key} href={href} x={x} y={y} width={size} height={size} preserveAspectRatio="none" />;
    }
    const sheetSize = readSheetSize(asset);
    if (!sheetSize) return placeholder; // sheet metadata missing/malformed — can't crop correctly
    const { frame } = visual;
    return (
      <svg
        key={key}
        x={x}
        y={y}
        width={size}
        height={size}
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        preserveAspectRatio="none"
      >
        <image
          href={href}
          x={-frame.x}
          y={-frame.y}
          width={sheetSize.width}
          height={sheetSize.height}
          preserveAspectRatio="none"
        />
      </svg>
    );
  }

  function renderTilemap(entity: SceneEntity): React.ReactNode {
    const tm = entity.components.Tilemap as TilemapComponent | undefined;
    if (!tm) return null;
    const size = tm.tileSize > 0 ? tm.tileSize : 32;
    const grid: string[] = Array.isArray(tm.grid) ? tm.grid : [];
    const tileAssets = (tm.tileAssets ?? {}) as Record<string, TileAsset>;
    const cells: React.ReactNode[] = [];
    grid.forEach((row: string, ry: number) => {
      [...row].forEach((ch, cx) => {
        if (ch === '.' || ch === ' ') return;
        const visual = resolveTileVisual(grid, ry, cx, tileAssets, assetById);
        cells.push(renderTileVisual(visual, cx * size, ry * size, size, `${cx}-${ry}`));
      });
    });
    return <g>{cells}</g>;
  }

  /** A freehand stroke resolves real autotile frames up to this many painted cells (not eraser cells — nothing to resolve there); a longer drag falls back to the plain highlight instead of paying a per-cell mask lookup on every pointer move. Rect-mode fill (up to 1024×1024 cells) always uses the plain single-rect preview, never per-cell resolution. */
  const FREEHAND_AUTOTILE_PREVIEW_CAP = 200;

  /**
   * Live feedback for an in-progress tilemap paint stroke: highlighted cells
   * for a freehand stroke, or a translucent rect for a shift-drag fill.
   * Drawn in the same local space as renderTilemap (cx*size / ry*size)
   * inside the same entity group, only for the entity currently being
   * painted.
   *
   * A freehand stroke additionally resolves each cell's actual autotile
   * frame (against a tentative grid with the stroke's own cells overlaid —
   * see overlayStrokeCells — so neighbours within the same stroke react to
   * each other) when that's cheap; see FREEHAND_AUTOTILE_PREVIEW_CAP. Tiles
   * already on the map adjacent to the stroke keep showing their current
   * committed appearance until the stroke actually commits.
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
    const cells = paintPreview.cells;
    const paintingCells = cells.filter((c) => c.char !== ERASER_CHAR);
    const tentativeGrid =
      paintingCells.length > 0 && paintingCells.length <= FREEHAND_AUTOTILE_PREVIEW_CAP
        ? overlayStrokeCells(tm.grid, paintingCells)
        : null;
    const tileAssets = (tm.tileAssets ?? {}) as Record<string, TileAsset>;
    return (
      <g pointerEvents="none">
        {cells.map((c) => {
          const isErase = c.char === ERASER_CHAR;
          const visual = !isErase && tentativeGrid ? resolveTileVisual(tentativeGrid, c.y, c.x, tileAssets, assetById) : null;
          return (
            <g key={`${c.x}-${c.y}`}>
              {visual && renderTileVisual(visual, c.x * size, c.y * size, size, `preview-${c.x}-${c.y}`)}
              <rect
                x={c.x * size}
                y={c.y * size}
                width={size}
                height={size}
                fill={isErase ? 'none' : 'var(--accent)'}
                fillOpacity={isErase ? 0.06 : visual ? 0.18 : 0.32}
                stroke="var(--accent)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
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
          fill={cam.backgroundColor ?? '#111116'}
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
    // Live vertex drag: draw the draft geometry (same local space as lr.points)
    // so the real stroke tracks the orange guide instead of showing the stale
    // pre-drag shape underneath — removes the double-image on thick lines
    // (L-030 / SCENEVIEW-5).
    const draft =
      draggingVertex && entity.id === selection && draftPoints && pointsSourceFor(entity)?.component === 'LineRenderer'
        ? draftPoints
        : null;
    const points: Vec2[] = draft ?? (Array.isArray(lr.points) ? lr.points : []);
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

  /**
   * Live editor-only preview for the selected entity's ParticleEmitter (see
   * particlePreview.ts): one SVG circle per surviving particle, sized/colored
   * by start→end interpolation exactly like packages/runtime/src/pixi/index.ts's
   * updateParticles (see particleVisual). Particle x/y are world-space, so
   * they're offset by -worldPos here since this renders inside the entity's
   * `<g transform="translate(wp.x wp.y)">` (world position only, unrotated/
   * unscaled — same group renderParticleGizmo uses, for the same reason).
   * Takes the already-fetched `particles` snapshot (rather than re-reading
   * it via getPreviewParticles) so the call site can decide, from the same
   * snapshot, whether to render this at all vs. fall back to the static
   * cone gizmo (see the zero-particle fallback at the call site below).
   */
  function renderLiveParticles(entity: SceneEntity, particles: readonly Particle[]): React.ReactNode {
    const pe = entity.components.ParticleEmitter as ParticleEmitterComponent | undefined;
    if (!pe) return null;
    const wp = worldPos(entity);
    return (
      <g pointerEvents="none">
        {particles.map((p, i) => {
          const visual = particleVisual(p, pe);
          if (!visual) return null;
          return (
            <circle
              key={i}
              cx={visual.x - wp.x}
              cy={visual.y - wp.y}
              r={visual.radius}
              fill={visual.color}
              fillOpacity={visual.alpha}
            />
          );
        })}
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
      onPointerEnter={() => {
        hoverRef.current = true;
      }}
      onPointerLeave={() => {
        hoverRef.current = false;
      }}
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
            let rot = tf?.rotation ?? 0;
            let sx = tf?.scale?.x ?? 1;
            let sy = tf?.scale?.y ?? 1;
            const b = boundsOf(entity);
            // Live rotate/scale ghost for an in-progress handle drag (the
            // sprite-size ghost lives in renderSprite instead).
            const hd = handleDragRef.current;
            if (handleGhost && hd && hd.entityId === entity.id) {
              rot = handleGhost.rotation;
              if (hd.target.kind === 'transform-scale') {
                if (b.w > 0) sx = (sx < 0 ? -1 : 1) * (handleGhost.width / b.w);
                if (b.h > 0) sy = (sy < 0 ? -1 : 1) * (handleGhost.height / b.h);
              }
            }
            return (
              <g
                key={entity.id}
                transform={`translate(${wp.x} ${wp.y})`}
                opacity={entity.enabled ? 1 : 0.35}
                style={{
                  cursor:
                    spaceHeld || editingPoints || (paintMode && entity.id !== selection)
                      ? undefined
                      : paintMode
                        ? 'crosshair'
                        : entity.components.UIElement
                          ? 'default' // screen-space UI isn't scene-draggable (L-024)
                          : 'move',
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
                    entity's own rotation/scale — see their render fns for why.
                    The selected entity's emitter swaps the static cone gizmo
                    for the always-on live preview while it's actually active
                    (Scene panel visible) AND currently has live particles to
                    show; every other emitter, the selected one when the panel
                    is hidden, and the selected one when the preview IS active
                    but has zero live particles right now (rate 0 + burst 0, or
                    the runtime chunk hasn't finished its async import yet) all
                    keep the cone gizmo, so the emitter is never simply
                    invisible. The old floating "Particles" toggle was removed
                    (L-027); preview is now object-owned per selection. */}
                {renderLightGizmo(entity)}
                {(() => {
                  const liveParticles =
                    entity.id === selection && panelVisible
                      ? particlePreview.getPreviewParticles(entity.id)
                      : null;
                  return liveParticles && liveParticles.length > 0
                    ? renderLiveParticles(entity, liveParticles)
                    : renderParticleGizmo(entity);
                })()}
              </g>
            );
          })}

          {/* selection outline, drawn on top (the gizmo box replaces it
              while a handle drag's ghost is live — boundsOf still reads the
              un-committed component values, so the outline would lag) */}
          {selectedEntity &&
            !handleGhost &&
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

          {/* transform handles: resize/rotate gizmo on the selection. Drawn
              last (topmost), so a grab always beats the entity drag-move and
              background hit-tests underneath. */}
          {showHandles &&
            (() => {
              const sel = handleSelection();
              if (!sel) return null;
              const hd = handleDragRef.current;
              // Live ghost: same center (resizes are center-anchored, see
              // applyCenterHandleDrag), in-progress extents/rotation.
              const box: SelectionBox =
                handleGhost && hd
                  ? {
                      center: hd.startBox.center,
                      width: handleGhost.width,
                      height: handleGhost.height,
                      rotation: handleGhost.rotation,
                    }
                  : sel.box;
              const positions = handlePositions(box, view.s);
              const rotatePos = positions.find((p) => p.id === 'rotate')!;
              const nPos = positions.find((p) => p.id === 'n')!;
              const r = 4 / view.s; // 8px squares on screen, like the vertex handles
              const hit = 10 / view.s; // matches hitHandle's HIT_RADIUS_PX slop
              return (
                <g>
                  {/* target box outline (doubles as the resize ghost; a
                      circle collider shows its true circle) */}
                  <g
                    transform={`translate(${box.center.x} ${box.center.y}) rotate(${box.rotation})`}
                    pointerEvents="none"
                  >
                    {sel.target.kind === 'collider-circle' ? (
                      <circle
                        r={box.width / 2}
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : null}
                    <rect
                      x={-box.width / 2}
                      y={-box.height / 2}
                      width={box.width}
                      height={box.height}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={1.5}
                      strokeDasharray={sel.target.kind === 'collider-circle' ? '4 3' : undefined}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                  <line
                    x1={nPos.x}
                    y1={nPos.y}
                    x2={rotatePos.x}
                    y2={rotatePos.y}
                    stroke="var(--accent)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                  {positions.map((h) => (
                    <g
                      key={h.id}
                      className="transform-handle"
                      style={{ cursor: cursorFor(h.id, box.rotation) }}
                      onPointerDown={onHandlePointerDown}
                    >
                      <circle cx={h.x} cy={h.y} r={hit} fill="transparent" stroke="none" />
                      {h.id === 'rotate' ? (
                        <circle
                          cx={h.x}
                          cy={h.y}
                          r={r}
                          className="transform-handle-rotate-dot"
                          vectorEffect="non-scaling-stroke"
                        />
                      ) : (
                        <rect
                          x={h.x - r}
                          y={h.y - r}
                          width={r * 2}
                          height={r * 2}
                          transform={`rotate(${box.rotation} ${h.x} ${h.y})`}
                          className="transform-handle-dot"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
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
            <Button variant="primary" size="sm" onClick={exitPointEditing}>
              Done
            </Button>
          ) : (
            <Tooltip content="Edit collider / line points in the scene">
              <Button
                size="sm"
                onClick={() => {
                  if (paintMode) exitPaintMode();
                  setEditingPoints(true);
                }}
              >
                Edit points
              </Button>
            </Tooltip>
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

      {selectedEntity?.components.UIElement && (
        // UIElement entities are screen-space: their position comes from
        // anchor + offset (Inspector), not a scene drag (L-024). A one-line,
        // selection-scoped hint — not persistent chrome (the always-on hint
        // bar was removed per JAKE-STEER, L-026).
        <div className="scene-selection-hint">Position via anchor + offset in the Inspector</div>
      )}

      <div className="scene-hud">
        <span>{Math.round(view.s * 100)}%</span>
        {selectedEntity && (
          <span>
            {Math.round(worldPos(selectedEntity).x)}, {Math.round(worldPos(selectedEntity).y)}
          </span>
        )}
      </div>
    </div>
  );
}
