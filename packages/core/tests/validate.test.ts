import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, readJson } from '@hearth/core';
import { validateProject } from '../src/validate.js';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  const session = HearthSession.fromStore(store, {});
  return { fs, session, store };
}

async function makePrefabAsset(session: HearthSession, store: any) {
  const sceneId = store.project.initialScene as string;
  const player = store.getScene(sceneId)!.entities.find((e: any) => e.name === 'Player')!;
  const created = await session.execute<any>('createPrefab', {
    scene: sceneId,
    entity: player.id,
    name: 'PlayerPrefab',
  });
  expect(created.success).toBe(true);
  return { asset: created.data.asset as { id: string; name: string; path: string }, sceneId, rootId: player.id as string };
}

describe('prefab validation', () => {
  it('clean project with a valid prefab and a live instance has no prefab-related issues', async () => {
    const { session, store } = await makeSession();
    const { asset, sceneId } = await makePrefabAsset(session, store);

    const inst = await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: sceneId });
    expect(inst.success).toBe(true);

    const report = await validateProject(store);
    const prefabIssues = [...report.errors, ...report.warnings].filter((i) => i.code.startsWith('PREFAB_'));
    expect(prefabIssues).toEqual([]);
  });

  it('PREFAB_DATA_INVALID: unparseable JSON payload on disk', async () => {
    const { session, store, fs } = await makeSession();
    const { asset } = await makePrefabAsset(session, store);
    await fs.writeFile(`/proj/${asset.path}`, 'not json {{{');

    const report = await validateProject(store);
    const err = report.errors.find((e) => e.code === 'PREFAB_DATA_INVALID');
    expect(err).toBeTruthy();
    expect(err?.asset).toBe(asset.id);
  });

  it('PREFAB_DATA_INVALID: schema-valid payload with broken local ids (dangling parentId)', async () => {
    const { session, store, fs } = await makeSession();
    const { asset } = await makePrefabAsset(session, store);
    await fs.writeFile(
      `/proj/${asset.path}`,
      JSON.stringify({
        name: 'Broken',
        entities: [
          { id: 'pfe_1', name: 'Root', parentId: null, enabled: true, tags: [], components: {} },
          { id: 'pfe_2', name: 'Child', parentId: 'pfe_99', enabled: true, tags: [], components: {} },
        ],
      }),
    );

    const report = await validateProject(store);
    const err = report.errors.find((e) => e.code === 'PREFAB_DATA_INVALID');
    expect(err).toBeTruthy();
    expect(err?.asset).toBe(asset.id);
    expect(err?.message).toContain('dangling parentId');
  });

  it('PREFAB_SCRIPT_NOT_FOUND: payload entity references a missing script', async () => {
    const { session, store, fs } = await makeSession();
    const { asset } = await makePrefabAsset(session, store);

    const data: any = await readJson(fs, `/proj/${asset.path}`);
    data.entities[0].components.Script = { scriptPath: 'scripts/nope.lua', params: {} };
    await fs.writeFile(`/proj/${asset.path}`, JSON.stringify(data));

    const report = await validateProject(store);
    const err = report.errors.find((e) => e.code === 'PREFAB_SCRIPT_NOT_FOUND');
    expect(err).toBeTruthy();
    expect(err?.asset).toBe(asset.id);
    expect(err?.message).toContain('scripts/nope.lua');
  });

  it('PREFAB_ASSET_NOT_FOUND: payload entity SpriteRenderer references a missing asset', async () => {
    const { session, store, fs } = await makeSession();
    const { asset } = await makePrefabAsset(session, store);

    const data: any = await readJson(fs, `/proj/${asset.path}`);
    data.entities[0].components.SpriteRenderer.assetId = 'ast_bogus';
    await fs.writeFile(`/proj/${asset.path}`, JSON.stringify(data));

    const report = await validateProject(store);
    const err = report.errors.find((e) => e.code === 'PREFAB_ASSET_NOT_FOUND');
    expect(err).toBeTruthy();
    expect(err?.asset).toBe(asset.id);
    expect(err?.message).toContain('ast_bogus');
  });

  it('PREFAB_INSTANCE_ORPHANED: instance marker points at an asset that no longer exists', async () => {
    const { session, store } = await makeSession();
    const { asset, sceneId } = await makePrefabAsset(session, store);

    const inst = await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: sceneId });
    expect(inst.success).toBe(true);
    const entityId = inst.data.entity.id as string;

    const rm = await session.execute<any>('removeAsset', { asset: asset.id });
    expect(rm.success).toBe(true); // prefab removal warns rather than blocking

    const report = await validateProject(store);
    // createPrefab also marks the source root as a live instance, so both it
    // and the freshly instantiated entity are now orphaned; match by entity id.
    const warning = report.warnings.find((w) => w.code === 'PREFAB_INSTANCE_ORPHANED' && w.entity === entityId);
    expect(warning).toBeTruthy();
    expect(warning?.scene).toBe(sceneId);
  });

  it('PREFAB_INSTANCE_ORPHANED: instance marker points at a non-prefab asset', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene as string;
    const scene = store.getScene(sceneId)!;
    const ground = scene.entities.find((e: any) => e.name === 'Ground')!;

    const sprite = await session.execute<any>('createSpriteAsset', { name: 'NotAPrefab', shape: 'circle', color: 'red' });
    expect(sprite.success).toBe(true);

    (ground as any).prefab = { asset: sprite.data.asset.id };

    const report = await validateProject(store);
    const warning = report.warnings.find((w) => w.code === 'PREFAB_INSTANCE_ORPHANED');
    expect(warning).toBeTruthy();
    expect(warning?.entity).toBe(ground.id);
    expect(warning?.scene).toBe(sceneId);
  });

  it('does not warn PREFAB_INSTANCE_ORPHANED for a healthy instance marker', async () => {
    const { session, store } = await makeSession();
    const { asset, sceneId } = await makePrefabAsset(session, store);
    await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: sceneId });

    const report = await validateProject(store);
    expect(report.warnings.some((w) => w.code === 'PREFAB_INSTANCE_ORPHANED')).toBe(false);
  });

  it('PREFAB_ASSET_NOT_FOUND: payload entity SpriteAnimator references an asset with wrong type', async () => {
    const { session, store, fs } = await makeSession();
    const { asset } = await makePrefabAsset(session, store);

    // Create a sprite asset (not an animation)
    const sprite = await session.execute<any>('createSpriteAsset', { name: 'NotAnAnimation', shape: 'circle', color: 'red' });
    expect(sprite.success).toBe(true);

    const data: any = await readJson(fs, `/proj/${asset.path}`);
    // Set SpriteAnimator to point to the sprite asset (wrong type)
    data.entities[0].components.SpriteAnimator = { assetId: sprite.data.asset.id };
    await fs.writeFile(`/proj/${asset.path}`, JSON.stringify(data));

    const report = await validateProject(store);
    const err = report.errors.find((e) => e.code === 'PREFAB_ASSET_NOT_FOUND');
    expect(err).toBeTruthy();
    expect(err?.asset).toBe(asset.id);
    expect(err?.message).toContain('sprite');
    expect(err?.message).toContain('not an animation');
  });
});

