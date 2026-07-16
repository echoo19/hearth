import { describe, it, expect } from 'vitest';
import {
  HEARTH_VERSION,
  HearthSession,
  MemoryFileSystem,
  ProjectError,
  ProjectStore,
  applyProjectMigrations,
  validateProject,
  type FsLike,
  type ProjectMigration,
} from '@hearth/core';

class CountingFileSystem implements FsLike {
  writes: string[] = [];

  constructor(private readonly inner = new MemoryFileSystem()) {}

  readFile(path: string) {
    return this.inner.readFile(path);
  }

  readFileBinary(path: string) {
    return this.inner.readFileBinary(path);
  }

  async writeFile(path: string, content: string | Uint8Array) {
    this.writes.push(path);
    await this.inner.writeFile(path, content);
  }

  appendFile(path: string, text: string) {
    return this.inner.appendFile(path, text);
  }

  exists(path: string) {
    return this.inner.exists(path);
  }

  mkdir(path: string) {
    return this.inner.mkdir(path);
  }

  readdir(path: string) {
    return this.inner.readdir(path);
  }

  stat(path: string) {
    return this.inner.stat(path);
  }

  remove(path: string) {
    return this.inner.remove(path);
  }

  copyFile(src: string, dest: string) {
    return this.inner.copyFile(src, dest);
  }
}

async function writeFixture(fs: FsLike, version: string) {
  await fs.mkdir('/proj/scenes');
  await fs.mkdir('/proj/scripts');
  await fs.mkdir('/proj/assets/sprites');
  await fs.writeFile(
    '/proj/hearth.json',
    JSON.stringify(
      {
        formatVersion: 1,
        hearthVersion: version,
        id: 'prj_upgrade',
        name: `Upgrade ${version}`,
        description: '',
        initialScene: 'scn_main',
        scenes: [{ id: 'scn_main', name: 'Main', path: 'scenes/main.scene.json' }],
        inputMappings: { actions: { jump: ['Space'] } },
        buildSettings: { width: 320, height: 180, title: 'Upgrade' },
      },
      null,
      2,
    ) + '\n',
  );
  await fs.writeFile(
    '/proj/scenes/main.scene.json',
    JSON.stringify(
      {
        formatVersion: 1,
        id: 'scn_main',
        name: 'Main',
        entities: [
          {
            id: 'ent_camera',
            name: 'Main Camera',
            parentId: null,
            enabled: true,
            tags: [],
            components: {
              Transform: { position: { x: 160, y: 90 }, rotation: 0, scale: { x: 1, y: 1 } },
              Camera: { zoom: 1, backgroundColor: '#1a1a2e', main: true },
            },
          },
          {
            id: 'ent_coin',
            name: 'Coin',
            parentId: null,
            enabled: true,
            tags: ['pickup'],
            components: {
              Transform: { position: { x: 80, y: 90 }, rotation: 0, scale: { x: 1, y: 1 } },
              SpriteRenderer: {
                shape: 'rectangle',
                color: '#f1c40f',
                width: 16,
                height: 16,
                opacity: 1,
                assetId: 'ast_coin',
              },
              Script: { path: 'scripts/coin.lua', params: {} },
            },
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  await fs.writeFile(
    '/proj/assets.json',
    JSON.stringify(
      {
        formatVersion: 1,
        assets: [{ id: 'ast_coin', name: 'coin', type: 'sprite', path: 'assets/sprites/coin.svg', metadata: {} }],
      },
      null,
      2,
    ) + '\n',
  );
  await fs.writeFile('/proj/scripts/coin.lua', 'return {}\n');
  await fs.writeFile('/proj/assets/sprites/coin.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
}

describe('project migrations', () => {
  for (const version of ['0.13.0', '0.14.0']) {
    it(`opens ${version} projects without writing and stamps on first edit`, async () => {
      const fs = new CountingFileSystem();
      await writeFixture(fs, version);
      const original = await fs.readFile('/proj/hearth.json');
      fs.writes = [];

      const session = await HearthSession.open(fs, '/proj');

      expect(fs.writes).toEqual([]);
      expect(await fs.readFile('/proj/hearth.json')).toBe(original);
      expect(session.store.project.hearthVersion).toBe(version);
      await expect(validateProject(session.store)).resolves.toMatchObject({ errors: [] });

      const result = await session.execute('setComponentProperty', {
        scene: 'Main',
        entity: 'Coin',
        property: 'Transform.position.x',
        value: 96,
      });

      expect(result.success).toBe(true);
      expect(session.store.project.hearthVersion).toBe(HEARTH_VERSION);
      expect(session.store.getScene('Main')?.entities.find((e) => e.name === 'Coin')?.components.Transform.position.x).toBe(96);
      await expect(validateProject(session.store)).resolves.toMatchObject({ errors: [] });

      const saved = JSON.parse(await fs.readFile('/proj/hearth.json'));
      expect(saved.hearthVersion).toBe(HEARTH_VERSION);

      const undo = await session.execute('undo');
      expect(undo.success).toBe(true);
      expect(session.store.project.hearthVersion).toBe(version);
      expect(session.store.getScene('Main')?.entities.find((e) => e.name === 'Coin')?.components.Transform.position.x).toBe(80);
    });
  }

  it('applies migrations in fromBelow order without mutating the input', () => {
    const seen: string[] = [];
    const migrations: ProjectMigration[] = [
      { fromBelow: '0.15.0', describe: 'second', apply: (doc) => void seen.push(`${doc.hearthVersion}:second`) },
      { fromBelow: '0.14.0', describe: 'first', apply: (doc) => void seen.push(`${doc.hearthVersion}:first`) },
    ];
    const raw = { hearthVersion: '0.13.0', id: 'prj_x' };

    const migrated = applyProjectMigrations(raw, '0.15.0', migrations);

    expect(seen).toEqual(['0.13.0:first', '0.13.0:second']);
    expect(migrated).toEqual(raw);
    expect(migrated).not.toBe(raw);
  });

  it('keeps test migrations idempotent when run repeatedly', () => {
    const migrations: ProjectMigration[] = [
      {
        fromBelow: '0.14.0',
        describe: 'adds a missing compatibility bucket',
        apply(doc) {
          doc.compat ??= {};
        },
      },
    ];

    const once = applyProjectMigrations({ hearthVersion: '0.13.0' }, '0.15.0', migrations);
    const twice = applyProjectMigrations(once, '0.15.0', migrations);

    expect(twice).toEqual(once);
  });

  it('rejects projects stamped newer than the running engine', async () => {
    const fs = new CountingFileSystem();
    await writeFixture(fs, '99.0.0');
    fs.writes = [];

    await expect(ProjectStore.load(fs, '/proj')).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROJECT_VERSION',
    } satisfies Partial<ProjectError>);
    expect(fs.writes).toEqual([]);
  });
});
