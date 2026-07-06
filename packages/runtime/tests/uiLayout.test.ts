/**
 * UILayout stacking + UISlider/UIToggle widget rects.
 *
 * `resolveUiPositions` returns a screen position for every UIElement entity.
 * Plain entities (no layout parent) resolve exactly like `uiScreenPosition`
 * today. Entities whose parent has both UILayout + UIElement are stacked by
 * the parent's layout instead: the parent's own anchor+offset position is
 * the top-left of its padding box, children are placed in child order along
 * `direction` (spaced by their measured extent + gap, inset by `padding`),
 * positioned on the cross axis per `align`, and then nudged by their own
 * `UIElement.offset`. A child's own `anchor` is ignored. Nested layouts
 * resolve parent-first.
 */
import { describe, it, expect } from 'vitest';
import { SceneSchema, type Entity, type Scene } from '@hearth/core';
import { resolveUiPositions, uiElementRect } from '../src/ui.js';
import { ent } from './helpers.js';

function buildEntities(raw: Record<string, unknown>[]): Entity[] {
  const scene = SceneSchema.parse({
    formatVersion: 1,
    id: 'scn_test',
    name: 'Test',
    entities: raw,
  }) as unknown as Scene;
  return scene.entities;
}

describe('resolveUiPositions', () => {
  it('stacks a vertical column of text children at cumulative heights + gap', () => {
    const entities = buildEntities([
      ent(
        'Panel',
        { UILayout: {}, UIElement: { anchor: 'top-left', offset: { x: 100, y: 50 } } },
        { id: 'ent_panel' },
      ),
      ent('A', { UIElement: {}, Text: { content: 'A', fontSize: 20 } }, { parentId: 'ent_panel' }),
      ent('B', { UIElement: {}, Text: { content: 'B', fontSize: 20 } }, { parentId: 'ent_panel' }),
      ent('C', { UIElement: {}, Text: { content: 'C', fontSize: 20 } }, { parentId: 'ent_panel' }),
    ]);

    const positions = resolveUiPositions(entities, 800, 600);

    // Each row is 24px tall (1.2 * 20) with an 8px gap => 32px cadence.
    expect(positions.get(entities[1].id)).toEqual({ x: 106, y: 62 });
    expect(positions.get(entities[2].id)).toEqual({ x: 106, y: 94 });
    expect(positions.get(entities[3].id)).toEqual({ x: 106, y: 126 });
  });

  it('centers children on the cross axis for a horizontal layout with align center', () => {
    const entities = buildEntities([
      ent(
        'Row',
        {
          UILayout: { direction: 'horizontal', gap: 4, align: 'center' },
          UIElement: { anchor: 'top-left', offset: { x: 20, y: 20 } },
        },
        { id: 'ent_row' },
      ),
      ent('A', { UIElement: {}, SpriteRenderer: { width: 20, height: 10 } }, { parentId: 'ent_row' }),
      ent('B', { UIElement: {}, SpriteRenderer: { width: 20, height: 30 } }, { parentId: 'ent_row' }),
    ]);

    const positions = resolveUiPositions(entities, 800, 600);

    expect(positions.get(entities[1].id)).toEqual({ x: 30, y: 35 });
    expect(positions.get(entities[2].id)).toEqual({ x: 54, y: 35 });
  });

  it('insets the first child by padding', () => {
    const entities = buildEntities([
      ent(
        'Panel',
        { UILayout: { gap: 0, padding: 10 }, UIElement: { anchor: 'top-left', offset: { x: 0, y: 0 } } },
        { id: 'ent_panel' },
      ),
      ent('A', { UIElement: {}, SpriteRenderer: { width: 20, height: 20 } }, { parentId: 'ent_panel' }),
      ent('B', { UIElement: {}, SpriteRenderer: { width: 20, height: 20 } }, { parentId: 'ent_panel' }),
    ]);

    const positions = resolveUiPositions(entities, 800, 600);

    expect(positions.get(entities[1].id)).toEqual({ x: 20, y: 20 });
    expect(positions.get(entities[2].id)).toEqual({ x: 20, y: 40 });
  });

  it('applies the child UIElement.offset as a relative nudge on top of its stack slot', () => {
    const entities = buildEntities([
      ent(
        'Panel',
        { UILayout: {}, UIElement: { anchor: 'top-left', offset: { x: 0, y: 0 } } },
        { id: 'ent_panel' },
      ),
      ent(
        'A',
        {
          UIElement: { offset: { x: 5, y: -3 } },
          SpriteRenderer: { width: 20, height: 20 },
        },
        { parentId: 'ent_panel' },
      ),
    ]);

    const positions = resolveUiPositions(entities, 800, 600);

    expect(positions.get(entities[1].id)).toEqual({ x: 15, y: 7 });
  });

  it('ignores a child anchor entirely when the parent is a layout container', () => {
    const entities = buildEntities([
      ent(
        'Panel',
        { UILayout: {}, UIElement: { anchor: 'top-left', offset: { x: 0, y: 0 } } },
        { id: 'ent_panel' },
      ),
      ent(
        'A',
        { UIElement: { anchor: 'bottom-right' }, SpriteRenderer: { width: 20, height: 20 } },
        { parentId: 'ent_panel' },
      ),
    ]);

    const positions = resolveUiPositions(entities, 800, 600);

    // Would be near (800, 600) if anchor were honored; instead it's stacked at the panel's origin.
    expect(positions.get(entities[1].id)).toEqual({ x: 10, y: 10 });
  });

  it('resolves nested layouts parent-first', () => {
    const entities = buildEntities([
      ent(
        'Outer',
        { UILayout: {}, UIElement: { anchor: 'top-left', offset: { x: 0, y: 0 } } },
        { id: 'ent_outer' },
      ),
      ent('L1', { UIElement: {}, SpriteRenderer: { width: 20, height: 20 } }, { parentId: 'ent_outer' }),
      ent(
        'Inner',
        {
          UILayout: { direction: 'horizontal', gap: 4, padding: 5 },
          UIElement: {},
        },
        { id: 'ent_inner', parentId: 'ent_outer' },
      ),
      ent('C1', { UIElement: {}, SpriteRenderer: { width: 10, height: 10 } }, { parentId: 'ent_inner' }),
      ent('C2', { UIElement: {}, SpriteRenderer: { width: 10, height: 10 } }, { parentId: 'ent_inner' }),
    ]);

    const positions = resolveUiPositions(entities, 800, 600);

    expect(positions.get('ent_outer')).toEqual({ x: 0, y: 0 });
    expect(positions.get(entities[1].id)).toEqual({ x: 10, y: 10 }); // L1
    expect(positions.get('ent_inner')).toEqual({ x: 0, y: 28 });
    expect(positions.get(entities[3].id)).toEqual({ x: 10, y: 38 }); // C1
    expect(positions.get(entities[4].id)).toEqual({ x: 24, y: 38 }); // C2
  });

  it('collapses a child with no measurable visuals to a zero-size slot that still consumes gap', () => {
    const entities = buildEntities([
      ent(
        'Panel',
        { UILayout: {}, UIElement: { anchor: 'top-left', offset: { x: 0, y: 0 } } },
        { id: 'ent_panel' },
      ),
      ent('A', { UIElement: {}, SpriteRenderer: { width: 20, height: 20 } }, { parentId: 'ent_panel' }),
      ent('Empty', { UIElement: {} }, { parentId: 'ent_panel' }), // no Sprite/Text/Slider/Toggle
      ent('B', { UIElement: {}, SpriteRenderer: { width: 20, height: 20 } }, { parentId: 'ent_panel' }),
    ]);

    const positions = resolveUiPositions(entities, 800, 600);

    expect(positions.get(entities[1].id)).toEqual({ x: 10, y: 10 }); // A
    // Empty gets a {0,0}-extent slot at the cursor (20 + gap 8), aligned to the cross start.
    expect(positions.get(entities[2].id)).toEqual({ x: 0, y: 28 });
    // B sits one extra gap below where it would be without Empty (38 -> 46).
    expect(positions.get(entities[3].id)).toEqual({ x: 10, y: 46 });
  });

  it('resolves plain (non-layout) UIElement entities exactly like uiScreenPosition', () => {
    const entities = buildEntities([
      ent('Solo', { UIElement: { anchor: 'center', offset: { x: 5, y: -5 } } }),
    ]);

    const positions = resolveUiPositions(entities, 800, 600);

    expect(positions.get(entities[0].id)).toEqual({ x: 405, y: 295 });
  });
});

describe('uiElementRect for widgets', () => {
  it('sizes a UISlider rect as width x 24 centered on the resolved position', () => {
    const entities = buildEntities([
      ent('Slider', { UIElement: { anchor: 'top-left', offset: { x: 200, y: 100 } }, UISlider: {} }),
    ]);
    const rect = uiElementRect(entities[0].components, 800, 600);
    expect(rect).toEqual({ minX: 120, minY: 88, maxX: 280, maxY: 112 });
  });

  it('sizes a UIToggle rect as size x size centered on the resolved position', () => {
    const entities = buildEntities([
      ent('Toggle', { UIElement: { anchor: 'top-left', offset: { x: 50, y: 50 } }, UIToggle: {} }),
    ]);
    const rect = uiElementRect(entities[0].components, 800, 600);
    expect(rect).toEqual({ minX: 40, minY: 40, maxX: 60, maxY: 60 });
  });

  it('counts a slider as a visual even with no Sprite/Text', () => {
    const entities = buildEntities([
      ent('Slider', { UIElement: {}, UISlider: {} }),
    ]);
    expect(uiElementRect(entities[0].components, 800, 600)).not.toBeNull();
  });
});
