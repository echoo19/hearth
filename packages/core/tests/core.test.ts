import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  ProjectStore,
  generateSpriteSvg,
  resolveColor,
  createComponent,
  COMPONENT_TYPES,
  AGENT_SKILL_CONTENT,
  AGENT_SKILL_FILE,
} from '@hearth/core';

async function makeSession(granted?: any) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return {
    fs,
    session: HearthSession.fromStore(store, granted ? { granted } : {}),
    store,
  };
}

describe('project creation', () => {
  it('creates a loadable project with starter scene and agent files', async () => {
    const fs = new MemoryFileSystem();
    const { store, files } = await createProject(fs, '/proj', { name: 'My Game' });
    expect(files).toContain('hearth.json');
    expect(files).toContain('AGENTS.md');
    expect(files).toContain('CLAUDE.md');
    expect(files).toContain('.hearth/agent-config.json');
    expect(files).toContain(AGENT_SKILL_FILE);
    // Durable agent memory ships from the start (committed; the agent appends via `hearth remember`).
    expect(files).toContain('.hearth/memory.md');
    expect(store.project.name).toBe('My Game');
    expect(store.project.initialScene).not.toBeNull();
    expect(store.scenes.size).toBe(1);

    // The engine writes an initial state digest at creation (best-effort, not in
    // the returned file list since it's derived state).
    expect(await fs.exists('/proj/.hearth/digest.md')).toBe(true);
    expect(await fs.readFile('/proj/.hearth/digest.md')).toContain('My Game');

    // Reload from disk
    const reloaded = await ProjectStore.load(fs, '/proj');
    expect(reloaded.project.id).toBe(store.project.id);
    expect(reloaded.getScene('Main')?.entities.length).toBe(3);
  });

  it('scaffolds the project-local best-practices skill from the embedded canonical copy', async () => {
    const fs = new MemoryFileSystem();
    await createProject(fs, '/proj', { name: 'My Game' });
    const skill = await fs.readFile(`/proj/${AGENT_SKILL_FILE}`);
    expect(skill).toBe(AGENT_SKILL_CONTENT);
  });

  it('refuses to create a project over an existing one', async () => {
    const fs = new MemoryFileSystem();
    await createProject(fs, '/proj', { name: 'A' });
    await expect(createProject(fs, '/proj', { name: 'B' })).rejects.toThrow(/already exists/);
  });

  it('scaffolds a .gitignore covering build output and tool scratch dirs', async () => {
    const fs = new MemoryFileSystem();
    await createProject(fs, '/proj', { name: 'My Game' });
    const gitignore = await fs.readFile('/proj/.gitignore');
    expect(gitignore).toContain('build/');
    // hearth screenshot's ephemeral in-project export scratch dir: cleaned
    // up per run, but a crash mid-capture must not show up as untracked
    // files in the user's project.
    expect(gitignore).toContain('.hearth-tmp/');
    // hearth screenshot's default --out (when a caller doesn't pass one)
    // writes straight into the project root; keep that debug artifact out
    // of git status too.
    expect(gitignore).toContain('screenshot.png');
    // .mcp.json is auto-provisioned per-machine with absolute paths (the editor
    // rewrites it on open), so it must never be committed.
    expect(gitignore).toContain('.mcp.json');
    // The engine-derived state digest is a regenerated cache — ignored. Durable
    // memory (agent decisions/todos/gotchas) is authored intent — committed, so
    // it must NOT appear in the ignore list.
    expect(gitignore).toContain('.hearth/digest.md');
    expect(gitignore).not.toContain('memory.md');
  });
});

describe('isSafeOut', () => {
  it('accepts project-relative paths (including nested) and rejects absolute/traversal', async () => {
    const { isSafeOut } = await import('@hearth/core');
    expect(isSafeOut('screenshot.png')).toBe(true);
    expect(isSafeOut('shots/frame5.png')).toBe(true);
    expect(isSafeOut('/etc/passwd')).toBe(false);
    expect(isSafeOut('../escape.png')).toBe(false);
    expect(isSafeOut('shots/../../escape.png')).toBe(false);
    expect(isSafeOut('C:\\Windows\\evil.png')).toBe(false);
  });
});