describe('UNKNOWN_COMPONENT_KEY validation (pre-fix projects must still load)', () => {
  it('warns (never errors) when a raw scene file has a typo\'d component field', async () => {
    const { session, store, fs } = await makeSession();
    const created = await session.execute<any>('createEntity', { scene: 'Main', name: 'Coin' });
    expect(created.success).toBe(true);
    const entityId = created.data.entityId as string;
    const sceneId = store.getScene('Main')!.id;
    const scenePath = `/proj/${store.sceneRef(sceneId)!.path}`;

    // Simulate a pre-fix project written before strict path validation existed:
    // a typo'd key that Zod silently stripped on load is still sitting in the raw file.
    const data: any = await readJson(fs, scenePath);
    const entity = data.entities.find((e: any) => e.id === entityId);
    entity.components.Transform.postiion = { x: 1, y: 1 };
    await fs.writeFile(scenePath, JSON.stringify(data));

    const report = await validateProject(store);
    expect(report.valid).toBe(true); // warning only, never an error
    const warning = report.warnings.find((w) => w.code === 'UNKNOWN_COMPONENT_KEY');
    expect(warning).toBeTruthy();
    expect(warning?.message).toContain('postiion');
    expect(warning?.message).toContain('Transform');
    expect(warning?.entity).toBe(entityId);
    expect(warning?.scene).toBe(sceneId);
  });

  it('recurses one level into known nested objects', async () => {
    const { session, store, fs } = await makeSession();
    const created = await session.execute<any>('createEntity', { scene: 'Main', name: 'Coin' });
    const entityId = created.data.entityId as string;
    const sceneId = store.getScene('Main')!.id;
    const scenePath = `/proj/${store.sceneRef(sceneId)!.path}`;

    const data: any = await readJson(fs, scenePath);
    const entity = data.entities.find((e: any) => e.id === entityId);
    entity.components.Transform.position = { x: 0, y: 0, zz: 5 };
    await fs.writeFile(scenePath, JSON.stringify(data));

    const report = await validateProject(store);
    const warning = report.warnings.find((w) => w.code === 'UNKNOWN_COMPONENT_KEY');
    expect(warning).toBeTruthy();
    expect(warning?.message).toContain('position.zz');
  });

  it('does not warn for a clean project', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', { scene: 'Main', name: 'Coin', components: { SpriteRenderer: {} } });

    const report = await validateProject(store);
    expect(report.warnings.some((w) => w.code === 'UNKNOWN_COMPONENT_KEY')).toBe(false);
  });
});

