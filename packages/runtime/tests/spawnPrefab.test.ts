/**
 * ctx.scene.spawnPrefab — spawning a prefab asset as a live entity subtree at
 * play time. Covers: subtree + preserved parent links, position/name opts,
 * unknown-prefab tolerance (warn + null), children registered for scripts,
 * per-entity destroy (root destroy does NOT cascade), determinism (no seeded
 * RNG reads; two identical runs hash identically), and Lua parity.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { serializePrefab, createComponent, type Entity } from '@hearth/core';
import { makeStore, ent } from './helpers.js';
import { runHash } from './determinism.js';

const messages = (rt: SceneRuntime) => rt.logs.map((l) => l.message);

/**
 * A "Coin" prefab: root (tags ['pickup']) with one child "CoinGlow". Built
 * through the real serializePrefab path so the payload is schema-valid and
 * root-first, exactly like a createPrefab asset on disk. The child optionally
 * carries a Script so we can prove spawned children get registered.
 */
function coinPrefabData(childScriptPath?: string) {
  const entities: Entity[] = [
    {
      id: 'ent_a',
      name: 'Coin',
      parentId: null,
      enabled: true,
      tags: ['pickup'],
      components: { Transform: createComponent('Transform', { position: { x: 0, y: 0 } }) },
    } as Entity,
    {
      id: 'ent_b',
      name: 'CoinGlow',
      parentId: 'ent_a',
      enabled: true,
      tags: [],
      components: {
        Transform: createComponent('Transform', { position: { x: 4, y: 4 } }),
        ...(childScriptPath ? { Script: createComponent('Script', { scriptPath: childScriptPath }) } : {}),
      },
    } as Entity,
  ];
  return serializePrefab('Coin', entities, 'ent_a');
}

interface SpawnStoreOpts {
  ext?: 'js' | 'lua';
  childScriptPath?: string;
  scripts?: Record<string, string>;
}

/** Store with a Spawner entity whose script drives spawnPrefab + a Coin prefab. */
async function makeSpawnStore(spawnerSource: string, opts: SpawnStoreOpts = {}) {
  const ext = opts.ext ?? 'js';
  const { store, fs } = await makeStore({
    entities: [ent('Spawner', { Transform: {}, Script: { scriptPath: `scripts/spawner.${ext}` } })],
    scripts: { [`spawner.${ext}`]: spawnerSource, ...(opts.scripts ?? {}) },
    assets: [{ id: 'ast_coin', name: 'Coin', type: 'prefab', path: 'assets/prefabs/coin.prefab.json' }],
  });
  await fs.writeFile(
    '/proj/assets/prefabs/coin.prefab.json',
    JSON.stringify(coinPrefabData(opts.childScriptPath)),
  );
  return { store, fs };
}

