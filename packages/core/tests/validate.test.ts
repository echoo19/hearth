import { describe, it, expect } from 'vitest';
import { AUTOTILE_SHAPES, MemoryFileSystem, createProject, HearthSession, readJson } from '@hearth/core';
import { validateProject, checkScriptRequires } from '../src/validate.js';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  const session = HearthSession.fromStore(store, {});
  return { fs, session, store };
}

async function createImageAsset(
  session: HearthSession,
  store: any,
  name: string,
  frames: Array<{ name: string; x: number; y: number; width: number; height: number }> = [],
) {
  const created = await session.execute<any>('createSpriteAsset', {
    name,
    shape: 'rectangle',
    color: '#ffffff',
    width: 16,
    height: 16,
  });
  expect(created.success).toBe(true);
  const asset = store.assets.assets.find((candidate: any) => candidate.id === created.data.asset.id)!;
  asset.metadata.frames = frames;
  return asset;
}

async function createTilemapEntity(
  session: HearthSession,
  tilemap: { grid: string[]; tileAssets: Record<string, unknown> },
  transform: Record<string, unknown> = {},
) {
  const created = await session.execute<any>('createEntity', {
    scene: 'Main',
    name: 'Tiles',
    components: {
      Transform: transform,
      Tilemap: tilemap,
    },
  });
  expect(created.success).toBe(true);
  return created.data.entityId as string;
}

function tilemapIssueCodes(report: Awaited<ReturnType<typeof validateProject>>): string[] {
  return [...report.errors, ...report.warnings]
    .map((issue) => issue.code)
    .filter((code) => code.startsWith('TILEMAP_'));
}

