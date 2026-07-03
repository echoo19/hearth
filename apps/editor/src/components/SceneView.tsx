/**
 * Scene view: an SVG rendering of the scene JSON with grid, pan/zoom,
 * click-select, and drag-to-move (drag release posts a moveEntity command).
 * This is deliberately not the game runtime — it draws the authored data.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import { fileUrl } from '../api';
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

  function setDragPos(pos: Vec2 | null) {
    dragPosRef.current = pos;
    setDragPosState(pos);
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

  // ---- pointer handlers ----------------------------------------------------
  function screenOf(e: React.PointerEvent): Vec2 {
    const rect = hostRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      panRef.current = { pointerId: e.pointerId, start: screenOf(e), startView: viewRef.current };
      svgRef.current?.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else if (e.button === 0) {
      select(null);
    }
  }

  function onEntityPointerDown(e: React.PointerEvent, entity: SceneEntity) {
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
    const drag = dragRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      const now = screenOf(e);
      const dx = (now.x - drag.startScreen.x) / viewRef.current.s;
      const dy = (now.y - drag.startScreen.y) / viewRef.current.s;
      if (!drag.moved && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      drag.moved = true;
      setDragPos({ x: drag.startLocal.x + dx, y: drag.startLocal.y + dy });
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (panRef.current && e.pointerId === panRef.current.pointerId) {
      panRef.current = null;
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

  function renderCameraGizmo(entity: SceneEntity): React.ReactNode {
    const cam = entity.components.Camera as any;
    if (!cam || !info) return null;
    const zoom = cam.zoom > 0 ? cam.zoom : 1;
    const w = info.buildSettings.width / zoom;
    const h = info.buildSettings.height / zoom;
    return (
      <g>
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
    const m = 24;
    return { x: -m / 2, y: -m / 2, w: m, h: m };
  }

  function layerOf(entity: SceneEntity): number {
    const sr = entity.components.SpriteRenderer as any;
    const t = entity.components.Text as any;
    const tm = entity.components.Tilemap as any;
    return (tm?.layer ?? sr?.layer ?? t?.layer ?? 0) as number;
  }

  const sorted = useMemo(() => {
    const entities = [...(scene?.entities ?? [])];
    entities.sort((a, b) => layerOf(a) - layerOf(b));
    return entities;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  const selectedEntity = selection ? entityById.get(selection) : undefined;

  return (
    <div ref={hostRef} className={`scene-view${spaceHeld ? ' panning' : ''}`}>
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
                style={{ cursor: spaceHeld ? undefined : 'move' }}
                onPointerDown={(e) => onEntityPointerDown(e, entity)}
              >
                <g transform={`rotate(${rot}) scale(${sx} ${sy})`}>
                  {renderTilemap(entity)}
                  {renderSprite(entity)}
                  {renderText(entity)}
                  {renderCameraGizmo(entity)}
                  {/* hit area */}
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="transparent" stroke="none" />
                </g>
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
        </g>
      </svg>

      <div className="scene-hud">
        <span>{Math.round(view.s * 100)}%</span>
        {selectedEntity && (
          <span>
            {Math.round(worldPos(selectedEntity).x)}, {Math.round(worldPos(selectedEntity).y)}
          </span>
        )}
      </div>
      <div className="scene-hint">scroll to zoom · space+drag or middle-drag to pan · drag an entity to move it</div>
    </div>
  );
}
