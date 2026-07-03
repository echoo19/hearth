/**
 * exportWeb × buildSettings.loading — the no-chrome export contract:
 * user-controlled loading visuals flow into index.html, the loading image
 * ships in the bundle even when no scene references it, and nothing
 * Hearth-branded appears anywhere in the generated page.
 */
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
const stubResources: CommandResources = { getPlayerBundle: async () => STUB_PLAYER };

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Loading Game' });
  const session = HearthSession.fromStore(store, { granted: ALL, resources: stubResources });
  return { fs, session, store };
}

describe('exportWeb loading settings → index.html', () => {
  it('uses loading.backgroundColor as the page and status background', async () => {
    const { session, store, fs } = await makeSession();
    store.project.buildSettings.loading.backgroundColor = '#123456';
    const result = await session.execute<any>('exportWeb', {});
    expect(result.success).toBe(true);

    const html = await fs.readFile('/proj/export/web/index.html');
    expect(html).toContain('background: #123456');
    // Light backgrounds get dark status text; dark ones get light text.
    expect(html).toContain('color: #ffffff');
  });

  it('defaults the background to #000000 when loading is untouched', async () => {
    const { session, fs } = await makeSession();
    const result = await session.execute<any>('exportWeb', {});
    expect(result.success).toBe(true);
    expect(await fs.readFile('/proj/export/web/index.html')).toContain('background: #000000');
  });

  it('titles the page from buildSettings.title, falling back to the project name', async () => {
    const { session, store, fs } = await makeSession();
    const first = await session.execute<any>('exportWeb', {});
    expect(first.success).toBe(true);
    expect(await fs.readFile('/proj/export/web/index.html')).toContain(
      '<title>Loading Game</title>',
    );

    store.project.buildSettings.title = 'My Custom Title';
    const second = await session.execute<any>('exportWeb', { outDir: 'export/titled' });
    expect(second.success).toBe(true);
    expect(await fs.readFile('/proj/export/titled/index.html')).toContain(
      '<title>My Custom Title</title>',
    );
  });

  it('rejects hostile backgroundColor values instead of injecting them', async () => {
    const { session, store, fs } = await makeSession();
    store.project.buildSettings.loading.backgroundColor = '</style><script>alert(1)</script>';
    const result = await session.execute<any>('exportWeb', {});
    expect(result.success).toBe(true);
    const html = await fs.readFile('/proj/export/web/index.html');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('background: #000000');
  });

  it('contains no Hearth engine branding anywhere in the page', async () => {
    const { session, fs } = await makeSession();
    const result = await session.execute<any>('exportWeb', {});
    expect(result.success).toBe(true);
    const html = await fs.readFile('/proj/export/web/index.html');
    for (const leak of ['#141019', '#F76B15', 'Click to start', 'flame', 'hearth-pulse']) {
      expect(html).not.toContain(leak);
    }
    // The page shows no text at all unless boot fails.
    expect(html).not.toContain('Loading&hellip;');
  });
});

describe('exportWeb loading.image bundling', () => {
  async function withLoadingImage() {
    const { session, store, fs } = await makeSession();
    // An asset no scene references: only loading.image points at it.
    const created = await session.execute<any>('createSpriteAsset', {
      name: 'title-card',
      shape: 'coin',
      color: 'orange',
    });
    expect(created.success).toBe(true);
    const assetId = created.data.asset.id as string;
    expect(assetId).toBeTruthy();
    store.project.buildSettings.loading.image = assetId;
    return { session, store, fs, assetId };
  }

  it('includes the loading image in the folder bundle even when unreferenced', async () => {
    const { session, fs, assetId } = await withLoadingImage();
    const result = await session.execute<any>('exportWeb', {});
    expect(result.success).toBe(true);

    const bundle = JSON.parse(
      await fs.readFile('/proj/export/web/project.bundle.json'),
    ) as WebExportBundle;
    const entry = bundle.assets.find((a) => a.id === assetId);
    expect(entry).toBeDefined();
    expect(entry!.path).toBeTruthy();
    expect(await fs.exists(`/proj/export/web/${entry!.path}`)).toBe(true);
  });

  it('inlines the loading image as a data URI in single-file exports', async () => {
    const { session, fs } = await withLoadingImage();
    const result = await session.execute<any>('exportWeb', { singleFile: true });
    expect(result.success).toBe(true);
    const html = await fs.readFile('/proj/export/web/index.html');
    expect(html).toContain('data:image/svg+xml;base64,');
  });
});
