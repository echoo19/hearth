import { z } from 'zod';
import { defineCommand } from './types.js';
import { findEntity } from '../schema/scene.js';
import {
  COMPONENT_SCHEMAS,
  TILEMAP_MAX_DIM,
  AutotileRuleSchema,
  type TilemapComponent,
} from '../schema/components.js';
import { getSheetFrames, findSheetFrame } from '../assets/sheetFrames.js';
import { resolvedMapping, AUTOTILE_SHAPES } from '../tilemap/autotile.js';
import { ProjectError } from '../project/store.js';

import type { Entity, Scene } from '../schema/scene.js';
import type { CommandContext } from './types.js';

const CellSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  /** A single character: "." / " " (empty) or a key of the Tilemap's tileAssets. */
  char: z.string(),
});

interface Cell {
  x: number;
  y: number;
  char: string;
}

function resolveTilemap(
  ctx: CommandContext,
  sceneRef: string,
  entityRef: string,
): { scene: Scene; entity: Entity; tilemap: TilemapComponent } {
  const scene = ctx.store.getScene(sceneRef);
  if (!scene) throw new ProjectError(`Scene not found: ${sceneRef}`, 'NOT_FOUND');
  const entity = findEntity(scene, entityRef);
  if (!entity) {
    throw new ProjectError(`Entity not found in scene "${scene.name}": ${entityRef}`, 'NOT_FOUND');
  }
  const tilemap = entity.components.Tilemap;
  if (!tilemap) {
    throw new ProjectError(
      `Entity "${entity.name}" has no Tilemap component. Add it first with addComponent.`,
      'NO_TILEMAP',
    );
  }
  return { scene, entity, tilemap };
}

function assertValidChar(char: string, tilemap: TilemapComponent): void {
  if (typeof char !== 'string' || char.length !== 1) {
    throw new ProjectError(
      `Invalid tile char "${char}": must be exactly one character.`,
      'INVALID_TILE_CHAR',
    );
  }
  const isEmpty = char === '.' || char === ' ';
  if (!isEmpty && !Object.prototype.hasOwnProperty.call(tilemap.tileAssets, char)) {
    const keys = Object.keys(tilemap.tileAssets);
    throw new ProjectError(
      `Invalid tile char "${char}": must be "." or " " (empty), or one of the tileAssets keys` +
        (keys.length > 0 ? `: ${keys.join(', ')}` : ' (this Tilemap has no tileAssets yet)') +
        '.',
      'INVALID_TILE_CHAR',
    );
  }
}

function assertInBounds(x: number, y: number, tilemap: TilemapComponent, ctx: CommandContext): void {
  const rowLen = tilemap.grid[y]?.length;
  if (y < 0 || y >= tilemap.grid.length || rowLen === undefined || x < 0 || x >= rowLen) {
    ctx.suggest('resizeTilemap');
    throw new ProjectError(
      `Cell (${x}, ${y}) is out of bounds for this tilemap (${tilemap.grid.length} rows` +
        (rowLen !== undefined ? `, row ${y} is ${rowLen} wide` : '') +
        `). Use resizeTilemap to grow the grid first.`,
      'TILE_OUT_OF_BOUNDS',
    );
  }
}

/**
 * Validates every cell first (so a batch either fully applies or not at
 * all), then rebuilds only the affected row strings from a char-array
 * working copy and returns a brand-new grid array — never mutates
 * `tilemap.grid` or any of its row strings in place, which is what lets the
 * runtime's tilemap collider cache (keyed on grid array identity) detect
 * the change.
 */
function paintCells(tilemap: TilemapComponent, cells: Cell[], ctx: CommandContext): string[] {
  for (const cell of cells) {
    assertValidChar(cell.char, tilemap);
    assertInBounds(cell.x, cell.y, tilemap, ctx);
  }
  const rows = tilemap.grid.map((row) => row.split(''));
  for (const cell of cells) {
    rows[cell.y][cell.x] = cell.char;
  }
  return rows.map((chars) => chars.join(''));
}

function writeGrid(entity: Entity, tilemap: TilemapComponent, grid: string[]): TilemapComponent {
  const clone = structuredClone(tilemap);
  clone.grid = grid;
  const parsed = COMPONENT_SCHEMAS.Tilemap.safeParse(clone);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ProjectError(`Invalid tilemap: ${issues}`, 'SCHEMA_ERROR');
  }
  entity.components.Tilemap = parsed.data as TilemapComponent;
  return entity.components.Tilemap;
}

