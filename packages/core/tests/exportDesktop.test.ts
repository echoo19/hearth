import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  listCommands,
  BuildSettingsSchema,
  type CommandResources,
  type DesktopBuildSpec,
  type DesktopBuildResult,
} from '@hearth/core';

const STUB_PLAYER = 'window.HearthPlayer={boot(){}}';
const ALL: any = ['read-only', 'safe-edit', 'code-edit', 'asset-edit', 'build'];

/**
 * A real, decodable 16x16 RGB checkerboard PNG (the "tile fixture"). The same
 * bytes are exercised against png2icons in @hearth/shipping/tests/icon.test.ts,
 * proving the full tile-icon → .icns/.ico pipeline, not just the plumbing.
 */
const TILE_FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIUlEQVR4nGPojtLGii5t6cGKGEY10EQDLglcBo1qoIkGAIIKkRBR+B0EAAAAAElFTkSuQmCC',
  'base64',
);

/** A packageDesktop that captures the spec it was handed and returns one build. */
function captureResources(): {
  resources: CommandResources;
  captured: () => DesktopBuildSpec | undefined;
} {
  let captured: DesktopBuildSpec | undefined;
  const resources: CommandResources = {
    getPlayerBundle: async () => STUB_PLAYER,
    packageDesktop: async (spec) => {
      captured = spec;
      const build: DesktopBuildResult = {
        platform: 'darwin-arm64',
        appDir: 'export/desktop/darwin-arm64/Game.app',
        zip: 'export/desktop/game-darwin-arm64.zip',
        signed: 'adhoc',
        notarized: false,
      };
      return [build];
    },
  };
  return { resources, captured: () => captured };
}

async function makeSession(resources?: CommandResources) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Export Game' });
  const session = HearthSession.fromStore(store, { granted: ALL, resources });
  const sprite = await session.execute<any>('createSpriteAsset', { name: 'coin', shape: 'coin', color: 'yellow' });
  expect(sprite.success).toBe(true);
  const sound = await session.execute<any>('createSound', { name: 'pickup', preset: 'coin' });
  expect(sound.success).toBe(true);
  return { fs, session, store, spriteId: sprite.data.asset.id as string, soundId: sound.data.asset.id as string };
}

describe('buildSettings.icon schema', () => {
  it('defaults to null', () => {
    expect(BuildSettingsSchema.parse({}).icon).toBe(null);
  });

  it('accepts a sprite asset id', () => {
    expect(BuildSettingsSchema.parse({ icon: 'ast_x' }).icon).toBe('ast_x');
  });

  it('rejects a non-string icon', () => {
    expect(() => BuildSettingsSchema.parse({ icon: 123 })).toThrow();
  });
});

describe('updateSettings icon round-trip', () => {
  it('sets and returns buildSettings.icon', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('updateSettings', { buildSettings: { icon: 'ast_x' } });
    expect(result.success).toBe(true);
    expect(result.data.buildSettings.icon).toBe('ast_x');
  });

  it('rejects a non-string icon', async () => {
    const { session } = await makeSession();
    const result = await session.execute('updateSettings', { buildSettings: { icon: 123 } });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_PARAMS');
  });
});

describe('registry', () => {
  it('registers exportDesktop for a total of 79 commands', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('exportDesktop');
    expect(names.length).toBe(79);
  });
});

