/**
 * Grid A* pathfinding — pure data logic shared by the inspectPath command
 * (authored scenes) and ctx.scene.findPath (live runtime state). No runtime
 * dependency; deterministic: fixed neighbor order N,E,S,W,NE,SE,SW,NW,
 * ties broken by (f, then g, then insertion sequence).
 */
import type { ColliderComponent, TilemapComponent, Vec2 } from './schema/components.js';

export interface NavRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NavGrid {
  cellSize: number;
  originX: number;
  originY: number;
  cols: number;
  rows: number;
  solid: Uint8Array;
}

export interface NavEntityInput {
  position: Vec2;
  transform?: { rotation: number; scale: Vec2 };
  collider?: ColliderComponent;
  tilemap?: TilemapComponent;
  bodyType: 'dynamic' | 'static' | 'kinematic';
}

const MAX_GRID = 512;
const SOLID_OVERLAP_FRACTION = 0.01;

/** Axis-aligned bounds of a (possibly rotated/scaled) collider, in world px. */
function colliderAabb(
  collider: ColliderComponent,
  pos: Vec2,
  transform?: { rotation: number; scale: Vec2 },
): NavRect | null {
  if (collider.shape === 'box') {
    return {
      x: pos.x + collider.offset.x - collider.width / 2,
      y: pos.y + collider.offset.y - collider.height / 2,
      width: collider.width,
      height: collider.height,
    };
  }
  if (collider.shape === 'circle') {
    return {
      x: pos.x + collider.offset.x - collider.radius,
      y: pos.y + collider.offset.y - collider.radius,
      width: collider.radius * 2,
      height: collider.radius * 2,
    };
  }
  // polygon: local points → scale → rotate (degrees) → translate by pos+offset,
  // identical math to colliderShape in packages/runtime/src/physics.ts.
  if (collider.points.length < 3) return null;
  const cx = pos.x + collider.offset.x;
  const cy = pos.y + collider.offset.y;
  const rad = ((transform?.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = transform?.scale.x ?? 1;
  const sy = transform?.scale.y ?? 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of collider.points) {
    const x = p.x * sx;
    const y = p.y * sy;
    const wx = cx + x * cos - y * sin;
    const wy = cy + x * sin + y * cos;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy;
    if (wy > maxY) maxY = wy;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function collectNavSolids(entities: NavEntityInput[]): { cellSize: number; solids: NavRect[] } {
  let cellSize = 32;
  for (const e of entities) {
    if (e.tilemap?.solid) {
      cellSize = e.tilemap.tileSize;
      break;
    }
  }

  const solids: NavRect[] = [];
  for (const e of entities) {
    // Solid tilemaps are obstacles regardless of body type, matching the
    // runtime's stepPhysics (tilemapBoxes are added unconditionally).
    if (e.tilemap?.solid) {
      const ts = e.tilemap.tileSize;
      for (let row = 0; row < e.tilemap.grid.length; row++) {
        const line = e.tilemap.grid[row];
        for (let col = 0; col < line.length; col++) {
          const ch = line[col];
          if (ch === '.' || ch === ' ') continue;
          solids.push({
            x: e.position.x + col * ts,
            y: e.position.y + row * ts,
            width: ts,
            height: ts,
          });
        }
      }
    }

    // Colliders on dynamic/kinematic bodies are movers, never obstacles.
    if (e.bodyType === 'static' && e.collider && !e.collider.isTrigger) {
      const rect = colliderAabb(e.collider, e.position, e.transform);
      if (rect) solids.push(rect);
    }
  }

  return { cellSize, solids };
}

export function buildNavGrid(opts: { cellSize: number; solids: NavRect[]; include?: Vec2[] }): NavGrid {
  const { cellSize, solids } = opts;
  const include = opts.include ?? [];

  if (solids.length === 0 && include.length === 0) {
    return { cellSize, originX: 0, originY: 0, cols: 1, rows: 1, solid: new Uint8Array(1) };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of solids) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  for (const p of include) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  // Snap bounds outward to cellSize multiples first so cell centers stay
  // aligned to a consistent world grid, then pad by 2 cells on every side.
  const snappedMinX = Math.floor(minX / cellSize) * cellSize;
  const snappedMinY = Math.floor(minY / cellSize) * cellSize;
  const snappedMaxX = Math.ceil(maxX / cellSize) * cellSize;
  const snappedMaxY = Math.ceil(maxY / cellSize) * cellSize;

  const originX = snappedMinX - 2 * cellSize;
  const originY = snappedMinY - 2 * cellSize;
  const boundMaxX = snappedMaxX + 2 * cellSize;
  const boundMaxY = snappedMaxY + 2 * cellSize;

  const cols = Math.ceil((boundMaxX - originX) / cellSize);
  const rows = Math.ceil((boundMaxY - originY) / cellSize);

  if (cols > MAX_GRID || rows > MAX_GRID) {
    throw new Error(`nav grid too large: ${cols}x${rows} cells (max 512x512)`);
  }

  const solid = new Uint8Array(cols * rows);
  for (const r of solids) {
    const rx0 = r.x;
    const rx1 = r.x + r.width;
    const ry0 = r.y;
    const ry1 = r.y + r.height;

    const colMin = Math.max(0, Math.floor((rx0 - originX) / cellSize));
    const colMax = Math.min(cols - 1, Math.floor((rx1 - originX) / cellSize));
    const rowMin = Math.max(0, Math.floor((ry0 - originY) / cellSize));
    const rowMax = Math.min(rows - 1, Math.floor((ry1 - originY) / cellSize));

    for (let row = rowMin; row <= rowMax; row++) {
      const cellY0 = originY + row * cellSize;
      const cellY1 = cellY0 + cellSize;
      const overlapY = Math.min(ry1, cellY1) - Math.max(ry0, cellY0);
      if (overlapY <= 0) continue;
      for (let col = colMin; col <= colMax; col++) {
        const cellX0 = originX + col * cellSize;
        const cellX1 = cellX0 + cellSize;
        const overlapX = Math.min(rx1, cellX1) - Math.max(rx0, cellX0);
        if (overlapX <= 0) continue;
        const area = overlapX * overlapY;
        if (area > SOLID_OVERLAP_FRACTION * cellSize * cellSize) {
          solid[row * cols + col] = 1;
        }
      }
    }
  }

  return { cellSize, originX, originY, cols, rows, solid };
}

// Fixed neighbor order: N, E, S, W, then (if diagonals) NE, SE, SW, NW.
const ORTHO_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const DIAG_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

interface HeapNode {
  f: number;
  g: number;
  seq: number;
  index: number;
}

/** Binary min-heap ordered by (f, then g, then insertion sequence). */
class MinHeap {
  private items: HeapNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: HeapNode): void {
    this.items.push(node);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): HeapNode | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as HeapNode;
    if (items.length > 0) {
      items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private less(a: HeapNode, b: HeapNode): boolean {
    if (a.f !== b.f) return a.f < b.f;
    if (a.g !== b.g) return a.g < b.g;
    return a.seq < b.seq;
  }

  private bubbleUp(start: number): void {
    let i = start;
    const items = this.items;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i], items[parent])) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  private bubbleDown(start: number): void {
    let i = start;
    const items = this.items;
    const n = items.length;
    for (;;) {
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      let smallest = i;
      if (l < n && this.less(items[l], items[smallest])) smallest = l;
      if (r < n && this.less(items[r], items[smallest])) smallest = r;
      if (smallest === i) break;
      [items[i], items[smallest]] = [items[smallest], items[i]];
      i = smallest;
    }
  }
}

export function findPath(grid: NavGrid, from: Vec2, to: Vec2, opts?: { diagonals?: boolean }): Vec2[] | null {
  const diagonals = opts?.diagonals ?? false;
  const { cellSize, originX, originY, cols, rows, solid } = grid;

  const toCol = (p: Vec2) => Math.floor((p.x - originX) / cellSize);
  const toRow = (p: Vec2) => Math.floor((p.y - originY) / cellSize);
  const inBounds = (col: number, row: number) => col >= 0 && col < cols && row >= 0 && row < rows;
  const isWalkable = (col: number, row: number) => inBounds(col, row) && solid[row * cols + col] === 0;
  const cellCenter = (col: number, row: number): Vec2 => ({
    x: originX + (col + 0.5) * cellSize,
    y: originY + (row + 0.5) * cellSize,
  });

  const startCol = toCol(from);
  const startRow = toRow(from);
  const goalCol = toCol(to);
  const goalRow = toRow(to);

  if (!isWalkable(startCol, startRow) || !isWalkable(goalCol, goalRow)) return null;

  if (startCol === goalCol && startRow === goalRow) {
    return [cellCenter(goalCol, goalRow)];
  }

  const heuristic = (col: number, row: number): number => {
    const dx = Math.abs(col - goalCol);
    const dy = Math.abs(row - goalRow);
    if (!diagonals) return dx + dy;
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };

  const neighbors = diagonals ? [...ORTHO_NEIGHBORS, ...DIAG_NEIGHBORS] : ORTHO_NEIGHBORS;

  const cellCount = cols * rows;
  const gScore = new Float64Array(cellCount).fill(Infinity);
  const cameFrom = new Int32Array(cellCount).fill(-1);
  const closed = new Uint8Array(cellCount);

  const startIndex = startRow * cols + startCol;
  const goalIndex = goalRow * cols + goalCol;

  gScore[startIndex] = 0;
  const heap = new MinHeap();
  let seq = 0;
  heap.push({ f: heuristic(startCol, startRow), g: 0, seq: seq++, index: startIndex });

  while (heap.size > 0) {
    const current = heap.pop() as HeapNode;
    if (closed[current.index]) continue;
    if (current.index === goalIndex) {
      const path: Vec2[] = [];
      let idx: number = current.index;
      while (idx !== -1) {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        path.push(cellCenter(col, row));
        idx = cameFrom[idx];
      }
      path.reverse();
      return path;
    }
    closed[current.index] = 1;

    const col = current.index % cols;
    const row = Math.floor(current.index / cols);

    for (let n = 0; n < neighbors.length; n++) {
      const [dx, dy] = neighbors[n];
      const isDiagonal = dx !== 0 && dy !== 0;
      const ncol = col + dx;
      const nrow = row + dy;
      if (!isWalkable(ncol, nrow)) continue;
      if (isDiagonal && (!isWalkable(col + dx, row) || !isWalkable(col, row + dy))) {
        // No corner cutting: both orthogonal neighbors must be walkable.
        continue;
      }
      const nIndex = nrow * cols + ncol;
      if (closed[nIndex]) continue;

      const stepCost = isDiagonal ? Math.SQRT2 : 1;
      const tentativeG = current.g + stepCost;
      if (tentativeG < gScore[nIndex]) {
        gScore[nIndex] = tentativeG;
        cameFrom[nIndex] = current.index;
        const f = tentativeG + heuristic(ncol, nrow);
        heap.push({ f, g: tentativeG, seq: seq++, index: nIndex });
      }
    }
  }

  return null;
}
