/**
 * ctx.input pointer surface: mouse-aim support for scripts.
 *
 * `ctx.input.pointer()` returns the cursor position in WORLD space,
 * un-projected through the logical camera (position + zoom, ignoring
 * transient shake/zoomPunch effects so aim never jitters with screen juice).
 * `ctx.input.pointerScreen()` returns the raw buildSettings-space screen
 * position. `pointerDown()`/`pointerPressed()` expose the primary button's
 * held/just-pressed-this-frame state, mirroring isDown/justPressed. All four
 * are fed by the same `sendPointer` choke point the UI system and playtests
 * already use, so real clicks and headless playtests agree.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

function scripted(name: string, scriptPath: string, components: Record<string, unknown> = {}) {
  return ent(name, { Transform: {}, Script: { scriptPath }, ...components });
}

const messages = (logs: { message: string }[]) => logs.map((l) => l.message);

describe('ctx.input pointer (mouse aim)', () => {
  it('defaults to screen center, so pointer() is the camera center world point', async () => {
    // Default build is 800×600; with no Camera entity the view is centered
    // on (400, 300) at zoom 1, and the pointer defaults to screen center.
    const { store } = await makeStore({
      entities: [scripted('Reader', 'scripts/reader.js')],
      scripts: {
        'reader.js': `export default {
          onUpdate(ctx) { const p = ctx.input.pointer(); ctx.log('p:' + p.x + ',' + p.y); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toEqual(['p:400,300']);
  });

  it('un-projects the screen pointer to world space at zoom 1 (no camera)', async () => {
    const { store } = await makeStore({
      entities: [scripted('Reader', 'scripts/reader.js')],
      scripts: {
        'reader.js': `export default {
          onUpdate(ctx) { const p = ctx.input.pointer(); ctx.log('p:' + p.x + ',' + p.y); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.sendPointer(500, 200, 'move');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    // world.x = 400 + (500-400)/1 = 500; world.y = 300 + (200-300)/1 = 200
    expect(messages(runtime.logs)).toEqual(['p:500,200']);
  });

  it('un-projects through a Camera entity position and zoom', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Cam', { Transform: { position: { x: 1000, y: 1000 } }, Camera: { zoom: 2, isMain: true } }),
        scripted('Reader', 'scripts/reader.js'),
      ],
      scripts: {
        'reader.js': `export default {
          onUpdate(ctx) { const p = ctx.input.pointer(); ctx.log('p:' + p.x + ',' + p.y); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    // Screen center maps to the camera's world position regardless of zoom.
    runtime.sendPointer(400, 300, 'move');
    runtime.step();
    // Off-center: world.x = 1000 + (500-400)/2 = 1050, world.y = 1000 + (300-300)/2 = 1000
    runtime.sendPointer(500, 300, 'move');
    runtime.step();
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toEqual(['p:1000,1000', 'p:1050,1000']);
  });

  it('pointerScreen() returns raw screen coordinates, unaffected by the camera', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Cam', { Transform: { position: { x: 1000, y: 1000 } }, Camera: { zoom: 2, isMain: true } }),
        scripted('Reader', 'scripts/reader.js'),
      ],
      scripts: {
        'reader.js': `export default {
          onUpdate(ctx) { const p = ctx.input.pointerScreen(); ctx.log('s:' + p.x + ',' + p.y); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.sendPointer(123, 45, 'move');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toEqual(['s:123,45']);
  });

  it('pointerDown()/pointerPressed() track button held and just-pressed-this-frame', async () => {
    const { store } = await makeStore({
      entities: [scripted('Reader', 'scripts/reader.js')],
      scripts: {
        'reader.js': `export default {
          onUpdate(ctx) {
            ctx.log(ctx.time.frame + ':' + ctx.input.pointerDown() + ',' + ctx.input.pointerPressed());
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step(); // frame 0: nothing pressed
    runtime.sendPointer(10, 10, 'down');
    runtime.step(); // frame 1: down + pressed edge
    runtime.step(); // frame 2: still down, edge cleared
    runtime.sendPointer(10, 10, 'up');
    runtime.step(); // frame 3: released
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toEqual([
      '0:false,false',
      '1:true,true',
      '2:true,false',
      '3:false,false',
    ]);
  });

  it('exposes pointer() to Lua scripts as a table with .x/.y fields', async () => {
    const { store } = await makeStore({
      entities: [scripted('Reader', 'scripts/reader.lua')],
      scripts: {
        'reader.lua': `return {
          onUpdate = function(ctx)
            local p = ctx.input.pointer()
            ctx.log("p:" .. p.x .. "," .. p.y)
          end,
        }`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.sendPointer(500, 200, 'move');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toEqual(['p:500,200']);
  });
});