export const paintTiles = defineCommand({
  name: 'paintTiles',
  description:
    'Paint a batch of tile cells onto a Tilemap component in a single undo step, e.g. ' +
    'cells=[{x:0,y:0,char:"G"}]. x is the column, y is the row (0-based, row 0 = the top of the grid). ' +
    'char must be "." / " " (empty) or a key of the Tilemap\'s tileAssets.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    cells: z.array(CellSchema).min(1),
  }),
  async run(ctx, params) {
    const { scene, entity, tilemap } = resolveTilemap(ctx, params.scene, params.entity);
    const grid = paintCells(tilemap, params.cells, ctx);
    writeGrid(entity, tilemap, grid);
    ctx.changed({ kind: 'component', id: entity.id, name: 'Tilemap', scene: scene.id, action: 'modified' });
    return { painted: params.cells.length };
  },
});

export const fillTilemapRect = defineCommand({
  name: 'fillTilemapRect',
  description:
    'Fill a rectangular region of a Tilemap with one tile char in a single undo step. ' +
    'x/y is the top-left corner (column/row, 0-based). char must be "." / " " (empty) or a key of tileAssets.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive().max(TILEMAP_MAX_DIM),
    height: z.number().int().positive().max(TILEMAP_MAX_DIM),
    char: z.string(),
  }),
  async run(ctx, params) {
    const { scene, entity, tilemap } = resolveTilemap(ctx, params.scene, params.entity);

    // Validate the rect against the grid's actual bounds BEFORE enumerating cells.
    const rectRight = params.x + params.width;
    const rectBottom = params.y + params.height;

    if (params.y < 0 || params.y >= tilemap.grid.length) {
      ctx.suggest('resizeTilemap');
      throw new ProjectError(
        `Rect starts at y=${params.y}, which is out of bounds for this tilemap (${tilemap.grid.length} rows). ` +
          'Use resizeTilemap to grow the grid first.',
        'TILE_OUT_OF_BOUNDS',
      );
    }

    if (rectBottom > tilemap.grid.length) {
      ctx.suggest('resizeTilemap');
      throw new ProjectError(
        `Rect extends to y=${rectBottom - 1} (bottom edge at y=${rectBottom}), which exceeds the tilemap's ` +
          `${tilemap.grid.length} rows. Use resizeTilemap to grow the grid first.`,
        'TILE_OUT_OF_BOUNDS',
      );
    }

    // Check x bounds for every row the rect touches.
    for (let row = params.y; row < rectBottom; row++) {
      const rowLen = tilemap.grid[row].length;
      if (params.x < 0 || params.x >= rowLen || rectRight > rowLen) {
        ctx.suggest('resizeTilemap');
        throw new ProjectError(
          `Rect at row y=${row} extends from x=${params.x} to x=${rectRight - 1} (right edge at x=${rectRight}), ` +
            `but that row is only ${rowLen} wide. Use resizeTilemap to grow the grid first.`,
          'TILE_OUT_OF_BOUNDS',
        );
      }
    }

    const cells: Cell[] = [];
    for (let row = params.y; row < params.y + params.height; row++) {
      for (let col = params.x; col < params.x + params.width; col++) {
        cells.push({ x: col, y: row, char: params.char });
      }
    }
    const grid = paintCells(tilemap, cells, ctx);
    writeGrid(entity, tilemap, grid);
    ctx.changed({ kind: 'component', id: entity.id, name: 'Tilemap', scene: scene.id, action: 'modified' });
    return { painted: cells.length };
  },
});

/** Re-parse and store a Tilemap after mutating a non-grid field (e.g. tileAssets). */
function writeTilemap(entity: Entity, next: TilemapComponent): TilemapComponent {
  const parsed = COMPONENT_SCHEMAS.Tilemap.safeParse(next);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ProjectError(`Invalid tilemap: ${issues}`, 'SCHEMA_ERROR');
  }
  entity.components.Tilemap = parsed.data as TilemapComponent;
  return entity.components.Tilemap;
}

