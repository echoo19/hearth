/**
 * UI focus system: ctx.ui.focus/getFocused/moveFocus/activate/adjust,
 * onUiEvent focus/blur dispatch, and destroy-clears-focus (headless).
 *
 * Wires:
 *  - runtime.focusUi(idOrName|null): set/clear the focused UIElement,
 *    firing onUiEvent {type:'blur'} on the previously focused entity (if
 *    any) and {type:'focus'} on the newly focused one. Warns (no state
 *    change) when the target is unknown or not focusable=true.
 *  - runtime.getUiFocused(): the focused entity id, or null.
 *  - runtime.moveUiFocus(direction): spatial nav among focusable UIElement
 *    entities with resolved screen positions — nearest candidate strictly
 *    in the direction half-plane from the current position (or the
 *    top-left-most candidate when nothing is focused), euclidean
 *    distance, no wrap.
 *  - runtime.activateUiFocus(): synthesizes press+release (i.e. a click) at
 *    the focused element's center via the normal sendPointer path.
 *  - runtime.adjustUiFocus(delta): focused UISlider's value +=
 *    delta * (step || (max-min)/10), clamped, fires change.
 *  - Destroying the focused entity clears focus (blurs) at end of frame.
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

async function makeRuntime(entities: Record<string, unknown>[]): Promise<SceneRuntime> {
  const { store } = await makeStore({ entities, scripts: { 'widget.js': WIDGET_SCRIPT } });
  const runtime = await SceneRuntime.create(store, 'Test');
  runtime.run(1);
  return runtime;
}

function events(runtime: SceneRuntime): Logged[] {
  return runtime.logs
    .filter((l) => l.level === 'info')
    .map((l) => JSON.parse(l.message) as Logged);
}

function focusable(
  name: string,
  uiOverrides: Record<string, unknown> = {},
  extraComponents: Record<string, unknown> = {},
) {
  return ent(name, {
    Transform: {},
    UIElement: { interactive: true, focusable: true, anchor: 'top-left', ...uiOverrides },
    Script: { scriptPath: 'scripts/widget.js' },
    ...extraComponents,
  });
}

describe('ctx.ui.focus / getFocused', () => {
  it('fires focus and blur events and updates getUiFocused', async () => {
    const runtime = await makeRuntime([
      focusable('A', { offset: { x: 50, y: 50 } }),
      focusable('B', { offset: { x: 200, y: 50 } }),
    ]);
    const aId = runtime.getEntities().find((e) => e.name === 'A')!.id;
    const bId = runtime.getEntities().find((e) => e.name === 'B')!.id;

    expect(runtime.getUiFocused()).toBeNull();

    runtime.focusUi('A');
    expect(runtime.getUiFocused()).toBe(aId);
    expect(events(runtime)).toEqual(
      expect.arrayContaining([{ name: 'A', type: 'focus' }]),
    );

    runtime.focusUi('B');
    expect(runtime.getUiFocused()).toBe(bId);
    const log = events(runtime);
    expect(log).toEqual(
      expect.arrayContaining([
        { name: 'A', type: 'blur' },
        { name: 'B', type: 'focus' },
      ]),
    );

    runtime.focusUi(null);
    expect(runtime.getUiFocused()).toBeNull();
    expect(events(runtime)).toEqual(
      expect.arrayContaining([{ name: 'B', type: 'blur' }]),
    );
  });

  it('warns and makes no change when the target is unknown or not focusable', async () => {
    const runtime = await makeRuntime([
      focusable('Valid', { offset: { x: 50, y: 50 } }),
      ent('NotFocusable', {
        Transform: {},
        UIElement: { interactive: true, focusable: false },
      }),
    ]);
    const validId = runtime.getEntities().find((e) => e.name === 'Valid')!.id;
    runtime.focusUi('Valid');
    expect(runtime.getUiFocused()).toBe(validId);

    runtime.focusUi('DoesNotExist');
    expect(runtime.getUiFocused()).toBe(validId); // unchanged
    expect(runtime.logs.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(runtime.logs.at(-1)!.message).toContain('DoesNotExist');

    runtime.focusUi('NotFocusable');
    expect(runtime.getUiFocused()).toBe(validId); // unchanged
    expect(runtime.logs.filter((l) => l.level === 'warn')).toHaveLength(2);
    expect(runtime.logs.at(-1)!.message).toContain('NotFocusable');
  });

  it('warns and makes no change when the target entity is disabled', async () => {
    const runtime = await makeRuntime([
      focusable('Valid', { offset: { x: 50, y: 50 } }),
      focusable('HiddenBtn', { offset: { x: 200, y: 50 } }),
    ]);
    const validId = runtime.getEntities().find((e) => e.name === 'Valid')!.id;
    runtime.getEntities().find((e) => e.name === 'HiddenBtn')!.enabled = false;

    runtime.focusUi('Valid');
    runtime.focusUi('HiddenBtn'); // disabled: same treatment as not-focusable
    expect(runtime.getUiFocused()).toBe(validId); // unchanged
    expect(runtime.logs.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(runtime.logs.at(-1)!.message).toContain('HiddenBtn');
  });
});

describe('moveUiFocus spatial navigation', () => {
  // 2x2 grid: TL(100,100) TR(300,100) / BL(100,300) BR(300,300).
  async function makeGrid(): Promise<SceneRuntime> {
    return makeRuntime([
      focusable('TL', { offset: { x: 100, y: 100 } }),
      focusable('TR', { offset: { x: 300, y: 100 } }),
      focusable('BL', { offset: { x: 100, y: 300 } }),
      focusable('BR', { offset: { x: 300, y: 300 } }),
    ]);
  }

  function nameOf(runtime: SceneRuntime, id: string | null): string | null {
    if (!id) return null;
    return runtime.getEntities().find((e) => e.id === id)?.name ?? null;
  }

  it('walks the full cycle TL -> right -> TR -> down -> BR -> left -> BL -> up -> TL', async () => {
    const runtime = await makeGrid();

    runtime.moveUiFocus('right'); // nothing focused: from top-left-most (TL) -> TR
    expect(nameOf(runtime, runtime.getUiFocused())).toBe('TR');

    runtime.moveUiFocus('down');
    expect(nameOf(runtime, runtime.getUiFocused())).toBe('BR');

    runtime.moveUiFocus('left');
    expect(nameOf(runtime, runtime.getUiFocused())).toBe('BL');

    runtime.moveUiFocus('up');
    expect(nameOf(runtime, runtime.getUiFocused())).toBe('TL');
  });

  it('does not wrap when nothing lies further in the requested direction', async () => {
    const runtime = await makeGrid();
    runtime.focusUi('TR');
    runtime.moveUiFocus('right'); // nothing to the right of TR
    expect(nameOf(runtime, runtime.getUiFocused())).toBe('TR');
    runtime.moveUiFocus('up'); // nothing above TR
    expect(nameOf(runtime, runtime.getUiFocused())).toBe('TR');
  });
});

describe('ctx.ui.activate', () => {
  it('clicks the focused toggle, flipping its value', async () => {
    const runtime = await makeRuntime([
      focusable(
        'Mute',
        { offset: { x: 100, y: 100 } },
        { UIToggle: { value: false, size: 20 } },
      ),
    ]);
    runtime.focusUi('Mute');
    runtime.activateUiFocus();

    const live = runtime.getEntities().find((e) => e.name === 'Mute')!;
    expect(live.components.UIToggle!.value).toBe(true);
    expect(events(runtime)).toEqual(
      expect.arrayContaining([{ name: 'Mute', type: 'change', value: true }]),
    );
  });

  it('warns and skips the click when the focused entity is not interactive', async () => {
    const runtime = await makeRuntime([
      focusable(
        'Mute',
        { offset: { x: 100, y: 100 }, interactive: false },
        { UIToggle: { value: false, size: 20 } },
      ),
    ]);
    runtime.focusUi('Mute');
    runtime.activateUiFocus();

    // sendPointer's hit test requires interactive=true, so without the
    // guard the click would silently do nothing — activate must warn.
    const live = runtime.getEntities().find((e) => e.name === 'Mute')!;
    expect(live.components.UIToggle!.value).toBe(false); // unchanged
    expect(events(runtime).some((e) => e.type === 'change')).toBe(false);
    expect(runtime.logs.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(runtime.logs.at(-1)!.message).toContain('Mute');
    expect(runtime.logs.at(-1)!.message).toContain('not interactive');
  });
});

describe('ctx.ui.adjust', () => {
  it('moves the focused slider by step, clamped, firing change', async () => {
    const runtime = await makeRuntime([
      focusable(
        'Vol',
        { offset: { x: 200, y: 100 }, interactive: false },
        { UISlider: { min: 0, max: 1, value: 0.5, step: 0.1, width: 160 } },
      ),
    ]);
    runtime.focusUi('Vol');
    runtime.adjustUiFocus(1);

    let live = runtime.getEntities().find((e) => e.name === 'Vol')!;
    expect(live.components.UISlider!.value).toBeCloseTo(0.6);

    runtime.adjustUiFocus(-10); // clamps to min (0)
    live = runtime.getEntities().find((e) => e.name === 'Vol')!;
    expect(live.components.UISlider!.value).toBeCloseTo(0);

    const changes = events(runtime).filter((e) => e.type === 'change');
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to (max-min)/10 when step is 0', async () => {
    const runtime = await makeRuntime([
      focusable(
        'Vol2',
        { offset: { x: 200, y: 100 }, interactive: false },
        { UISlider: { min: 0, max: 100, value: 50, step: 0, width: 160 } },
      ),
    ]);
    runtime.focusUi('Vol2');
    runtime.adjustUiFocus(1);
    const live = runtime.getEntities().find((e) => e.name === 'Vol2')!;
    expect(live.components.UISlider!.value).toBeCloseTo(60);
  });
});

describe('destroying the focused entity', () => {
  const CONTROLLER_SCRIPT = `
    export default {
      onUpdate(ctx) {
        if (ctx.time.frame === 1) {
          ctx.scene.destroy(ctx.scene.find('Item'));
        }
      },
    };
  `;

  it('clears getUiFocused() at end of frame', async () => {
    const { store } = await makeStore({
      entities: [
        focusable('Item', { offset: { x: 50, y: 50 } }),
        ent('Controller', { Transform: {}, Script: { scriptPath: 'scripts/controller.js' } }),
      ],
      scripts: { 'widget.js': WIDGET_SCRIPT, 'controller.js': CONTROLLER_SCRIPT },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);

    runtime.focusUi('Item');
    expect(runtime.getUiFocused()).not.toBeNull();

    runtime.step(); // Controller destroys 'Item' this frame
    expect(runtime.getUiFocused()).toBeNull();
    expect(runtime.find('Item')).toBeUndefined();
  });
});