describe('command system', () => {
  it('rejects unknown commands with the known-command list', async () => {
    const { session } = await makeSession();
    const result = await session.execute('notACommand');
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('UNKNOWN_COMMAND');
    expect(result.errors[0].message).toContain('createScene');
  });

  it('validates params via zod', async () => {
    const { session } = await makeSession();
    const result = await session.execute('createScene', { name: 123 });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_PARAMS');
  });

  it('enforces permission modes', async () => {
    const { session } = await makeSession(['read-only']);
    const inspect = await session.execute('inspectProject');
    expect(inspect.success).toBe(true);
    const create = await session.execute('createScene', { name: 'Blocked' });
    expect(create.success).toBe(false);
    expect(create.errors[0].code).toBe('PERMISSION_DENIED');
  });

  it('creates scenes and entities end-to-end and persists them', async () => {
    const { session, fs } = await makeSession();
    const scene = await session.execute<any>('createScene', { name: 'Level 1' });
    expect(scene.success).toBe(true);
    const sceneId = scene.data.sceneId;

    const entity = await session.execute<any>('createEntity', {
      scene: 'Level 1',
      name: 'Coin',
      position: { x: 100, y: 200 },
      components: { SpriteRenderer: { shape: 'circle', color: '#f1c40f' } },
    });
    expect(entity.success).toBe(true);
    expect(entity.data.components).toContain('Transform');
    expect(entity.data.components).toContain('SpriteRenderer');
    expect(entity.changed.some((c: any) => c.kind === 'entity' && c.action === 'created')).toBe(true);

    // Persisted?
    const raw = JSON.parse(await fs.readFile('/proj/scenes/level_1.scene.json'));
    expect(raw.entities.length).toBe(2); // camera + coin
    expect(raw.id).toBe(sceneId);
  });

  it('sets component properties by dot path with schema validation', async () => {
    const { session } = await makeSession();
    const ok = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'Transform.position.x',
      value: 123,
    });
    expect(ok.success).toBe(true);
    expect(ok.data.component.position.x).toBe(123);

    const bad = await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'SpriteRenderer.opacity',
      value: 5, // out of range
    });
    expect(bad.success).toBe(false);
    expect(bad.errors[0].code).toBe('SCHEMA_ERROR');
  });

  it('add/remove component round-trip', async () => {
    const { session } = await makeSession();
    const add = await session.execute<any>('addComponent', {
      scene: 'Main',
      entity: 'Player',
      type: 'Text',
      properties: { content: 'HP' },
    });
    expect(add.success).toBe(true);
    const dup = await session.execute('addComponent', { scene: 'Main', entity: 'Player', type: 'Text' });
    expect(dup.success).toBe(false);
    expect(dup.errors[0].code).toBe('CONFLICT');
    const rm = await session.execute('removeComponent', { scene: 'Main', entity: 'Player', type: 'Text' });
    expect(rm.success).toBe(true);
  });

  it('reparenting refuses cycles', async () => {
    const { session } = await makeSession();
    await session.execute('createEntity', { scene: 'Main', name: 'A' });
    await session.execute('createEntity', { scene: 'Main', name: 'B', parent: 'A' });
    const bad = await session.execute('moveEntity', { scene: 'Main', entity: 'A', parent: 'B' });
    expect(bad.success).toBe(false);
    expect(bad.errors[0].message).toContain('cycle');
  });

  it('duplicateEntity deep-copies a 3-level parent chain, remapping ids and offsetting only the root', async () => {
    const { session, store } = await makeSession();
    // Container (unrelated sibling, must be untouched/uncopied) and a
    // 3-level chain: Root -> Child -> Grandchild, plus a sibling of Root
    // under Container that must NOT be part of the duplicated subtree.
    await session.execute('createEntity', { scene: 'Main', name: 'Container' });
    const root = await session.execute<any>('createEntity', {
      scene: 'Main',
      name: 'Root',
      parent: 'Container',
      position: { x: 10, y: 20 },
    });
    const child = await session.execute<any>('createEntity', {
      scene: 'Main',
      name: 'Child',
      parent: 'Root',
      position: { x: 1, y: 2 },
    });
    const grandchild = await session.execute<any>('createEntity', {
      scene: 'Main',
      name: 'Grandchild',
      parent: 'Child',
      position: { x: 3, y: 4 },
    });
    await session.execute('createEntity', { scene: 'Main', name: 'RootSibling', parent: 'Container' });

    const before = store.getScene('Main')!.entities.length;
    const dup = await session.execute<any>('duplicateEntity', { scene: 'Main', entity: 'Root' });
    expect(dup.success).toBe(true);
    expect(dup.data.copiedCount).toBe(3); // Root + Child + Grandchild
    expect(dup.data.name).toBe('Root copy');

    const scene = store.getScene('Main')!;
    expect(scene.entities.length).toBe(before + 3);

    const rootCopy = scene.entities.find((e) => e.id === dup.data.entityId)!;
    expect(rootCopy).toBeDefined();
    expect(rootCopy.id).not.toBe(root.data.entityId);
    // Root copy keeps the ORIGINAL root's parent (Container), unchanged.
    const containerId = scene.entities.find((e) => e.name === 'Container')!.id;
    expect(rootCopy.parentId).toBe(containerId);
    // Offset (default 16,16) applied to the root copy only.
    expect(rootCopy.components.Transform!.position).toEqual({ x: 26, y: 36 });

    const childCopy = scene.entities.find((e) => e.parentId === rootCopy.id && e.name === 'Child')!;
    expect(childCopy).toBeDefined();
    expect(childCopy.id).not.toBe(child.data.entityId);
    // Child's own (parent-relative) position is untouched by the offset.
    expect(childCopy.components.Transform!.position).toEqual({ x: 1, y: 2 });

    const grandchildCopy = scene.entities.find((e) => e.parentId === childCopy.id && e.name === 'Grandchild')!;
    expect(grandchildCopy).toBeDefined();
    expect(grandchildCopy.id).not.toBe(grandchild.data.entityId);
    expect(grandchildCopy.components.Transform!.position).toEqual({ x: 3, y: 4 });

    // The unrelated sibling under Container was not duplicated.
    expect(scene.entities.filter((e) => e.name === 'RootSibling').length).toBe(1);
  });

  it('duplicateEntity accepts a custom name and offset', async () => {
    const { session, store } = await makeSession();
    const entity = await session.execute<any>('createEntity', {
      scene: 'Main',
      name: 'Coin',
      position: { x: 0, y: 0 },
    });
    const dup = await session.execute<any>('duplicateEntity', {
      scene: 'Main',
      entity: 'Coin',
      newName: 'Coin Two',
      offset: { x: 5, y: -5 },
    });
    expect(dup.success).toBe(true);
    expect(dup.data.name).toBe('Coin Two');
    expect(dup.data.copiedCount).toBe(1);
    const scene = store.getScene('Main')!;
    const copy = scene.entities.find((e) => e.id === dup.data.entityId)!;
    expect(copy.components.Transform!.position).toEqual({ x: 5, y: -5 });
    expect(copy.id).not.toBe(entity.data.entityId);
  });

  it('duplicateEntity 404s on an unknown entity', async () => {
    const { session } = await makeSession();
    const result = await session.execute('duplicateEntity', { scene: 'Main', entity: 'Nope' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
  });

  it('inspectPath finds walkable paths between two points', async () => {
    const { session } = await makeSession();

    // Create a scene with a wall (tilemap with solid cells)
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Wall',
      position: { x: 0, y: 0 },
      components: {
        Tilemap: {
          tileSize: 32,
          tileAssets: {},
          grid: ['####', '####', '####', '####'],
          solid: true,
          layer: 0,
        },
      },
    });

    // Query path from left of wall to right of wall
    const pathResult = await session.execute<any>('inspectPath', {
      scene: 'Main',
      from: { x: -100, y: 50 },
      to: { x: 200, y: 50 },
    });
    expect(pathResult.success).toBe(true);
    expect(pathResult.data.found).toBe(true);
    expect(pathResult.data.path).not.toBeNull();
    expect(Array.isArray(pathResult.data.path)).toBe(true);
    expect(pathResult.data.cells).toBeGreaterThan(0);
    expect(pathResult.data.cellSize).toBe(32);

    // Query path that's blocked (inside/through wall)
    const blockedResult = await session.execute<any>('inspectPath', {
      scene: 'Main',
      from: { x: 50, y: 50 },
      to: { x: 200, y: 50 },
    });
    expect(blockedResult.success).toBe(true);
    expect(blockedResult.data.found).toBe(false);
    expect(blockedResult.data.path).toBeNull();
  });

  it('inspectPath unknown scene error', async () => {
    const { session } = await makeSession();
    const result = await session.execute('inspectPath', {
      scene: 'NotAScene',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 100 },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
    expect(result.errors[0].message).toContain('Scene not found');
  });

  it('inspectPath reports an oversized grid as a command error, not a crash', async () => {
    const { session } = await makeSession();
    // A 1px-tile solid tilemap makes cellSize 1, and a far-out --to point
    // forces the grid past the 512x512 cell cap.
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'TinyWall',
      position: { x: 0, y: 0 },
      components: {
        Tilemap: { tileSize: 1, tileAssets: {}, grid: ['#'], solid: true, layer: 0 },
      },
    });
    const result = await session.execute('inspectPath', {
      scene: 'Main',
      from: { x: 0, y: 0 },
      to: { x: 5000, y: 5000 },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
    expect(result.errors[0].message).toMatch(/max 512x512/);
  });

  it('inspectPath ignores disabled entities as obstacles, matching runtime behavior', async () => {
    const { session } = await makeSession();

    // A disabled wall must not block the path — SceneRuntime never spawns
    // (or considers) entities with enabled: false, so the authored-scene
    // query has to agree.
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Wall',
      position: { x: 0, y: 0 },
      components: {
        Tilemap: {
          tileSize: 32,
          tileAssets: {},
          grid: ['####', '####', '####', '####'],
          solid: true,
          layer: 0,
        },
      },
    });
    await session.execute('setEntityEnabled', { scene: 'Main', entity: 'Wall', enabled: false });

    const pathResult = await session.execute<any>('inspectPath', {
      scene: 'Main',
      from: { x: 50, y: 50 },
      to: { x: 200, y: 50 },
    });
    expect(pathResult.success).toBe(true);
    expect(pathResult.data.found).toBe(true);
    expect(pathResult.data.path).not.toBeNull();
  });
});