describe('buildSettings.icon validation', () => {
  const ALL: any = ['read-only', 'safe-edit', 'code-edit', 'asset-edit', 'build'];

  async function makeIconSession() {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Icon Game' });
    const session = HearthSession.fromStore(store, { granted: ALL });
    return { fs, session, store };
  }

  it('warns MISSING_ICON_ASSET when the icon references an unknown asset', async () => {
    const { store } = await makeIconSession();
    store.project.buildSettings.icon = 'ast_gone';

    const report = await validateProject(store);
    const warning = report.warnings.find((w) => w.code === 'MISSING_ICON_ASSET');
    expect(warning).toBeTruthy();
    expect(warning?.message).toContain('ast_gone');
    // Warning severity on purpose: an ERROR would trip exportDesktop's
    // "project has N validation error(s)" gate and mask its more specific
    // icon error messages. valid stays true.
    expect(report.valid).toBe(true);
  });

  it('warns ICON_ASSET_NOT_IMAGE when the icon references a non-image asset', async () => {
    const { session, store } = await makeIconSession();
    const sound = await session.execute<any>('createSound', { name: 'ding', preset: 'coin' });
    expect(sound.success).toBe(true);
    store.project.buildSettings.icon = sound.data.asset.id;

    const report = await validateProject(store);
    const warning = report.warnings.find((w) => w.code === 'ICON_ASSET_NOT_IMAGE');
    expect(warning).toBeTruthy();
    expect(warning?.asset).toBe(sound.data.asset.id);
    expect(warning?.message).toContain('sprite or tile');
  });

  it('accepts a sprite icon with no icon issues', async () => {
    const { session, store } = await makeIconSession();
    const sprite = await session.execute<any>('createSpriteAsset', { name: 'badge', shape: 'coin' });
    expect(sprite.success).toBe(true);
    store.project.buildSettings.icon = sprite.data.asset.id;

    const report = await validateProject(store);
    expect([...report.errors, ...report.warnings].some((i) => i.code.includes('ICON'))).toBe(false);
  });

  it('accepts a tile icon with no icon issues (picker parity)', async () => {
    const { session, store } = await makeIconSession();
    const tile = await session.execute<any>('createTileAsset', { name: 'wall' });
    expect(tile.success).toBe(true);
    store.project.buildSettings.icon = tile.data.asset.id;

    const report = await validateProject(store);
    expect([...report.errors, ...report.warnings].some((i) => i.code.includes('ICON'))).toBe(false);
  });

  it('no icon issues when buildSettings.icon is null (default)', async () => {
    const { store } = await makeIconSession();
    const report = await validateProject(store);
    expect([...report.errors, ...report.warnings].some((i) => i.code.includes('ICON'))).toBe(false);
  });
});
