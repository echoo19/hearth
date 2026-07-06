/**
 * UISlider drag and UIToggle click interaction (headless, via sendPointer).
 *
 * Task 10 wires the runtime's pointer pipeline to:
 *  - dispatch onUiEvent {type:'drag', x, y} to the pressed entity on every
 *    'move' while a pointer button is held, for ANY interactive element;
 *  - map pointer x onto a pressed UISlider's track on both 'down' and
 *    'move', snapping to `step` when set, writing the value only on actual
 *    change and firing onUiEvent {type:'change', value, x, y};
 *  - flip a UIToggle's value on click and fire the same 'change' event;
 *  - hit-test using `resolveUiPositions` so UILayout children (which render
 *    at a stacked position, not their own bare anchor+offset) are clicked
 *    where they are actually drawn.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

const WIDGET_SCRIPT = `
  export default {
    onUiEvent(ctx, event) {
      ctx.log(JSON.stringify({ name: ctx.entity.name, type: event.type, value: event.value }));
    },
  };
`;

interface Logged {
  name: string;
  type: string;
  value?: number | boolean;
}

async function makeWidgetRuntime(entities: Record<string, unknown>[]): Promise<SceneRuntime> {
  const { store } = await makeStore({ entities, scripts: { 'widget.js': WIDGET_SCRIPT } });
  const runtime = await SceneRuntime.create(store, 'Test');
  runtime.run(1);
  return runtime;
}

function events(runtime: SceneRuntime): Logged[] {
  return runtime.logs.map((l) => JSON.parse(l.message) as Logged);
}

function slider(
  name: string,
  uiOverrides: Record<string, unknown> = {},
  sliderOverrides: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return ent(
    name,
    {
      Transform: {},
      UIElement: { interactive: true, anchor: 'top-left', offset: { x: 200, y: 100 }, ...uiOverrides },
      UISlider: { min: 0, max: 1, value: 0, step: 0, width: 160, ...sliderOverrides },
      Script: { scriptPath: 'scripts/widget.js' },
    },
    extra,
  );
}

function toggle(name: string, uiOverrides: Record<string, unknown> = {}) {
  return ent(name, {
    Transform: {},
    UIElement: { interactive: true, anchor: 'top-left', offset: { x: 50, y: 50 }, ...uiOverrides },
    UIToggle: { value: false, size: 20 },
    Script: { scriptPath: 'scripts/widget.js' },
  });
}

describe('slider drag', () => {
  it('drag from left edge to middle sets value to mid and fires change', async () => {
    const runtime = await makeWidgetRuntime([slider('Vol')]);
    // Slider center is (200,100), width 160 => track spans x=120..280.
    runtime.sendPointer(120, 100, 'down'); // left edge -> value ~ min (0)
    runtime.sendPointer(200, 100, 'move'); // center -> value ~ mid (0.5)

    const changes = events(runtime).filter((e) => e.type === 'change');
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.at(-1)?.value).toBeCloseTo(0.5);

    const live = runtime.getEntities().find((e) => e.name === 'Vol')!;
    expect(live.components.UISlider!.value).toBeCloseTo(0.5);
  });

  it('accounts for Transform.scale when mapping pointer x onto the track', async () => {
    // Same slider (center 200,100, width 160) but scaled x2 => the drawn
    // and hit-tested track spans 200±160 = 40..360 (matches rectAtPosition's
    // scaling of the hit rect), not the unscaled 120..280.
    const runtime = await makeWidgetRuntime([
      ent('Vol', {
        Transform: { scale: { x: 2, y: 2 } },
        UIElement: { interactive: true, anchor: 'top-left', offset: { x: 200, y: 100 } },
        UISlider: { min: 0, max: 1, value: 0, step: 0, width: 160 },
        Script: { scriptPath: 'scripts/widget.js' },
      }),
    ]);
    runtime.sendPointer(40, 100, 'down'); // scaled left edge -> value ~ min (0)
    runtime.sendPointer(200, 100, 'move'); // center -> value ~ mid (0.5)

    const live = runtime.getEntities().find((e) => e.name === 'Vol')!;
    expect(live.components.UISlider!.value).toBeCloseTo(0.5);
  });

  it('snaps to step when step > 0', async () => {
    const runtime = await makeWidgetRuntime([slider('Vol', {}, { step: 0.1 })]);
    runtime.sendPointer(120, 100, 'down');
    runtime.sendPointer(252, 100, 'move'); // raw t ~0.825 -> value ~0.825 -> snapped to 0.8

    const live = runtime.getEntities().find((e) => e.name === 'Vol')!;
    expect(live.components.UISlider!.value).toBeCloseTo(0.8, 5);
  });
});

describe('toggle click', () => {
  it('flips value and fires change on click', async () => {
    const runtime = await makeWidgetRuntime([toggle('Mute')]);
    runtime.sendPointer(50, 50, 'down');
    runtime.sendPointer(50, 50, 'up');

    const live = runtime.getEntities().find((e) => e.name === 'Mute')!;
    expect(live.components.UIToggle!.value).toBe(true);

    const changes = events(runtime).filter((e) => e.type === 'change');
    expect(changes.at(-1)).toMatchObject({ name: 'Mute', type: 'change', value: true });
  });
});

describe('drag on a plain interactive element', () => {
  it('dispatches drag events to a pressed element with no widget component', async () => {
    const runtime = await makeWidgetRuntime([
      ent('Handle', {
        Transform: {},
        UIElement: { interactive: true, anchor: 'top-left', offset: { x: 100, y: 100 } },
        SpriteRenderer: { width: 50, height: 50 },
        Script: { scriptPath: 'scripts/widget.js' },
      }),
    ]);
    runtime.sendPointer(100, 100, 'down');
    runtime.sendPointer(120, 110, 'move');
    runtime.sendPointer(90, 95, 'move');

    const drags = events(runtime).filter((e) => e.type === 'drag');
    expect(drags).toHaveLength(2);
    expect(drags[0]).toMatchObject({ name: 'Handle', type: 'drag' });
    expect('value' in drags[0]).toBe(false);
  });

  it('does not dispatch drag once the pointer is released', async () => {
    const runtime = await makeWidgetRuntime([
      ent('Handle', {
        Transform: {},
        UIElement: { interactive: true, anchor: 'top-left', offset: { x: 100, y: 100 } },
        SpriteRenderer: { width: 50, height: 50 },
        Script: { scriptPath: 'scripts/widget.js' },
      }),
    ]);
    runtime.sendPointer(100, 100, 'down');
    runtime.sendPointer(100, 100, 'up');
    runtime.sendPointer(110, 105, 'move');

    expect(events(runtime).some((e) => e.type === 'drag')).toBe(false);
  });
});

describe('layout-aware hit testing', () => {
  it('hits a slider stacked inside a UILayout at its laid-out position, not its own anchor', async () => {
    const runtime = await makeWidgetRuntime([
      ent(
        'Panel',
        { UIElement: { anchor: 'top-left', offset: { x: 50, y: 50 } }, UILayout: { gap: 10 } },
        { id: 'ent_panel' },
      ),
      ent(
        'Filler',
        { UIElement: {}, SpriteRenderer: { width: 100, height: 30 } },
        { parentId: 'ent_panel' },
      ),
      // Own anchor is nonsense (bottom-right) — must be ignored entirely
      // since its parent is a layout container (offset would still nudge
      // the stacked slot, per resolveUiPositions, so leave it at zero here).
      slider(
        'Vol',
        { anchor: 'bottom-right', offset: { x: 0, y: 0 } },
        {},
        { parentId: 'ent_panel' },
      ),
    ]);

    // Hand-derived stacked position: Panel top-left (50,50), padding 0.
    // Filler: cross-start align, height 30, width 100 => centered at
    // (50+50, 50+15) = (100, 65); cursor advances to 50+30+10=90.
    // Vol (UISlider, width 160 x 24): centered at (50+80, 90+12) = (130, 102).
    runtime.sendPointer(130, 102, 'down');
    runtime.sendPointer(130, 102, 'up');
    expect(events(runtime).map((e) => `${e.name}:${e.type}`)).toEqual(
      expect.arrayContaining(['Vol:press', 'Vol:release', 'Vol:click']),
    );
  });
});