describe('scripts', () => {
  it('createScript/attachScript/readScript flow', async () => {
    const { session } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'Player Move' });
    expect(created.success).toBe(true);
    expect(created.data.path).toBe('scripts/player-move.lua');

    const attach = await session.execute<any>('attachScript', {
      scene: 'Main',
      entity: 'Player',
      script: 'scripts/player-move.lua',
      params: { speed: 200 },
    });
    expect(attach.success).toBe(true);

    const read = await session.execute<any>('readScript', { path: 'scripts/player-move.lua' });
    expect(read.success).toBe(true);
    expect(read.data.source).toContain('onUpdate');

    const scripts = await session.execute<any>('inspectScripts');
    expect(scripts.data.scripts[0].attachedTo[0].entityName).toBe('Player');
  });

  it('inspectProject additively lists script paths alongside scriptCount', async () => {
    const { session } = await makeSession();
    await session.execute<any>('createScript', { name: 'Player Move' });
    await session.execute<any>('createScript', { name: 'Enemy AI', language: 'js' });

    const inspect = await session.execute<any>('inspectProject');
    expect(inspect.success).toBe(true);
    expect(inspect.data.scriptCount).toBe(2);
    expect(inspect.data.scripts).toEqual(['scripts/enemy-ai.js', 'scripts/player-move.lua']);
  });

  it('code-edit permission gates script commands', async () => {
    const { session } = await makeSession(['read-only', 'safe-edit']);
    const created = await session.execute('createScript', { name: 'x' });
    expect(created.success).toBe(false);
    expect(created.errors[0].code).toBe('PERMISSION_DENIED');
  });

  it('editScript rejects paths outside scripts/', async () => {
    const { session } = await makeSession();
    const result = await session.execute('editScript', { path: '../evil.js', source: '' });
    expect(result.success).toBe(false);
  });

  it('editScript rejects the traversal payload scripts/../hearth.json with INVALID_INPUT and never writes it', async () => {
    const { session, fs } = await makeSession();
    const before = await fs.readFile('/proj/hearth.json');
    const result = await session.execute('editScript', { path: 'scripts/../hearth.json', source: 'clobbered' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
    expect(await fs.readFile('/proj/hearth.json')).toBe(before);
  });

  it('editScript rejects the traversal payload scripts/../scenes/x.json with INVALID_INPUT', async () => {
    const { session } = await makeSession();
    const result = await session.execute('editScript', { path: 'scripts/../scenes/x.json', source: '' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });
});

describe('assets', () => {
  it('creates procedural sprites and validates references', async () => {
    const { session } = await makeSession();
    const asset = await session.execute<any>('createSpriteAsset', {
      name: 'coin',
      shape: 'coin',
      color: 'yellow',
      width: 24,
      height: 24,
    });
    expect(asset.success).toBe(true);
    const assetId = asset.data.asset.id;

    const set = await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'SpriteRenderer.assetId',
      value: assetId,
    });
    expect(set.success).toBe(true);

    const validation = await session.execute<any>('validateProject');
    expect(validation.data.errors).toEqual([]);

    // Unknown asset reference should be a validation error
    await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'SpriteRenderer.assetId',
      value: 'ast_doesnotexist',
    });
    const invalid = await session.execute<any>('validateProject');
    expect(invalid.data.errors.some((e: any) => e.code === 'MISSING_SPRITE_ASSET')).toBe(true);
  });

  it('removeAsset refuses when referenced', async () => {
    const { session } = await makeSession();
    const asset = await session.execute<any>('createSpriteAsset', { name: 'p1', shape: 'character', color: 'blue' });
    await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'SpriteRenderer.assetId',
      value: asset.data.asset.id,
    });
    const rm = await session.execute('removeAsset', { asset: 'p1' });
    expect(rm.success).toBe(false);
    expect(rm.errors[0].code).toBe('CONFLICT');
  });

  it('animation assets require existing frames', async () => {
    const { session } = await makeSession();
    await session.execute('createSpriteAsset', { name: 'f1', shape: 'circle', color: 'red' });
    await session.execute('createSpriteAsset', { name: 'f2', shape: 'circle', color: 'orange' });
    const anim = await session.execute<any>('createAnimationAsset', { name: 'blink', frames: ['f1', 'f2'] });
    expect(anim.success).toBe(true);
    expect(anim.data.frames.length).toBe(2);
    const bad = await session.execute('createAnimationAsset', { name: 'bad', frames: ['nope'] });
    expect(bad.success).toBe(false);
  });
});