export const setTileAutotile = defineCommand({
  name: 'setTileAutotile',
  description:
    'Bind a Tilemap tile char to an autotile rule: the char\'s per-cell sheet frame is chosen from its 8 ' +
    'neighbours at render time (blob47 47-shape standard). sheet must be a sliced spritesheet asset whose ' +
    'frames follow the template naming (blob_<shapeKey>); pass mapping to override individual shape keys with ' +
    'custom frame names. Pass clear:true to remove an existing rule for char instead. This replaces whatever ' +
    'tileAssets entry the char had (plain asset id or prior rule).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    /** A single non-empty tile char (not "." or " "). */
    char: z.string(),
    /** Spritesheet asset id or name. Required unless clear is set. */
    sheet: z.string().min(1).optional(),
    template: z.literal('blob47').default('blob47'),
    /** Shape-key -> frame-name overrides; shape keys are canonical blob47 masks as strings. */
    mapping: z.record(z.string(), z.string()).optional(),
    /** Remove the char's autotile rule instead of setting one. */
    clear: z.boolean().optional(),
  }),
  async run(ctx, params) {
    const { scene, entity, tilemap } = resolveTilemap(ctx, params.scene, params.entity);

    if (typeof params.char !== 'string' || params.char.length !== 1) {
      throw new ProjectError(
        `Invalid tile char "${params.char}": must be exactly one character.`,
        'INVALID_TILE_CHAR',
      );
    }
    if (params.char === '.' || params.char === ' ') {
      throw new ProjectError(
        `Tile char "${params.char}" is reserved for empty cells and cannot have an autotile rule.`,
        'INVALID_TILE_CHAR',
      );
    }

    const next = structuredClone(tilemap);

    if (params.clear) {
      if (!Object.prototype.hasOwnProperty.call(next.tileAssets, params.char)) {
        throw new ProjectError(
          `Tile char "${params.char}" has no tileAssets entry to clear.`,
          'NOT_FOUND',
        );
      }
      delete next.tileAssets[params.char];
      writeTilemap(entity, next);
      ctx.changed({ kind: 'component', id: entity.id, name: 'Tilemap', scene: scene.id, action: 'modified' });
      return { entityId: entity.id, char: params.char, cleared: true };
    }

    if (!params.sheet) {
      throw new ProjectError('setTileAutotile requires a sheet (unless clear is set).', 'INVALID_INPUT');
    }

    // Reject mapping keys that are not real blob47 shape keys — otherwise they
    // would sit in the rule doing nothing (resolveTileFrame never reads them).
    if (params.mapping) {
      const unknown = Object.keys(params.mapping).filter((k) => !AUTOTILE_SHAPES.includes(k));
      if (unknown.length > 0) {
        throw new ProjectError(
          `Unknown autotile shape key(s) in mapping: ${unknown.join(', ')}. Shape keys are canonical ` +
            'blob47 neighbour masks as strings (0..255); see AUTOTILE_SHAPES.',
          'INVALID_INPUT',
        );
      }
    }

    const sheet = ctx.store.getAsset(params.sheet);
    if (!sheet || getSheetFrames(sheet).length === 0) {
      throw new ProjectError(
        `Spritesheet "${params.sheet}" not found or has no sliced frames. Import it and run ` +
          'sliceSpritesheet first, then reference it by id or name.',
        'AUTOTILE_SHEET_NOT_FOUND',
      );
    }

    const rule = AutotileRuleSchema.parse({
      sheet: sheet.id,
      template: params.template,
      ...(params.mapping ? { mapping: params.mapping } : {}),
    });

    // Every frame the rule can resolve to (template merged with overrides) must
    // exist on the sheet — a rule pointing at missing frames renders nothing.
    const effective = resolvedMapping(rule);
    const missing = [...new Set(Object.values(effective))].filter(
      (frameName) => !findSheetFrame(sheet, frameName),
    );
    if (missing.length > 0) {
      const shown = missing.slice(0, 12).join(', ');
      throw new ProjectError(
        `Sheet "${sheet.name}" is missing ${missing.length} autotile frame(s): ` +
          `${shown}${missing.length > 12 ? ', …' : ''}. A blob47 sheet needs frames named ` +
          'blob_<shapeKey> for every shape (or override them via mapping).',
        'AUTOTILE_FRAME_MISSING',
      );
    }

    next.tileAssets[params.char] = rule;
    writeTilemap(entity, next);
    ctx.changed({ kind: 'component', id: entity.id, name: 'Tilemap', scene: scene.id, action: 'modified' });
    return { entityId: entity.id, char: params.char, rule };
  },
});

export const resizeTilemap = defineCommand({
  name: 'resizeTilemap',
  description:
    'Resize a Tilemap\'s grid to width x height. Growing pads new cells/rows with "." (empty); shrinking crops ' +
    'from the right and bottom edges. anchor is reserved for future anchor points; only "top-left" exists today.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    width: z.number().int().min(1).max(TILEMAP_MAX_DIM),
    height: z.number().int().min(1).max(TILEMAP_MAX_DIM),
    anchor: z.enum(['top-left']).default('top-left'),
  }),
  async run(ctx, params) {
    const { scene, entity, tilemap } = resolveTilemap(ctx, params.scene, params.entity);
    const { width, height } = params;
    const rows: string[] = [];
    for (let y = 0; y < height; y++) {
      const existing = tilemap.grid[y] ?? '';
      if (existing.length === width) {
        rows.push(existing);
      } else if (existing.length < width) {
        rows.push(existing + '.'.repeat(width - existing.length));
      } else {
        rows.push(existing.slice(0, width));
      }
    }
    writeGrid(entity, tilemap, rows);
    ctx.changed({ kind: 'component', id: entity.id, name: 'Tilemap', scene: scene.id, action: 'modified' });
    return { width, height };
  },
});
