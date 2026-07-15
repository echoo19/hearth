import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  fileProtocolBootMessage,
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
    // No engine chrome: neutral loading background, no ember branding.
    expect(html).toContain('#000000');
    expect(html).not.toContain('#141019');
    expect(html).not.toContain('#F76B15');
    expect(html).toContain("fetch('project.bundle.json')");
    expect(html).toContain('hearth-player.js');
    expect(html).toContain('hearth-fullscreen');
    // F-2 (L-118): the folder build's boot script inlines
    // fileProtocolBootMessage and checks it before ever calling fetch, so a
    // file:// open gets a human message instead of a raw "Failed to fetch".
    expect(html).toContain('function fileProtocolBootMessage(protocol)');
    expect(html).toContain('fileProtocolBootMessage(location.protocol)');
    expect(html).toContain('This build needs a web server');
    // Shell contract: chrome must not hold focus after activation — the
    // runtime's keyboard-capture gate treats a focused element outside
    // #hearth-mount as editor/shell chrome and stops capturing, so a
    // fullscreen click that left the button focused would go keyboard-dead.
    expect(html).toMatch(/hearth-fullscreen[\s\S]*?this\.blur\(\)/);
    // No external requests: nothing loaded from another origin.
    expect(html).not.toMatch(/https?:\/\//);

    expect(await fs.readFile('/proj/export/web/hearth-player.js')).toBe(STUB_PLAYER);

    const bundle = JSON.parse(await fs.readFile('/proj/export/web/project.bundle.json')) as WebExportBundle;
    expect((bundle.project as any).name).toBe('Export Game');
    expect(bundle.scenes.length).toBe(1);
    expect(bundle.scenes[0].entities.length).toBeGreaterThan(0);
    // createScript defaults to Lua; the bundle ships the .lua source.
    expect(bundle.scripts['scripts/player-move.lua']).toContain('onUpdate');
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
    // Single-file builds never fetch anything, so the file:// check (which
    // only guards the fetch-based folder build's boot path) has nothing to
    // guard here and is not inlined.
    expect(html).not.toContain('fileProtocolBootMessage');
  });
});

