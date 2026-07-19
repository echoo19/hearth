/**
 * PIXEL_ART_STRETCHED validation: the engine mechanically catches the classic
 * agent mistake of building a surface by stretching one small raster tile in
 * `stretch` renderMode — the box smears texels whenever its scale is
 * non-integer or aspect-distorting. Skill prose alone didn't stop this (agents
 * stretched anyway), so `hearth validate` — which every agent loop runs —
 * names the entity, the distortion, and the fix.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, type ProjectStore } from '@hearth/core';
import { validateProject } from '../src/validate.js';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  const session = HearthSession.fromStore(store, {});
  return { fs, session, store };
}

/** Register a fake imported raster tile (PNG) with known native dims. */
async function addRasterAsset(
  fs: MemoryFileSystem,
  store: ProjectStore,
  opts: { id?: string; name?: string; width: number; height: number; pixelArt?: boolean | null; frames?: unknown[] },
): Promise<string> {
  const id = opts.id ?? 'ast_grass1';
  const path = `assets/sprites/${opts.name ?? 'grass'}.png`;
  await fs.writeFile(`/proj/${path}`, 'fake-png-bytes');
  store.assets.assets.push({
    id,
    name: opts.name ?? 'grass',
    type: 'tile',
    path,
    metadata: {
      importedFrom: 'grass.png',
      format: 'png',
      width: opts.width,
      height: opts.height,
      ...(opts.frames ? { frames: opts.frames, frameWidth: 16, frameHeight: 16 } : {}),
    },
    ...(opts.pixelArt !== undefined ? { pixelArt: opts.pixelArt } : {}),
  } as never);
  return id;
}

async function addSprite(
  session: HearthSession,
  store: ProjectStore,
  sr: Record<string, unknown>,
  name = 'Ground',
) {
  const sceneId = store.project.initialScene as string;
  const res = await session.execute('createEntity', {
    scene: sceneId,
    name,
    components: { SpriteRenderer: sr },
  });
  expect(res.success).toBe(true);
}

async function stretchIssues(store: ProjectStore) {
  const report = await validateProject(store);
  return [...report.errors, ...report.warnings].filter((i) => i.code === 'PIXEL_ART_STRETCHED');
}

describe('PIXEL_ART_STRETCHED', () => {
  it('warns when a raster tile is stretched to a non-integer scale (the smeared-platform mistake)', async () => {
    const { fs, session, store } = await makeSession();
    const id = await addRasterAsset(fs, store, { width: 18, height: 18 });
    // The exact failure from the field: one 18×18 grass tile stretched into a
    // whole platform.
    await addSprite(session, store, { assetId: id, width: 800, height: 80 });
    const issues = await stretchIssues(store);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toMatch(/tile|Tilemap/); // must teach the fix, not just complain
  });

  it('warns on an aspect-distorting integer scale (2× by 3×)', async () => {
    const { fs, session, store } = await makeSession();
    const id = await addRasterAsset(fs, store, { width: 16, height: 16 });
    await addSprite(session, store, { assetId: id, width: 32, height: 48 });
    expect((await stretchIssues(store)).length).toBe(1);
  });

  it('stays quiet at a clean integer scale (16×16 shown at 48×48)', async () => {
    const { fs, session, store } = await makeSession();
    const id = await addRasterAsset(fs, store, { width: 16, height: 16 });
    await addSprite(session, store, { assetId: id, width: 48, height: 48 });
    expect((await stretchIssues(store)).length).toBe(0);
  });

  it('stays quiet in tile renderMode however large the box (that IS the fix)', async () => {
    const { fs, session, store } = await makeSession();
    const id = await addRasterAsset(fs, store, { width: 18, height: 18 });
    await addSprite(session, store, { assetId: id, width: 800, height: 80, renderMode: 'tile' });
    expect((await stretchIssues(store)).length).toBe(0);
  });

  it('stays quiet when the asset opts out of pixel art (photo/soft art may scale freely)', async () => {
    const { fs, session, store } = await makeSession();
    const id = await addRasterAsset(fs, store, { width: 100, height: 60, pixelArt: false });
    await addSprite(session, store, { assetId: id, width: 333, height: 123 });
    expect((await stretchIssues(store)).length).toBe(0);
  });

  it('checks a sheet frame against the frame dims, not the whole sheet', async () => {
    const { fs, session, store } = await makeSession();
    const id = await addRasterAsset(fs, store, {
      width: 64,
      height: 64,
      frames: [{ name: 'spike_0', x: 0, y: 0, width: 16, height: 16 }],
    });
    // Frame shown at 48×48 = clean 3× — fine even though 48 doesn't divide the sheet's 64.
    await addSprite(session, store, { assetId: id, frame: 'spike_0', width: 48, height: 48 }, 'SpikeOk');
    expect((await stretchIssues(store)).length).toBe(0);
    // Frame smeared to 40×26 — flagged.
    await addSprite(session, store, { assetId: id, frame: 'spike_0', width: 40, height: 26 }, 'SpikeBad');
    expect((await stretchIssues(store)).length).toBe(1);
  });

  it('ignores procedural SVG sprites (vector art scales without smearing)', async () => {
    const { session, store } = await makeSession();
    const created = await session.execute<{ asset: { id: string } }>('createSpriteAsset', {
      name: 'hero-box',
      width: 24,
      height: 24,
    });
    expect(created.success).toBe(true);
    await addSprite(session, store, { assetId: created.data!.asset.id, width: 100, height: 37 });
    expect((await stretchIssues(store)).length).toBe(0);
  });
});