describe('ctx.scene.spawnPrefab', () => {
  it('spawns the whole subtree with fresh ids and preserved parent links', async () => {
    const { store } = await makeSpawnStore(
      `export default { onStart(ctx) {
        const root = ctx.scene.spawnPrefab('Coin');
        ctx.log('root:' + root.name + ':' + root.tags.join(','));
        ctx.log('hasTransform:' + (root.getComponent('Transform') ? 'yes' : 'no'));
      } };`,
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    expect(rt.errors).toEqual([]);

    const root = rt.find('Coin');
    const child = rt.find('CoinGlow');
    expect(root).toBeDefined();
    expect(child).toBeDefined();
    // Fresh runtime ids (not the pfe_* local ids, not the ent_a/ent_b sources).
    expect(root!.id).toMatch(/^ent_/);
    expect(root!.id).not.toBe('ent_a');
    // Parent link preserved AMONG the spawned set: child points at the new root.
    expect(child!.parentId).toBe(root!.id);
    expect(root!.parentId).toBeNull();
    expect(root!.tags).toEqual(['pickup']);
    expect(messages(rt)).toContain('root:Coin:pickup');
    expect(messages(rt)).toContain('hasTransform:yes');
  });

  it('applies position and name opts to the root only', async () => {
    const { store } = await makeSpawnStore(
      `export default { onStart(ctx) {
        ctx.scene.spawnPrefab('Coin', { position: { x: 100, y: 50 }, name: 'Gold' });
      } };`,
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    expect(rt.errors).toEqual([]);

    const root = rt.find('Gold');
    expect(root).toBeDefined();
    expect(root!.transform.position).toEqual({ x: 100, y: 50 });
    // Child keeps its authored local transform (position override is root-only).
    const child = rt.find('CoinGlow');
    expect(child!.transform.position).toEqual({ x: 4, y: 4 });
    // Renaming the root did not rename the child.
    expect(rt.find('Coin')).toBeUndefined();
  });

  it('warns and returns null for an unknown prefab name', async () => {
    const { store } = await makeSpawnStore(
      `export default { onStart(ctx) {
        const h = ctx.scene.spawnPrefab('Nope');
        ctx.log('isnull:' + (h === null));
      } };`,
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    expect(messages(rt)).toContain('isnull:true');
    expect(rt.logs.some((l) => l.level === 'warn' && l.message.includes('unknown prefab'))).toBe(true);
  });

  it('registers spawned children for scripts (child onStart runs)', async () => {
    const { store } = await makeSpawnStore(
      `export default { onStart(ctx) { ctx.scene.spawnPrefab('Coin'); } };`,
      {
        childScriptPath: 'scripts/glow.js',
        scripts: { 'glow.js': `export default { onStart(ctx) { ctx.log('glow started ' + ctx.entity.name); } };` },
      },
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(2);
    expect(rt.errors).toEqual([]);
    expect(messages(rt)).toContain('glow started CoinGlow');
  });

  it('does NOT cascade destroy to children (per-entity destroy)', async () => {
    const { store } = await makeSpawnStore(
      `export default {
        onStart(ctx) { ctx.vars.root = ctx.scene.spawnPrefab('Coin'); },
        onUpdate(ctx) {
          if (ctx.time.frame === 1 && ctx.vars.root) {
            ctx.vars.root.destroy();
            ctx.vars.root = null;
          }
        },
      };`,
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(3);
    expect(rt.errors).toEqual([]);
    // Root gone, child survives — destroy is per-entity, never a subtree cascade.
    expect(rt.find('Coin')).toBeUndefined();
    expect(rt.find('CoinGlow')).toBeDefined();
  });

  it('does not read the seeded RNG stream (ctx.random sequence is unshifted)', async () => {
    const spawning = await makeSpawnStore(
      `export default { onStart(ctx) {
        ctx.log('r:' + ctx.random.next());
        ctx.scene.spawnPrefab('Coin');
        ctx.log('r:' + ctx.random.next());
      } };`,
    );
    const control = await makeSpawnStore(
      `export default { onStart(ctx) {
        ctx.log('r:' + ctx.random.next());
        ctx.log('r:' + ctx.random.next());
      } };`,
    );
    const rtA = await SceneRuntime.create(spawning.store, 'Test', { seed: 7 });
    rtA.run(1);
    const rtB = await SceneRuntime.create(control.store, 'Test', { seed: 7 });
    rtB.run(1);
    const rands = (rt: SceneRuntime) => messages(rt).filter((m) => m.startsWith('r:'));
    // Same seed, same two draws: spawning a prefab between them consumed nothing.
    expect(rands(rtA)).toEqual(rands(rtB));
  });

  it('two identical seeded runs produce an identical state hash', async () => {
    const { store } = await makeSpawnStore(
      `export default { onStart(ctx) {
        ctx.scene.spawnPrefab('Coin', { position: { x: 12, y: 34 } });
      } };`,
    );
    const h1 = await runHash(store, 'Test', 5, 999);
    const h2 = await runHash(store, 'Test', 5, 999);
    expect(h2).toBe(h1);
  });

  it('Lua parity: spawnPrefab with an option table', async () => {
    const { store } = await makeSpawnStore(
      [
        'local script = {}',
        'function script.onStart(ctx)',
        '  ctx.scene.spawnPrefab("Coin", { position = { x = 10, y = 20 } })',
        'end',
        'return script',
      ].join('\n'),
      { ext: 'lua' },
    );
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    expect(rt.errors).toEqual([]);
    const root = rt.find('Coin');
    expect(root).toBeDefined();
    expect(root!.transform.position).toEqual({ x: 10, y: 20 });
    expect(rt.find('CoinGlow')!.parentId).toBe(root!.id);
  });
});