describe('fileProtocolBootMessage (F-2, L-118 export-friction reaudit)', () => {
  it('returns the human message for a file:// open', () => {
    expect(fileProtocolBootMessage('file:')).toBe(
      'This build needs a web server — run one locally (e.g. npx serve) or use the single-file export for direct opening.',
    );
  });

  it('returns null for a normal hosted protocol', () => {
    expect(fileProtocolBootMessage('http:')).toBeNull();
    expect(fileProtocolBootMessage('https:')).toBeNull();
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

describe('exportWeb prefab payloads', () => {
  /** Add a Coin prefab (serialized from the default Player entity) to a session. */
  async function withPrefab(session: any) {
    const created = await session.execute<any>('createPrefab', {
      scene: 'Main',
      entity: 'Player',
      name: 'Coin',
    });
    expect(created.success).toBe(true);
    return created.data.asset.id as string;
  }

  it('ships the prefab payload as a real file + bundle entry (multi-file)', async () => {
    const { session, fs } = await makeSession(stubResources);
    await withPrefab(session);

    const result = await session.execute<any>('exportWeb', {});
    expect(result.success).toBe(true);

    const bundle = JSON.parse(await fs.readFile('/proj/export/web/project.bundle.json')) as WebExportBundle;
    const prefab = bundle.assets.find((a) => a.type === 'prefab');
    expect(prefab).toBeDefined();
    expect(prefab?.name).toBe('Coin');
    // Multi-file ships content as a copied file the player fetches into its fs.
    expect(prefab?.path).toMatch(/\.prefab\.json$/);
    expect(prefab?.dataUri).toBeUndefined();
    const payload = JSON.parse(await fs.readFile(`/proj/export/web/${prefab!.path}`));
    expect(payload.name).toBe('Coin');
    expect(Array.isArray(payload.entities)).toBe(true);
    expect(payload.entities.length).toBeGreaterThan(0);
  });

  it('inlines the prefab payload as a data URI (single-file)', async () => {
    const { session, fs } = await makeSession(stubResources);
    await withPrefab(session);

    const result = await session.execute<any>('exportWeb', { singleFile: true });
    expect(result.success).toBe(true);

    const html = await fs.readFile('/proj/export/web/index.html');
    const bundleMatch = html.match(/^\s*var bundle = (\{.*\});$/m);
    expect(bundleMatch).toBeTruthy();
    const bundle = JSON.parse(bundleMatch![1]) as WebExportBundle;

    const prefab = bundle.assets.find((a) => a.type === 'prefab');
    expect(prefab).toBeDefined();
    expect(prefab?.dataUri).toMatch(/^data:application\/json;base64,/);
    // Decode the inlined payload back and confirm it is the real prefab JSON.
    const base64 = prefab!.dataUri!.slice(prefab!.dataUri!.indexOf(',') + 1);
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    expect(payload.name).toBe('Coin');
    expect(Array.isArray(payload.entities)).toBe(true);
    expect(payload.entities.length).toBeGreaterThan(0);
  });
});

describe('exportWeb bundle asset metadata', () => {
  it('carries asset metadata (e.g., spritesheet frames) through to the bundle', async () => {
    const { session, fs } = await makeSession(stubResources);

    // Create a sprite and slice it as a spritesheet
    const spriteResult = await session.execute<any>('createSpriteAsset', {
      name: 'mysheet',
      shape: 'rectangle',
      width: 64,
      height: 64,
    });
    expect(spriteResult.success).toBe(true);

    const sliceResult = await session.execute<any>('sliceSpritesheet', {
      asset: 'mysheet',
      frameWidth: 32,
      frameHeight: 32,
      margin: 0,
      spacing: 0,
    });
    expect(sliceResult.success).toBe(true);
    expect(sliceResult.data.frameCount).toBeGreaterThan(0);

    // Export and verify metadata is in the bundle
    const exportResult = await session.execute<any>('exportWeb', {});
    expect(exportResult.success).toBe(true);

    const bundle = JSON.parse(await fs.readFile('/proj/export/web/project.bundle.json')) as WebExportBundle;

    // Find the mysheet asset in the bundle
    const sheetAsset = bundle.assets.find(a => a.name === 'mysheet');
    expect(sheetAsset).toBeDefined();
    expect(sheetAsset?.metadata).toBeDefined();
    expect(sheetAsset?.metadata?.frames).toBeDefined();
    expect(Array.isArray(sheetAsset?.metadata?.frames)).toBe(true);
    expect((sheetAsset?.metadata?.frames as any[]).length).toBeGreaterThan(0);
    expect((sheetAsset?.metadata?.frames as any[])[0]).toHaveProperty('name');
    expect((sheetAsset?.metadata?.frames as any[])[0]).toHaveProperty('x');
    expect((sheetAsset?.metadata?.frames as any[])[0]).toHaveProperty('y');
  });

  it('carries metadata for single-file exports too', async () => {
    const { session, fs } = await makeSession(stubResources);

    const spriteResult = await session.execute<any>('createSpriteAsset', {
      name: 'singlesheet',
      shape: 'circle',
      width: 64,
      height: 64,
    });
    expect(spriteResult.success).toBe(true);

    const sliceResult = await session.execute<any>('sliceSpritesheet', {
      asset: 'singlesheet',
      frameWidth: 32,
      frameHeight: 32,
    });
    expect(sliceResult.success).toBe(true);

    const exportResult = await session.execute<any>('exportWeb', { singleFile: true });
    expect(exportResult.success).toBe(true);

    const html = await fs.readFile('/proj/export/web/index.html');
    expect(html).toContain('data:');

    // Single-file inlines the bundle as one line of JSON.stringify output
    // (`var bundle = {...};`). Extract and parse it so the assertions cover
    // the real structure, mirroring the multi-file metadata test above.
    const bundleMatch = html.match(/^\s*var bundle = (\{.*\});$/m);
    expect(bundleMatch).toBeTruthy();
    const bundle = JSON.parse(bundleMatch![1]) as WebExportBundle;

    const sheetAsset = bundle.assets.find((a) => a.name === 'singlesheet');
    expect(sheetAsset).toBeDefined();
    expect(sheetAsset?.dataUri).toMatch(/^data:/);
    expect(sheetAsset?.metadata).toBeDefined();
    const frames = sheetAsset?.metadata?.frames as any[];
    expect(Array.isArray(frames)).toBe(true);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toHaveProperty('name');
    expect(frames[0]).toHaveProperty('x');
    expect(frames[0]).toHaveProperty('y');
  });
});