describe('diff & snapshot', () => {
  it('snapshot -> change -> diff -> revert round-trip', async () => {
    const { session, store } = await makeSession();
    await session.execute('snapshotProject');

    await session.execute('createEntity', { scene: 'Main', name: 'Enemy', tags: ['enemy'] });
    await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'Transform.position.x',
      value: 999,
    });
    await session.execute('createScript', { name: 'enemy-ai' });

    const diff = await session.execute<any>('diffProject');
    expect(diff.success).toBe(true);
    expect(diff.data.hasChanges).toBe(true);
    expect(diff.data.stats.entitiesAdded).toBe(1);
    expect(diff.data.stats.entitiesModified).toBe(1);
    expect(diff.data.scripts.some((s: any) => s.path === 'scripts/enemy-ai.lua' && s.status === 'added')).toBe(true);
    const playerDiff = diff.data.scenes[0].entities.find((e: any) => e.name === 'Player');
    expect(playerDiff.components[0].changes[0]).toMatchObject({
      path: 'position.x',
      before: 400,
      after: 999,
    });

    const revert = await session.execute('revertProject', { confirm: true });
    expect(revert.success).toBe(true);
    const diff2 = await session.execute<any>('diffProject');
    expect(diff2.data.hasChanges).toBe(false);
    expect(store.getScene('Main')!.entities.find((e) => e.name === 'Enemy')).toBeUndefined();
  });

  it('a pre-0.11 baseline without a codeStyle key does not phantom-diff against the live project', async () => {
    const { fs, session, store } = await makeSession();

    // Simulate a v0.10.x checkpoint: snapshot, then strip the codeStyle key
    // the old core never wrote (codeStyle is new in 0.11). The live project
    // still gets codeStyle defaulted in by ProjectFileSchema.parse at load
    // time, so a naive raw-JSON diff would report a phantom "codeStyle added"
    // project change even though nothing actually changed.
    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);
    const baselinePath = '/proj/.hearth/baseline.json';
    const baseline = JSON.parse(await fs.readFile(baselinePath));
    expect(baseline.project.codeStyle).toBeDefined();
    delete baseline.project.codeStyle;
    await fs.writeFile(baselinePath, JSON.stringify(baseline));

    const diff = await session.execute<any>('diffProject');
    expect(diff.success).toBe(true);
    expect(diff.data.hasChanges).toBe(false);
    expect(diff.data.projectChanges).toEqual([]);

    // Revert must not clobber the live default with `undefined` either.
    const revert = await session.execute<any>('revertProject', { confirm: true });
    expect(revert.success).toBe(true);
    expect(store.project.codeStyle).toEqual({ formatOnSave: true });
  });

  it('a pre-0.10 baseline whose Camera lacks postEffects does not phantom-diff against the live default []', async () => {
    const { fs, session } = await makeSession();

    // Simulate a pre-0.10 checkpoint: snapshot, then strip `postEffects` from
    // the starter scene's Main Camera component (postEffects is new in 0.10,
    // so an old core never wrote it). The live scene still gets postEffects
    // defaulted in by CameraSchema.parse at load time (via ProjectStore.load
    // -> SceneSchema.parse), so this is the same phantom-diff class as
    // project.codeStyle above, but at the component level: does loadBaseline's
    // project-only re-parse also cover scenes, or does the differ need its
    // own component-schema normalization pass?
    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);
    const baselinePath = '/proj/.hearth/baseline.json';
    const baseline = JSON.parse(await fs.readFile(baselinePath));
    const mainScene = Object.values(baseline.scenes as Record<string, any>).find(
      (s: any) => s.name === 'Main',
    ) as any;
    const cameraEntity = mainScene.entities.find((e: any) => e.components.Camera);
    expect(cameraEntity.components.Camera.postEffects).toEqual([]);
    delete cameraEntity.components.Camera.postEffects;
    await fs.writeFile(baselinePath, JSON.stringify(baseline));

    const diff = await session.execute<any>('diffProject');
    expect(diff.success).toBe(true);
    expect(diff.data.hasChanges).toBe(false);
    expect(diff.data.scenes).toEqual([]);
  });

  it('a baseline scene with an unrecognized component type does not crash diffProject', async () => {
    const { fs, session } = await makeSession();

    // Simulate a baseline written by a DIFFERENT core version whose schema
    // knew a component type this one doesn't. ComponentMapSchema is
    // .strict(), so loadBaseline's normalizing SceneSchema re-parse rejects
    // the whole scene — that must degrade to diffing the raw snapshot (the
    // pre-normalization behavior), never blow up diffProject/revertProject.
    // Normalization is an enhancement, not a gate.
    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);
    const baselinePath = '/proj/.hearth/baseline.json';
    const baseline = JSON.parse(await fs.readFile(baselinePath));
    const mainScene = Object.values(baseline.scenes as Record<string, any>).find(
      (s: any) => s.name === 'Main',
    ) as any;
    const cameraEntity = mainScene.entities.find((e: any) => e.components.Camera);
    cameraEntity.components.NotARealComponent = { some: 'data' };
    await fs.writeFile(baselinePath, JSON.stringify(baseline));

    const diff = await session.execute<any>('diffProject');
    expect(diff.success).toBe(true);
    // The raw diff still makes sense: the unknown baseline-only component
    // reads as removed relative to the current state.
    expect(diff.data.hasChanges).toBe(true);
    const entityDiff = diff.data.scenes[0].entities.find((e: any) =>
      e.components.some((c: any) => c.type === 'NotARealComponent'),
    );
    expect(entityDiff.components).toEqual([
      { type: 'NotARealComponent', status: 'removed', changes: [] },
    ]);
  });

  it('a genuine postEffects change still surfaces as a diff after baseline normalization', async () => {
    const { session } = await makeSession();

    // Pin that the normalizing re-parse never masks REAL changes: snapshot,
    // then actually add a post effect to the live Camera.
    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);
    const set = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: 'Main Camera',
      property: 'Camera.postEffects',
      value: [{ type: 'bloom', strength: 2, threshold: 0.5 }],
    });
    expect(set.success).toBe(true);

    const diff = await session.execute<any>('diffProject');
    expect(diff.success).toBe(true);
    expect(diff.data.hasChanges).toBe(true);
    const cameraDiff = diff.data.scenes[0].entities
      .flatMap((e: any) => e.components)
      .find((c: any) => c.type === 'Camera');
    expect(cameraDiff.status).toBe('modified');
    expect(cameraDiff.changes).toEqual([
      {
        path: 'postEffects',
        before: [],
        after: [{ type: 'bloom', strength: 2, threshold: 0.5 }],
      },
    ]);
  });

  it('a baseline project file in an old shape does not crash diffProject/revertProject', async () => {
    const { fs, session, store } = await makeSession();

    // Simulate a baseline written by a DIFFERENT core version whose project
    // shape this one can't validate (e.g. a formatVersion that predates the
    // current literal). ProjectFileSchema.parse throws a ZodError on this,
    // same failure class as the scene-level ComponentMapSchema case above —
    // the fix must mirror that posture exactly: safeParse, and on failure
    // fall back to the raw project snapshot rather than taking
    // diffProject/revertProject down. Normalization is an enhancement,
    // never a gate.
    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);
    const baselinePath = '/proj/.hearth/baseline.json';
    const baseline = JSON.parse(await fs.readFile(baselinePath));
    baseline.project.formatVersion = 0; // not the current literal FORMAT_VERSION
    await fs.writeFile(baselinePath, JSON.stringify(baseline));

    const diff = await session.execute<any>('diffProject');
    expect(diff.success).toBe(true);
    // The raw (un-normalized) baseline still diffs sensibly: formatVersion
    // reads as changed relative to the live project's normalized value.
    expect(diff.data.projectChanges).toEqual(
      expect.arrayContaining([{ path: 'formatVersion', before: 0, after: 1 }]),
    );

    const revert = await session.execute<any>('revertProject', { confirm: true });
    expect(revert.success).toBe(true);
    expect(store.project.formatVersion).toBe(0);
  });
});