function expectTilemapIssue(
  report: Awaited<ReturnType<typeof validateProject>>,
  severity: 'errors' | 'warnings',
  code: string,
  remediation: RegExp,
) {
  const issue = report[severity].find((candidate) => candidate.code === code);
  expect(issue, `${code} must be reported in ${severity}`).toBeDefined();
  expect(issue!.message).toMatch(remediation);
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

describe('Tilemap coherence validation', () => {
  it('TILEMAP_UNMAPPED_CHAR: a used non-empty grid character has no source', async () => {
    const { session, store } = await makeSession();
    await createTilemapEntity(session, { grid: ['G'], tileAssets: {} });

    const report = await validateProject(store);

    expectTilemapIssue(report, 'errors', 'TILEMAP_UNMAPPED_CHAR', /add tileAssets\.G|replace those cells/i);
  });

  it('TILEMAP_INVALID_CHAR_KEY: a source key must be exactly one character', async () => {
    const { session, store } = await makeSession();
    const image = await createImageAsset(session, store, 'floor');
    await createTilemapEntity(session, { grid: [], tileAssets: { GG: image.id } });

    const report = await validateProject(store);

    expectTilemapIssue(report, 'errors', 'TILEMAP_INVALID_CHAR_KEY', /other than "\." or space/i);
  });

  it('TILEMAP_RESERVED_CHAR_KEY: dot and space cannot be source keys', async () => {
    const { session, store } = await makeSession();
    const image = await createImageAsset(session, store, 'floor');
    await createTilemapEntity(session, { grid: ['.'], tileAssets: { '.': image.id } });

    const report = await validateProject(store);

    expectTilemapIssue(report, 'errors', 'TILEMAP_RESERVED_CHAR_KEY', /remove.*entry.*different character/i);
  });

  it('TILEMAP_SOURCE_NOT_IMAGE: a tile source must be a sprite or tile asset', async () => {
    const { session, store } = await makeSession();
    const sound = await session.execute<any>('createSound', { name: 'not-a-tile', preset: 'coin' });
    expect(sound.success).toBe(true);
    await createTilemapEntity(session, { grid: ['G'], tileAssets: { G: sound.data.asset.id } });

    const report = await validateProject(store);

    expectTilemapIssue(report, 'errors', 'TILEMAP_SOURCE_NOT_IMAGE', /choose a sprite or tile asset/i);
  });

  it('TILEMAP_FRAME_NOT_FOUND: a fixed frame must exist on its sheet', async () => {
    const { session, store } = await makeSession();
    const sheet = await createImageAsset(session, store, 'sheet');
    await createTilemapEntity(session, {
      grid: ['G'],
      tileAssets: { G: { sheet: sheet.id, frame: 'floor_7' } },
    });

    const report = await validateProject(store);

    expectTilemapIssue(report, 'errors', 'TILEMAP_FRAME_NOT_FOUND', /slice the sheet|choose an existing frame/i);
  });

  it('TILEMAP_FRAME_NOT_SQUARE: a non-square fixed frame warns about distortion', async () => {
    const { session, store } = await makeSession();
    const sheet = await createImageAsset(session, store, 'sheet', [
      { name: 'wall', x: 0, y: 0, width: 16, height: 32 },
    ]);
    await createTilemapEntity(session, {
      grid: ['W'],
      tileAssets: { W: { sheet: sheet.id, frame: 'wall' } },
    });

    const report = await validateProject(store);

    expectTilemapIssue(report, 'warnings', 'TILEMAP_FRAME_NOT_SQUARE', /square frame|bottom-aligned SpriteRenderer/i);
  });

  it('TILEMAP_AUTOTILE_INVALID: every effective blob47 frame must exist', async () => {
    const { session, store } = await makeSession();
    const sheet = await createImageAsset(session, store, 'sheet', [
      { name: 'blob_0', x: 0, y: 0, width: 16, height: 16 },
    ]);
    await createTilemapEntity(session, {
      grid: ['G'],
      tileAssets: { G: { sheet: sheet.id, template: 'blob47' } },
    });

    const report = await validateProject(store);

    expectTilemapIssue(report, 'errors', 'TILEMAP_AUTOTILE_INVALID', /provide every effective blob47 frame/i);
  });

  it('TILEMAP_TRANSFORM_UNSUPPORTED: rotated or scaled Tilemaps warn', async () => {
    const { session, store } = await makeSession();
    await createTilemapEntity(
      session,
      { grid: [], tileAssets: {} },
      { rotation: 30, scale: { x: 2, y: 1 } },
    );

    const report = await validateProject(store);

    expectTilemapIssue(report, 'warnings', 'TILEMAP_TRANSFORM_UNSUPPORTED', /rotation to 0.*scale to/i);
  });

  it('accepts mixed plain, fixed-frame, and complete blob47 sources', async () => {
    const { session, store } = await makeSession();
    const plain = await createImageAsset(session, store, 'plain');
    const frames = [
      { name: 'floor', x: 0, y: 0, width: 16, height: 16 },
      ...AUTOTILE_SHAPES.map((shape, index) => ({
        name: `blob_${shape}`,
        x: index * 16,
        y: 16,
        width: 16,
        height: 16,
      })),
    ];
    const sheet = await createImageAsset(session, store, 'sheet', frames);
    await createTilemapEntity(session, {
      grid: ['SFA'],
      tileAssets: {
        S: plain.id,
        F: { sheet: sheet.id, frame: 'floor' },
        A: { sheet: sheet.id, template: 'blob47' },
      },
    });

    const report = await validateProject(store);

    expect(tilemapIssueCodes(report)).toEqual([]);
  });

  it('applies coherence checks to Tilemaps stored in prefab payloads', async () => {
    const { session, store, fs } = await makeSession();
    const { asset } = await makePrefabAsset(session, store);
    const sheet = await createImageAsset(session, store, 'prefab-sheet');
    const data: any = await readJson(fs, `/proj/${asset.path}`);
    data.entities[0].components.Tilemap = {
      grid: ['GF'],
      tileAssets: { F: { sheet: sheet.id, frame: 'missing' } },
    };
    await fs.writeFile(`/proj/${asset.path}`, JSON.stringify(data));

    const report = await validateProject(store);

    expectTilemapIssue(report, 'errors', 'TILEMAP_UNMAPPED_CHAR', /add tileAssets\.G/i);
    expectTilemapIssue(report, 'errors', 'TILEMAP_FRAME_NOT_FOUND', /slice the sheet|existing frame/i);
  });
});

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

describe('script require validation', () => {
  it('SCRIPT_REQUIRE_NOT_FOUND: script requires a missing module', async () => {
    const { session, store } = await makeSession();
    await session.execute('createScript', {
      name: 'player',
      language: 'lua',
      source: 'local script = {}\nlocal noise = require("lib/missing")\nreturn script\n',
    });

    const report = await validateProject(store);

    const issue = report.errors.find((e) => e.code === 'SCRIPT_REQUIRE_NOT_FOUND');
    expect(issue).toBeTruthy();
    expect(issue?.script).toBe('scripts/player.lua');
    expect(issue?.line).toBe(2);
    expect(issue?.message).toContain('scripts/lib/missing.lua');
    expect(report.valid).toBe(false);
  });

  it('does not report script require issues for a valid require', async () => {
    const { session, store } = await makeSession();
    await session.execute('createScript', {
      name: 'noise',
      dir: 'lib',
      language: 'lua',
      source: 'return { value = 1 }\n',
    });
    await session.execute('createScript', {
      name: 'player',
      language: 'lua',
      source: 'local script = {}\nlocal noise = require("lib/noise")\nreturn script\n',
    });

    const report = await validateProject(store);

    expect(report.errors.filter((e) => e.code.startsWith('SCRIPT_REQUIRE_'))).toEqual([]);
  });

  it('ignores a require in a Lua line comment (commenting one out must not block export)', async () => {
    const { session, store } = await makeSession();
    await session.execute('createScript', {
      name: 'player',
      language: 'lua',
      source: "-- we used to require('lib/removed') here\nreturn { onStart = function(ctx) end }\n",
    });

    const report = await validateProject(store);

    expect(report.errors.filter((e) => e.code.startsWith('SCRIPT_REQUIRE_'))).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('ignores a require in a JS line comment and a JS string literal', async () => {
    const { session, store } = await makeSession();
    await session.execute('createScript', {
      name: 'player',
      language: 'js',
      source:
        "// require('lib/old')\nexport default { onStart(ctx) { ctx.log(\"call require('lib/x') to load\"); } };\n",
    });

    const report = await validateProject(store);

    expect(report.errors.filter((e) => e.code.startsWith('SCRIPT_REQUIRE_'))).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('attributes a broken require in a library to the LIBRARY, once, not to each dependent', async () => {
    const { session, store } = await makeSession();
    await session.execute('createScript', {
      name: 'a',
      dir: 'lib',
      language: 'lua',
      source: 'local t = {}\nt.value = 1\nlocal gone = require("lib/nope")\nreturn t\n',
    });
    await session.execute('createScript', {
      name: 'player',
      language: 'lua',
      source: 'local a = require("lib/a")\nreturn {}\n',
    });
    await session.execute('createScript', {
      name: 'enemy',
      language: 'lua',
      source: 'local a = require("lib/a")\nreturn {}\n',
    });

    const report = await validateProject(store);

    const issues = report.errors.filter((e) => e.code === 'SCRIPT_REQUIRE_NOT_FOUND');
    expect(issues).toHaveLength(1);
    expect(issues[0].script).toBe('scripts/lib/a.lua');
    expect(issues[0].line).toBe(3);
    expect(issues[0].message).toContain('scripts/lib/a.lua:3');
    expect(issues[0].message).toContain('scripts/lib/nope.lua');
  });
});

describe('checkScriptRequires scanner (comment/string awareness)', () => {
  const lua = (path: string, source: string, extra: Record<string, string> = {}) =>
    checkScriptRequires(path, new Map([[path, source], ...Object.entries(extra)]));

  it('skips Lua --[[ ]] block comments and long strings', () => {
    const source = [
      '--[[',
      "require('lib/gone')",
      ']]',
      "local s = [[ require('lib/also-gone') ]]",
      'return {}',
    ].join('\n');
    expect(lua('scripts/a.lua', source)).toEqual([]);
  });

  it('skips Lua leveled long-bracket comments (--[==[ ]==])', () => {
    const source = "--[==[ require('lib/gone') ]==]\nreturn {}\n";
    expect(lua('scripts/a.lua', source)).toEqual([]);
  });

  it("skips a require inside a Lua string literal, including escaped quotes", () => {
    const source = 'local s = "say \\"require(\'lib/gone\')\\" out loud"\nreturn {}\n';
    expect(lua('scripts/a.lua', source)).toEqual([]);
  });

  it('skips JS /* */ block comments and template literals', () => {
    const path = 'scripts/a.js';
    const source = [
      '/*',
      "const old = require('lib/gone');",
      '*/',
      "const msg = `try require('lib/also-gone')`;",
      'export default {};',
    ].join('\n');
    expect(checkScriptRequires(path, new Map([[path, source]]))).toEqual([]);
  });

  it('still reports a real require after a comment, at the right line', () => {
    const source = "-- require('lib/decoy')\nlocal ok = 1\nlocal x = require('lib/nope')\nreturn {}\n";
    const diags = lua('scripts/a.lua', source);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(3);
    expect(diags[0].message).toContain('scripts/lib/nope.lua');
  });

  it('still reports a real require after a multi-line block comment, at the right line', () => {
    const source = "--[[\nfiller\nfiller\n]]\nlocal x = require('lib/nope')\nreturn {}\n";
    const diags = lua('scripts/a.lua', source);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(5);
  });

  it('reports only the checked script own requires, never a required library problems', () => {
    const sources = new Map([
      ['scripts/player.lua', 'local a = require("lib/a")\nreturn {}\n'],
      ['scripts/lib/a.lua', 'local t = {}\nt.v = 1\nlocal gone = require("lib/nope")\nreturn t\n'],
    ]);
    expect(checkScriptRequires('scripts/player.lua', sources)).toEqual([]);
    const own = checkScriptRequires('scripts/lib/a.lua', sources);
    expect(own).toHaveLength(1);
    expect(own[0].line).toBe(3);
  });

  it('still reports a cycle through the checked script, at its own require line', () => {
    const sources = new Map([
      ['scripts/a.lua', '-- header\nlocal b = require("b")\nreturn {}\n'],
      ['scripts/b.lua', 'local a = require("a")\nreturn {}\n'],
    ]);
    const diags = checkScriptRequires('scripts/a.lua', sources);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe('SCRIPT_REQUIRE_CYCLE');
    expect(diags[0].line).toBe(2);
    expect(diags[0].message).toContain('scripts/a.lua -> scripts/b.lua -> scripts/a.lua');
  });

  it('reports a self-require as a cycle', () => {
    const sources = new Map([['scripts/a.lua', 'local me = require("a")\nreturn {}\n']]);
    const diags = checkScriptRequires('scripts/a.lua', sources);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe('SCRIPT_REQUIRE_CYCLE');
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
