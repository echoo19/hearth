/**
 * AnimationStateMachine runtime integration: drives a sibling SpriteRenderer
 * through SceneRuntime's fixed-step loop, wins over a SpriteAnimator on the
 * same entity (with a single warning), reaps state on destroy, survives a
 * hot reload, and exposes ctx.animator.setParam/getParam/fire/state to JS and
 * Lua scripts (with script-error semantics on misuse).
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

const IDLE = { frames: ['idle0', 'idle1'], frameDuration: 0.1, loop: true };
const WALK = { frames: ['walk0', 'walk1', 'walk2'], frameDuration: 0.1, loop: true };
const ATTACK = { frames: ['atk0', 'atk1'], frameDuration: 0.1, loop: false };

const SM_DATA = {
  params: {
    moving: { type: 'bool' },
    attack: { type: 'trigger' },
  },
  states: [
    { name: 'idle', animation: 'ast_idle' },
    { name: 'walk', animation: 'ast_walk' },
    { name: 'attacking', animation: 'ast_attack' },
  ],
  initial: 'idle',
  transitions: [
    { from: 'idle', to: 'walk', conditions: [{ param: 'moving', op: 'eq', value: true }] },
    { from: 'walk', to: 'idle', conditions: [{ param: 'moving', op: 'eq', value: false }] },
    { from: 'any', to: 'attacking', conditions: [{ param: 'attack' }] },
    { from: 'attacking', to: 'idle', exitTime: 1 },
  ],
};

const SM_ASSET = {
  id: 'ast_sm',
  name: 'hero-sm',
  type: 'stateMachine',
  path: 'assets/statemachines/hero.asm.json',
};
const ANIM_ASSETS = [
  { id: 'ast_idle', name: 'idle', type: 'animation', path: 'assets/animations/idle.anim.json' },
  { id: 'ast_walk', name: 'walk', type: 'animation', path: 'assets/animations/walk.anim.json' },
  { id: 'ast_attack', name: 'attack', type: 'animation', path: 'assets/animations/attack.anim.json' },
];

async function writeAnims(fs: { writeFile(p: string, c: string): Promise<void> }): Promise<void> {
  await fs.writeFile('/proj/assets/animations/idle.anim.json', JSON.stringify(IDLE));
  await fs.writeFile('/proj/assets/animations/walk.anim.json', JSON.stringify(WALK));
  await fs.writeFile('/proj/assets/animations/attack.anim.json', JSON.stringify(ATTACK));
  await fs.writeFile('/proj/assets/statemachines/hero.asm.json', JSON.stringify(SM_DATA));
}

async function makeHero(
  extraComponents: Record<string, unknown> = {},
  opts: { script?: string; scriptFile?: string; lang?: 'js' | 'lua' } = {},
) {
  const scripts: Record<string, string> = {};
  const components: Record<string, unknown> = {
    Transform: {},
    SpriteRenderer: { assetId: 'idle0' },
    AnimationStateMachine: { assetId: 'ast_sm' },
    ...extraComponents,
  };
  if (opts.script) {
    const file = opts.scriptFile ?? `hero.${opts.lang ?? 'js'}`;
    scripts[file] = opts.script;
    components.Script = { scriptPath: `scripts/${file}` };
  }
  const { store, fs } = await makeStore({
    entities: [ent('Hero', components)],
    assets: [SM_ASSET, ...ANIM_ASSETS],
    scripts,
  });
  await writeAnims(fs);
  return { store, fs };
}

const renderer = (rt: SceneRuntime) => rt.find('Hero')!.components.SpriteRenderer!;

describe('AnimationStateMachine runtime', () => {
  it('drives the sibling SpriteRenderer through the initial clip', async () => {
    const { store } = await makeHero();
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    expect(renderer(rt).assetId).toBe('idle0');
    rt.run(6); // 0.1s -> next idle frame
    expect(renderer(rt).assetId).toBe('idle1');
    expect(rt.getStateMachineState('Hero')).toBe('idle');
  });

  it('wins over a sibling SpriteAnimator and warns exactly once', async () => {
    const { store } = await makeHero({ SpriteAnimator: { assetId: 'ast_walk' } });
    const logs: string[] = [];
    const rt = await SceneRuntime.create(store, 'Test', { onLog: (e) => logs.push(e.message) });
    rt.run(30);
    // State machine, not the SpriteAnimator, controls the renderer (idle clip).
    expect(['idle0', 'idle1']).toContain(renderer(rt).assetId);
    const warnings = logs.filter((m) => m.includes('AnimationStateMachine') && m.includes('SpriteAnimator'));
    expect(warnings).toHaveLength(1);
  });

  it('reaps SmState when the entity is destroyed', async () => {
    const { store } = await makeHero();
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(3);
    expect(rt.getStateMachineState('Hero')).toBe('idle');
    rt.find('Hero')!; // still live
    (rt as unknown as { destroyEntity(id: string): void }).destroyEntity(rt.find('Hero')!.id);
    rt.run(1);
    expect(rt.getStateMachineState('Hero')).toBeNull();
  });

  it('preserves SmState across a hot reload (reloadScript)', async () => {
    const { store } = await makeHero(
      {},
      {
        lang: 'js',
        script: `export default {
          onUpdate(ctx) { if (ctx.time.frame === 2) ctx.animator.setParam(ctx.entity.name, 'moving', true); },
        };`,
      },
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(6); // moving set at frame 2 -> now walking
    expect(rt.getStateMachineState('Hero')).toBe('walk');
    const result = await rt.reloadScript(
      'scripts/hero.js',
      `export default { onUpdate() {} };`,
    );
    expect(result.ok).toBe(true);
    rt.run(6);
    // Still walking: the SM state (moving=true, current=walk) survived the reload.
    expect(rt.getStateMachineState('Hero')).toBe('walk');
  });
});

describe('ctx.animator (JS)', () => {
  it('setParam drives a transition', async () => {
    const { store } = await makeHero(
      {},
      {
        script: `export default {
          onUpdate(ctx) { if (ctx.time.frame === 2) ctx.animator.setParam(ctx.entity.id, 'moving', true); },
        };`,
      },
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(2);
    expect(rt.getStateMachineState('Hero')).toBe('idle');
    rt.run(2);
    expect(rt.getStateMachineState('Hero')).toBe('walk');
  });

  it('fire + consume round-trips through a scripted transition; state() reads current', async () => {
    const logs: string[] = [];
    const { store } = await makeHero(
      {},
      {
        script: `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 1) ctx.animator.fire(ctx.entity.name, 'attack');
            if (ctx.time.frame === 3) ctx.log('state=' + ctx.animator.state(ctx.entity.name));
          },
        };`,
      },
    );
    const rt = await SceneRuntime.create(store, 'Test', { onLog: (e) => logs.push(e.message) });
    rt.run(5);
    expect(logs).toContain('state=attacking');
    // Trigger consumed by the transition: no longer latched.
    expect(rt.getStateMachineState('Hero')).toBe('attacking');
  });

  it('unknown param raises a script error with a line number', async () => {
    const { store } = await makeHero(
      {},
      {
        script: `export default {
          onUpdate(ctx) { ctx.animator.setParam(ctx.entity.name, 'ghost', 1); },
        };`,
      },
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    const err = rt.errors.find((e) => e.message.includes('unknown param'));
    expect(err).toBeDefined();
    expect(err!.line).toBe(2);
  });

  it('a bad entityRef raises a script error', async () => {
    const { store } = await makeHero(
      {},
      {
        script: `export default {
          onUpdate(ctx) { ctx.animator.fire('nonexistent', 'attack'); },
        };`,
      },
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    expect(rt.errors.some((e) => e.message.includes('entity not found'))).toBe(true);
  });
});

describe('ctx.animator (Lua)', () => {
  it('drives a transition from a Lua script', async () => {
    const { store } = await makeHero(
      {},
      {
        lang: 'lua',
        script: [
          'local s = {}',
          'function s.onUpdate(ctx, dt)',
          '  if ctx.time.frame == 2 then ctx.animator.setParam(ctx.entity.name, "moving", true) end',
          'end',
          'return s',
        ].join('\n'),
      },
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(4);
    expect(rt.getStateMachineState('Hero')).toBe('walk');
    rt.destroy();
  });
});