describe('playtests & build', () => {
  it('creates playtests and lists them', async () => {
    const { session } = await makeSession();
    const pt = await session.execute<any>('createPlaytest', {
      name: 'smoke',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 10 },
        { type: 'assertEntityExists', entity: 'Player', exists: true },
        { type: 'assertNoErrors' },
      ],
    });
    expect(pt.success).toBe(true);
    const list = await session.execute<any>('listPlaytests');
    expect(list.data.playtests.length).toBe(1);
  });

  it('assertEventCount schema rejects step with no equals/min/max', async () => {
    const { session } = await makeSession();
    const pt = await session.execute('createPlaytest', {
      name: 'invalid',
      scene: 'Main',
      steps: [{ type: 'assertEventCount', event: 'coin' }],
    });
    expect(pt.success).toBe(false);
    expect(pt.errors[0].message).toContain('assertEventCount requires at least one of equals, min, or max');
  });

  it('assertEventCount schema accepts step with min', async () => {
    const { session } = await makeSession();
    const pt = await session.execute<any>('createPlaytest', {
      name: 'valid',
      scene: 'Main',
      steps: [{ type: 'assertEventCount', event: 'coin', min: 1 }],
    });
    expect(pt.success).toBe(true);
  });

  it('assertAudioCount schema rejects step with no equals/min/max', async () => {
    const { session } = await makeSession();
    const pt = await session.execute('createPlaytest', {
      name: 'invalid',
      scene: 'Main',
      steps: [{ type: 'assertAudioCount', action: 'play' }],
    });
    expect(pt.success).toBe(false);
    expect(pt.errors[0].message).toContain('assertAudioCount requires at least one of equals, min, or max');
  });

  it('assertAudioCount schema accepts step with min', async () => {
    const { session } = await makeSession();
    const pt = await session.execute<any>('createPlaytest', {
      name: 'valid',
      scene: 'Main',
      steps: [{ type: 'assertAudioCount', action: 'play', min: 1 }],
    });
    expect(pt.success).toBe(true);
  });

  it('assertCameraEffect schema rejects step with no equals/min/max', async () => {
    const { session } = await makeSession();
    const pt = await session.execute('createPlaytest', {
      name: 'invalid',
      scene: 'Main',
      steps: [{ type: 'assertCameraEffect', effect: 'shake' }],
    });
    expect(pt.success).toBe(false);
    expect(pt.errors[0].message).toContain('assertCameraEffect requires at least one of equals, min, or max');
  });

  it('assertCameraEffect schema accepts step with min', async () => {
    const { session } = await makeSession();
    const pt = await session.execute<any>('createPlaytest', {
      name: 'valid',
      scene: 'Main',
      steps: [{ type: 'assertCameraEffect', effect: 'shake', min: 1 }],
    });
    expect(pt.success).toBe(true);
  });

  it('build requires the build permission and a valid project', async () => {
    const { session } = await makeSession(['read-only', 'safe-edit']);
    const denied = await session.execute('buildProject');
    expect(denied.errors[0]?.code).toBe('PERMISSION_DENIED');

    const { session: fullSession, fs } = await makeSession(['read-only', 'safe-edit', 'build']);
    const built = await fullSession.execute<any>('buildProject');
    expect(built.success).toBe(true);
    expect(await fs.exists('/proj/build/test_game/build-manifest.json')).toBe(true);
    expect(await fs.exists('/proj/build/test_game/hearth.json')).toBe(true);
  });
});

