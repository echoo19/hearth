/**
 * Screen-space UI: anchor+offset hit rects, sendPointer hit-testing, and
 * onUiEvent dispatch (click/press/release/enter/exit). Build settings are
 * the project defaults: 800×600 screen.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

const UI_SCRIPT = `
  export default {
    onUiEvent(ctx, event) { ctx.log(ctx.entity.name + ':' + event.type); },
  };
`;

function button(
  name: string,
  uiOverrides: Record<string, unknown>,
  components: Record<string, unknown> = {},
) {
  return ent(name, {
    Transform: {},
    UIElement: { interactive: true, ...uiOverrides },
    SpriteRenderer: { width: 50, height: 50 },
    Script: { scriptPath: 'scripts/ui.js' },
    ...components,
  });
}

async function makeUiRuntime(entities: Record<string, unknown>[]): Promise<SceneRuntime> {
  const { store } = await makeStore({ entities, scripts: { 'ui.js': UI_SCRIPT } });
  const runtime = await SceneRuntime.create(store, 'Test');
  runtime.run(1);
  return runtime;
}

const messages = (runtime: SceneRuntime) => runtime.logs.map((l) => l.message);

describe('sendPointer dispatch', () => {
  it('fires enter, press, release, click for a down/up on the element', async () => {
    const runtime = await makeUiRuntime([
      button('Play', { anchor: 'top-left', offset: { x: 100, y: 100 } }),
    ]);
    runtime.sendPointer(100, 100, 'down');
    runtime.sendPointer(100, 100, 'up');
    expect(messages(runtime)).toEqual(['Play:enter', 'Play:press', 'Play:release', 'Play:click']);
    expect(runtime.errors).toEqual([]);
  });

  it('fires enter and exit as the pointer moves over and off the element', async () => {
    const runtime = await makeUiRuntime([
      button('Play', { anchor: 'top-left', offset: { x: 100, y: 100 } }),
    ]);
    runtime.sendPointer(0, 0, 'move');
    expect(messages(runtime)).toEqual([]);
    runtime.sendPointer(110, 95, 'move'); // inside 75..125 × 75..125
    runtime.sendPointer(300, 300, 'move');
    expect(messages(runtime)).toEqual(['Play:enter', 'Play:exit']);
  });

  it('does not click when press and release land on different points', async () => {
    const runtime = await makeUiRuntime([
      button('Play', { anchor: 'top-left', offset: { x: 100, y: 100 } }),
    ]);
    runtime.sendPointer(100, 100, 'down');
    runtime.sendPointer(300, 300, 'up'); // released off the element
    expect(messages(runtime)).toEqual(['Play:enter', 'Play:press', 'Play:exit']);
  });

  it('ignores non-interactive UI elements', async () => {
    const runtime = await makeUiRuntime([
      button('Label', { interactive: false, anchor: 'top-left', offset: { x: 100, y: 100 } }),
    ]);
    runtime.sendPointer(100, 100, 'down');
    runtime.sendPointer(100, 100, 'up');
    expect(messages(runtime)).toEqual([]);
  });

  it('dispatches to the topmost element by layer when elements overlap', async () => {
    const runtime = await makeUiRuntime([
      button('Below', { anchor: 'center' }, { SpriteRenderer: { width: 50, height: 50, layer: 0 } }),
      button('Above', { anchor: 'center' }, { SpriteRenderer: { width: 50, height: 50, layer: 5 } }),
    ]);
    runtime.sendPointer(400, 300, 'down');
    runtime.sendPointer(400, 300, 'up');
    expect(messages(runtime)).toEqual(['Above:enter', 'Above:press', 'Above:release', 'Above:click']);
  });

  it('lets a UISlider layer out-rank an overlapping SpriteRenderer layer', async () => {
    const runtime = await makeUiRuntime([
      button('Below', { anchor: 'center' }, { SpriteRenderer: { width: 50, height: 50, layer: 1 } }),
      button('Above', { anchor: 'center' }, { UISlider: { width: 50, layer: 5 } }),
    ]);
    runtime.sendPointer(400, 300, 'down');
    runtime.sendPointer(400, 300, 'up');
    expect(messages(runtime)).toEqual(['Above:enter', 'Above:press', 'Above:release', 'Above:click']);
  });
});

describe('hit rects', () => {
  it('anchors rects from any screen corner or center', async () => {
    const runtime = await makeUiRuntime([
      button('Center', { anchor: 'center' }, { SpriteRenderer: { width: 40, height: 40 } }),
      button('Corner', { anchor: 'bottom-right', offset: { x: -50, y: -50 } }),
    ]);
    runtime.sendPointer(400, 300, 'down'); // screen center on 800×600
    runtime.sendPointer(400, 300, 'up');
    runtime.sendPointer(750, 550, 'down'); // bottom-right minus offset
    runtime.sendPointer(750, 550, 'up');
    const clicks = messages(runtime).filter((m) => m.endsWith(':click'));
    expect(clicks).toEqual(['Center:click', 'Corner:click']);
    // Just outside the 40×40 center rect (380..420): no hit.
    runtime.sendPointer(350, 300, 'down');
    expect(messages(runtime).filter((m) => m === 'Center:press').length).toBe(1);
  });

  it('ignores Transform.position but applies scale to the rect', async () => {
    const runtime = await makeUiRuntime([
      button(
        'Scaled',
        { anchor: 'top-left', offset: { x: 100, y: 100 } },
        { Transform: { position: { x: 9999, y: 9999 }, scale: { x: 2, y: 2 } } },
      ),
    ]);
    // 50×50 sprite scaled ×2 → rect 50..150; (140,100) hits only when scaled.
    runtime.sendPointer(140, 100, 'down');
    runtime.sendPointer(140, 100, 'up');
    expect(messages(runtime)).toContain('Scaled:click');
  });

  it('uses measured text bounds when the element has no sprite', async () => {
    const runtime = await makeUiRuntime([
      ent('TextButton', {
        Transform: {},
        UIElement: { anchor: 'top-left', offset: { x: 100, y: 100 }, interactive: true },
        Text: { content: 'Hi', fontSize: 20, align: 'left' },
        Script: { scriptPath: 'scripts/ui.js' },
      }),
    ]);
    // 2 chars × 20px × 0.6 = 24 wide from x=100; 24 tall centered on y=100.
    runtime.sendPointer(110, 100, 'down');
    runtime.sendPointer(110, 100, 'up');
    expect(messages(runtime)).toContain('TextButton:click');
    runtime.sendPointer(130, 100, 'down'); // right of the text bounds
    expect(messages(runtime).filter((m) => m === 'TextButton:press').length).toBe(1);
  });
});