describe('exportDesktop', () => {
  it('rejects an unknown platform id', async () => {
    const { resources } = captureResources();
    const { session } = await makeSession(resources);
    const result = await session.execute('exportDesktop', { platforms: ['bogus-plat'] });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_PARAMS');
  });

  it('fails with DESKTOP_EXPORT_UNSUPPORTED when the host provides no packager', async () => {
    const { session } = await makeSession({ getPlayerBundle: async () => STUB_PLAYER });
    const result = await session.execute('exportDesktop', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('DESKTOP_EXPORT_UNSUPPORTED');
    // Names the hosts that do support it.
    expect(result.errors[0].message).toContain('CLI');
    expect(result.errors[0].message).toContain('MCP');
    expect(result.errors[0].message).toContain('editor');
  });

  it('validates first and refuses to export a broken project', async () => {
    const { resources } = captureResources();
    const { session } = await makeSession(resources);
    await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'SpriteRenderer.assetId',
      value: 'ast_doesnotexist',
    });
    const result = await session.execute('exportDesktop', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('SCHEMA_ERROR');
  });

  it('requires the build permission', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'NoBuild' });
    const { resources } = captureResources();
    const session = HearthSession.fromStore(store, { resources }); // default modes: no build
    const result = await session.execute('exportDesktop', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PERMISSION_DENIED');
  });

  it('hands packageDesktop a web build spec and returns its builds', async () => {
    const { resources, captured } = captureResources();
    const { session } = await makeSession(resources);
    const result = await session.execute<any>('exportDesktop', {});
    expect(result.success).toBe(true);
    expect(result.data.outDir).toBe('export/desktop');
    expect(result.data.slug).toBe('export_game');
    expect(result.data.builds).toHaveLength(1);
    expect(result.data.builds[0].platform).toBe('darwin-arm64');

    const spec = captured();
    expect(spec).toBeDefined();
    expect(spec!.projectRoot).toBe('/proj');
    const paths = spec!.files.map((f) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('project.bundle.json');
    expect(paths).toContain('hearth-player.js');
    // width/height from buildSettings defaults; title falls back to project name.
    expect(spec!.width).toBe(800);
    expect(spec!.height).toBe(600);
    expect(spec!.title).toBe('Export Game');
    // Default: all four platforms.
    expect(spec!.platforms).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']);
    // No icon set → no iconPng.
    expect(spec!.iconPng).toBeUndefined();
  });

  it('prefers buildSettings.title over project name for the spec title', async () => {
    const { resources, captured } = captureResources();
    const { session } = await makeSession(resources);
    await session.execute('updateSettings', { buildSettings: { title: 'My Shiny Game' } });
    const result = await session.execute<any>('exportDesktop', {});
    expect(result.success).toBe(true);
    expect(captured()!.title).toBe('My Shiny Game');
  });

  it('decodes the project icon sprite into iconPng', async () => {
    const { resources, captured } = captureResources();
    const { session, spriteId } = await makeSession(resources);
    await session.execute('updateSettings', { buildSettings: { icon: spriteId } });
    const result = await session.execute<any>('exportDesktop', {});
    expect(result.success).toBe(true);
    const spec = captured();
    expect(spec!.iconPng).toBeInstanceOf(Uint8Array);
    expect(spec!.iconPng!.length).toBeGreaterThan(0);
  });

  it('accepts a tile asset as the icon and hands its exact PNG bytes to the packager', async () => {
    // Icon-picker parity (GAMESETTINGS-2 / L-074): the editor's icon picker
    // offers sprite AND tile assets, so exportDesktop must accept both. A
    // real PNG imported as a `tile` asset flows through byte-for-byte —
    // the packager's icon conversion is agnostic to asset type (the same
    // fixture is proven against png2icons in @hearth/shipping's icon tests).
    const { resources, captured } = captureResources();
    const { fs, session } = await makeSession(resources);
    await fs.writeFile('/fixtures/wall-tile.png', TILE_FIXTURE_PNG);
    const imported = await session.execute<any>('importAsset', {
      sourcePath: '/fixtures/wall-tile.png',
      type: 'tile',
    });
    expect(imported.success).toBe(true);
    expect(imported.data.asset.type).toBe('tile');
    const tileId = imported.data.asset.id as string;

    await session.execute('updateSettings', { buildSettings: { icon: tileId } });
    const result = await session.execute<any>('exportDesktop', {});
    expect(result.success).toBe(true);
    const spec = captured();
    expect(spec!.iconPng).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(spec!.iconPng!)).toEqual(Buffer.from(TILE_FIXTURE_PNG));
  });

  it('errors, naming the asset id, when the icon asset is missing', async () => {
    const { resources } = captureResources();
    const { session } = await makeSession(resources);
    await session.execute('updateSettings', { buildSettings: { icon: 'ast_missing' } });
    const result = await session.execute('exportDesktop', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('ast_missing');
  });

  it('errors, naming the asset id, when the icon asset is not an image (sprite/tile)', async () => {
    const { resources } = captureResources();
    const { session, soundId } = await makeSession(resources);
    await session.execute('updateSettings', { buildSettings: { icon: soundId } });
    const result = await session.execute('exportDesktop', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain(soundId);
    expect(result.errors[0].message).toContain('sprite or tile');
  });

  it('rejects unsafe outDir', async () => {
    const { resources } = captureResources();
    const { session } = await makeSession(resources);
    const result = await session.execute('exportDesktop', { outDir: '../escape' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('records a details-only journal entry with platforms and outDir', async () => {
    const { resources } = captureResources();
    const { session } = await makeSession(resources);
    const ok = await session.execute<any>('exportDesktop', { platforms: ['linux-x64'] });
    expect(ok.success).toBe(true);
    const journal = await session.execute<any>('listJournal', {});
    const entry = journal.data.entries.find((e: any) => e.command === 'exportDesktop');
    expect(entry).toBeDefined();
    expect(entry.detail).toEqual({ platforms: ['linux-x64'], outDir: 'export/desktop' });
  });
});