describe('procedural sprites', () => {
  it('generates deterministic SVG', () => {
    const a = generateSpriteSvg({ shape: 'character', color: '#3498db', width: 32, height: 48 });
    const b = generateSpriteSvg({ shape: 'character', color: '#3498db', width: 32, height: 48 });
    expect(a).toBe(b);
    expect(a).toContain('<svg');
    expect(a).toContain('viewBox="0 0 32 48"');
  });

  it('resolves named colors', () => {
    expect(resolveColor('red')).toBe('#e74c3c');
    expect(resolveColor('#ABC')).toBe('#abc');
    expect(() => resolveColor('not-a-color')).toThrow(/Unknown color/);
  });
});

describe('component schemas', () => {
  it('all component types produce valid defaults', () => {
    for (const type of COMPONENT_TYPES) {
      expect(() => createComponent(type)).not.toThrow();
    }
  });
});

describe('path helpers', () => {
  it('basenamePath handles POSIX and Windows separators', async () => {
    const { basenamePath } = await import('@hearth/core');
    expect(basenamePath('assets/sprites/coin.svg')).toBe('coin.svg');
    expect(basenamePath('C:\\Users\\runner\\proj\\assets\\imported\\pic.png')).toBe('pic.png');
    expect(basenamePath('C:\\proj\\assets/imported/pic.png')).toBe('pic.png');
    expect(basenamePath('pic.png')).toBe('pic.png');
  });
});
