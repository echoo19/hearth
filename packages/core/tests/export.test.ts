import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  type CommandResources,
  type WebExportBundle,
} from '@hearth/core';

const STUB_PLAYER = 'window.HearthPlayer={boot(){}}';
const ALL: any = ['read-only', 'safe-edit', 'code-edit', 'asset-edit', 'build'];

async function makeSession(resources?: CommandResources) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Export Game' });
  const session = HearthSession.fromStore(store, { granted: ALL, resources });
  // Give the project an asset and a script so the bundle has real content.
  const sprite = await session.execute<any>('createSpriteAsset', { name: 'coin', shape: 'coin', color: 'yellow' });
  expect(sprite.success).toBe(true);
  const sound = await session.execute<any>('createSound', { name: 'pickup', preset: 'coin' });
  expect(sound.success).toBe(true);
  const script = await session.execute<any>('createScript', { name: 'player-move' });
  expect(script.success).toBe(true);
  return { fs, session, store };
}

const stubResources: CommandResources = { getPlayerBundle: async () => STUB_PLAYER };

describe('exportWeb (folder output)', () => {
  it('writes index.html, hearth-player.js, project.bundle.json, and assets/', async () => {
    const { session, fs } = await makeSession(stubResources);
    const result = await session.execute<any>('exportWeb', {});
    expect(result.success).toBe(true);
    expect(result.data.outDir).toBe('export/web');
    expect(result.data.singleFile).toBe(false);

    const html = await fs.readFile('/proj/export/web/index.html');
    expect(html).toContain('<title>Export Game</title>');
    expect(html).toContain('#141019');
    expect(html).toContain('#F76B15');
    expect(html).toContain("fetch('project.bundle.json')");
    expect(html).toContain('hearth-player.js');
    expect(html).toContain('hearth-fullscreen');
    // No external requests: nothing loaded from another origin.
    expect(html).not.toMatch(/https?:\/\//);

    expect(await fs.readFile('/proj/export/web/hearth-player.js')).toBe(STUB_PLAYER);

    const bundle = JSON.parse(await fs.readFile('/proj/export/web/project.bundle.json')) as WebExportBundle;
    expect((bundle.project as any).name).toBe('Export Game');
    expect(bundle.scenes.length).toBe(1);
    expect(bundle.scenes[0].entities.length).toBeGreaterThan(0);
    expect(bundle.scripts['scripts/player-move.js']).toContain('onUpdate');
    expect(bundle.assets.length).toBe(2);
    for (const asset of bundle.assets) {
      expect(asset.path).toBeTruthy();
      expect(asset.dataUri).toBeUndefined();
      expect(await fs.exists(`/proj/export/web/${asset.path}`)).toBe(true);
    }
    expect(result.data.files).toContain('export/web/index.html');
    expect(result.data.files).toContain('export/web/hearth-player.js');
    expect(result.data.files).toContain('export/web/project.bundle.json');
  });

  it('respects a custom outDir and rejects unsafe ones', async () => {
    const { session, fs } = await makeSession(stubResources);
    const ok = await session.execute<any>('exportWeb', { outDir: 'dist/site' });
    expect(ok.success).toBe(true);
    expect(await fs.exists('/proj/dist/site/index.html')).toBe(true);

    for (const bad of ['../outside', '/abs/path', 'C:\\win']) {
      const result = await session.execute('exportWeb', { outDir: bad });
      expect(result.success).toBe(false);
      expect(result.errors[0].code).toBe('INVALID_INPUT');
    }
  });
});

describe('exportWeb (single file)', () => {
  it('emits one index.html with the player inlined and assets as data URIs', async () => {
    const { session, fs } = await makeSession(stubResources);
    const result = await session.execute<any>('exportWeb', { singleFile: true });
    expect(result.success).toBe(true);
    expect(result.data.files).toEqual(['export/web/index.html']);

    const html = await fs.readFile('/proj/export/web/index.html');
    expect(html).toContain(STUB_PLAYER);
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('data:audio/wav;base64,');
    expect(html).not.toContain("fetch('project.bundle.json')");
    expect(await fs.exists('/proj/export/web/hearth-player.js')).toBe(false);
    expect(await fs.exists('/proj/export/web/project.bundle.json')).toBe(false);
  });
});

describe('exportWeb failure modes', () => {
  it('fails with MISSING_RESOURCE when the host provides no player bundle', async () => {
    const { session } = await makeSession(undefined);
    const result = await session.execute('exportWeb', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('MISSING_RESOURCE');
    expect(result.errors[0].message).toContain('HEARTH_TOOLS_DIR');
    expect(result.errors[0].message).toContain('packages/runtime/player/hearth-player.js');
  });

  it('fails with MISSING_RESOURCE when the provider cannot find the file', async () => {
    const { session } = await makeSession({
      getPlayerBundle: async () => {
        throw new Error('hearth-player.js not found. Looked in: /tools/hearth-player.js');
      },
    });
    const result = await session.execute('exportWeb', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('MISSING_RESOURCE');
    expect(result.errors[0].message).toContain('/tools/hearth-player.js');
  });

  it('validates first and refuses to export a broken project', async () => {
    const { session } = await makeSession(stubResources);
    await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'SpriteRenderer.assetId',
      value: 'ast_doesnotexist',
    });
    const result = await session.execute('exportWeb', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('SCHEMA_ERROR');
    expect(result.errors[0].message).toContain('validation error');
  });

  it('requires the build permission', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'NoBuild' });
    const session = HearthSession.fromStore(store, { resources: stubResources }); // default modes: no build
    const result = await session.execute('exportWeb', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PERMISSION_DENIED');
  });
});
