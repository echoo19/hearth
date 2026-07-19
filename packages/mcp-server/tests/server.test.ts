import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryFileSystem, createProject, HearthSession, type PermissionMode } from '@hearth/core';
import { createRuntimeHooks } from '@hearth/playtest';
import { createHearthMcpServer } from '../src/server.js';

async function connectClient(granted?: PermissionMode[]) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'MCP Test' });
  const session = HearthSession.fromStore(store, { granted, runtime: createRuntimeHooks() });
  const server = createHearthMcpServer(session, session.granted);

  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, server, session, fs, store };
}

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  const first = content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected first content block to be text');
  }
  return first.text;
}

function toolJson<T = any>(result: Awaited<ReturnType<Client['callTool']>>): T {
  return JSON.parse(toolText(result));
}

describe('hearth-mcp server', () => {
  let ctx: Awaited<ReturnType<typeof connectClient>>;

  afterEach(async () => {
    await ctx?.client.close();
    await ctx?.server.close();
  });

  it('lists 35+ tools', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(35);
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_project_info');
    expect(names).toContain('create_entity');
    expect(names).toContain('get_agent_instructions');
  });

  it('get_project_info round-trips a success envelope with the project name', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({ name: 'get_project_info', arguments: {} });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('inspectProject');
    expect(envelope.data.name).toBe('MCP Test');
  });

  it('create_entity then inspect_scene shows the new entity', async () => {
    ctx = await connectClient();
    const sceneId = ctx.store.project.initialScene;
    expect(sceneId).toBeTruthy();

    const createResult = await ctx.client.callTool({
      name: 'create_entity',
      arguments: { scene: sceneId, name: 'Coin' },
    });
    expect(createResult.isError).toBeFalsy();
    const created = toolJson(createResult);
    expect(created.success).toBe(true);
    expect(created.data.name).toBe('Coin');

    const inspectResult = await ctx.client.callTool({
      name: 'inspect_scene',
      arguments: { scene: sceneId },
    });
    const inspected = toolJson(inspectResult);
    expect(inspected.success).toBe(true);
    const names = inspected.data.entities.map((e: { name: string }) => e.name);
    expect(names).toContain('Coin');
  });

  it('set_component_property with an invalid value returns isError with SCHEMA_ERROR', async () => {
    ctx = await connectClient();
    const sceneId = ctx.store.project.initialScene;
    const entities = ctx.store.getScene(sceneId!)!.entities;
    const player = entities.find((e) => e.name === 'Player')!;

    const result = await ctx.client.callTool({
      name: 'set_component_property',
      arguments: {
        scene: sceneId,
        entity: player.id,
        property: 'Transform.position.x',
        value: 'not-a-number',
      },
    });
    expect(result.isError).toBe(true);
    const envelope = toolJson(result);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('SCHEMA_ERROR');
  });

  it('set_component_property rejects an unknown path with a did-you-mean suggestion', async () => {
    ctx = await connectClient();
    const sceneId = ctx.store.project.initialScene;
    const player = ctx.store.getScene(sceneId!)!.entities.find((e) => e.name === 'Player')!;

    const result = await ctx.client.callTool({
      name: 'set_component_property',
      arguments: { scene: sceneId, entity: player.id, property: 'Transform.postiion.x', value: 100 },
    });
    expect(result.isError).toBe(true);
    const envelope = toolJson(result);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
    expect(envelope.errors[0].message).toContain('position');
  });

  it('set_properties applies a batch across two components in one undo step', async () => {
    ctx = await connectClient();
    const sceneId = ctx.store.project.initialScene;
    const player = ctx.store.getScene(sceneId!)!.entities.find((e) => e.name === 'Player')!;

    const result = await ctx.client.callTool({
      name: 'set_properties',
      arguments: {
        scene: sceneId,
        entity: player.id,
        properties: { 'Transform.position.x': 42, 'Transform.position.y': 7 },
      },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.success).toBe(true);
    expect(envelope.data.components.Transform.position).toEqual({ x: 42, y: 7 });

    const undoResult = await ctx.client.callTool({ name: 'undo', arguments: {} });
    expect(toolJson(undoResult).data.undone).toBe('setProperties');
  });

  it('denies mutating tools when the session only grants read-only', async () => {
    ctx = await connectClient(['read-only']);
    const result = await ctx.client.callTool({
      name: 'create_scene',
      arguments: { name: 'Level 2' },
    });
    expect(result.isError).toBe(true);
    const envelope = toolJson(result);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('PERMISSION_DENIED');
  });

  it('get_agent_instructions returns text containing the CLI quick reference', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({ name: 'get_agent_instructions', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = toolText(result);
    expect(text).toContain('hearth inspect');
  });

  it('get_agent_instructions bundles the live digest and durable memory in one call', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({ name: 'get_agent_instructions', arguments: {} });
    const text = toolText(result);
    // The engine-generated state digest...
    expect(text).toContain('Project digest');
    // ...and the durable memory file, so the agent gets state + intent without
    // extra round-trips.
    expect(text).toContain('Project memory');
  });

  it('get_diff without a prior snapshot returns a NOT_FOUND error envelope', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({ name: 'get_diff', arguments: {} });
    expect(result.isError).toBe(true);
    const envelope = toolJson(result);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('NOT_FOUND');
  });

  it('create_script defaults to Lua and honors language "js"', async () => {
    ctx = await connectClient();
    const luaResult = await ctx.client.callTool({ name: 'create_script', arguments: { name: 'mover' } });
    expect(luaResult.isError).toBeFalsy();
    const lua = toolJson(luaResult);
    expect(lua.data.path).toBe('scripts/mover.lua');

    const jsResult = await ctx.client.callTool({
      name: 'create_script',
      arguments: { name: 'mover-js', language: 'js' },
    });
    const js = toolJson(jsResult);
    expect(js.data.path).toBe('scripts/mover-js.js');
  });

  it('create_script accepts a nested dir', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({ name: 'create_script', arguments: { name: 'noise', dir: 'lib' } });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.data.path).toBe('scripts/lib/noise.lua');
    expect(await ctx.fs.exists('/proj/scripts/lib/noise.lua')).toBe(true);
  });

  it('check_script is registered, mirrors every param, and pre-flights bare source without saving', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'check_script');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['language', 'path', 'source']);

    const bad = await ctx.client.callTool({
      name: 'check_script',
      arguments: { source: 'if x then\n', language: 'lua' },
    });
    expect(bad.isError).toBeFalsy();
    const badEnvelope = toolJson(bad);
    expect(badEnvelope.success).toBe(true);
    expect(badEnvelope.command).toBe('checkScript');
    expect(badEnvelope.data.valid).toBe(false);
    expect(badEnvelope.data.diagnostics.length).toBe(1);

    const good = await ctx.client.callTool({
      name: 'check_script',
      arguments: { source: 'local x = 1\n', language: 'lua' },
    });
    const goodEnvelope = toolJson(good);
    expect(goodEnvelope.data.valid).toBe(true);
    expect(goodEnvelope.data.diagnostics).toEqual([]);

    // Read-only and non-mutating: no script file exists on disk from this.
    const listResult = await ctx.client.callTool({ name: 'list_scripts', arguments: {} });
    expect(toolJson(listResult).data.scripts).toEqual([]);
  });

  it('check_script in path mode reads an existing project script and reports its syntax error', async () => {
    ctx = await connectClient();
    const create = await ctx.client.callTool({
      name: 'create_script',
      arguments: { name: 'bad-js', language: 'js', source: 'export default {\n  onUpdate(ctx, dt) {\n};\n' },
    });
    expect(create.isError).toBeFalsy();

    const result = await ctx.client.callTool({ name: 'check_script', arguments: { path: 'scripts/bad-js.js' } });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.data.language).toBe('js');
    expect(envelope.data.valid).toBe(false);
  });

  it('check_script with neither source nor path fails with INVALID_INPUT', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({ name: 'check_script', arguments: {} });
    expect(result.isError).toBe(true);
    expect(toolJson(result).errors[0].code).toBe('INVALID_INPUT');
  });

  it('search_scripts is registered and finds matches with 1-based line/column', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'search_scripts');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['caseSensitive', 'pathGlob', 'query', 'regex']);

    await ctx.client.callTool({
      name: 'create_script',
      arguments: { name: 'mover', source: 'ctx.log("find me here")\n' },
    });

    const result = await ctx.client.callTool({ name: 'search_scripts', arguments: { query: 'find me' } });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('searchScripts');
    expect(envelope.data.total).toBe(1);
    expect(envelope.data.matches[0]).toMatchObject({ path: 'scripts/mover.lua', line: 1 });
  });

  it('search_scripts with an invalid regex fails with INVALID_INPUT', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({ name: 'search_scripts', arguments: { query: '[', regex: true } });
    expect(result.isError).toBe(true);
    expect(toolJson(result).errors[0].code).toBe('INVALID_INPUT');
  });

  it('replace_in_scripts is registered; dryRun:true previews without writing, a real call applies', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'replace_in_scripts');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['caseSensitive', 'dryRun', 'pathGlob', 'query', 'regex', 'replacement']);

    await ctx.client.callTool({
      name: 'create_script',
      arguments: { name: 'mover', source: 'local status = "before"\n' },
    });

    const dry = await ctx.client.callTool({
      name: 'replace_in_scripts',
      arguments: { query: 'before', replacement: 'after', dryRun: true },
    });
    expect(dry.isError).toBeFalsy();
    const dryEnvelope = toolJson(dry);
    expect(dryEnvelope.data.applied).toBe(false);
    expect(dryEnvelope.data.changes).toEqual([{ path: 'scripts/mover.lua', count: 1, preview: expect.any(String) }]);

    const unchanged = await ctx.client.callTool({ name: 'read_script', arguments: { path: 'scripts/mover.lua' } });
    expect(toolJson(unchanged).data.source).toBe('local status = "before"\n');

    const real = await ctx.client.callTool({
      name: 'replace_in_scripts',
      arguments: { query: 'before', replacement: 'after' },
    });
    expect(real.isError).toBeFalsy();
    const realEnvelope = toolJson(real);
    expect(realEnvelope.data.applied).toBe(true);
    expect(realEnvelope.command).toBe('replaceInScripts');

    const changed = await ctx.client.callTool({ name: 'read_script', arguments: { path: 'scripts/mover.lua' } });
    expect(toolJson(changed).data.source).toBe('local status = "after"\n');
  });

  it('inspect_api returns the ctx reference', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({ name: 'inspect_api', arguments: {} });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.success).toBe(true);
    expect(envelope.data.languages).toEqual(['lua', 'js']);
    const paths = envelope.data.api.map((e: { path: string }) => e.path);
    expect(paths).toContain('scenes.load');
    expect(paths).toContain('save');
    expect(paths).toContain('random.next');
  });

  it('update_settings deep-merges buildSettings and validates initialScene', async () => {
    ctx = await connectClient();
    const merge = await ctx.client.callTool({
      name: 'update_settings',
      arguments: { buildSettings: { title: 'MCP Game', loading: { spinner: true } } },
    });
    expect(merge.isError).toBeFalsy();
    const envelope = toolJson(merge);
    expect(envelope.data.buildSettings.title).toBe('MCP Game');
    expect(envelope.data.buildSettings.loading.spinner).toBe(true);
    expect(envelope.data.buildSettings.loading.backgroundColor).toBe('#000000');

    const bad = await ctx.client.callTool({
      name: 'update_settings',
      arguments: { initialScene: 'NoSuchScene' },
    });
    expect(bad.isError).toBe(true);
    expect(toolJson(bad).errors[0].code).toBe('NOT_FOUND');
  });

  it('update_settings accepts inputMappings with only gamepadButtons and applies it', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({
      name: 'update_settings',
      arguments: { inputMappings: { gamepadButtons: { jump: ['a'] } } },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.success).toBe(true);
    // Visible in the tool response and on the live project.
    expect(envelope.data.inputMappings.gamepadButtons).toEqual({ jump: ['a'] });
    expect(ctx.store.project.inputMappings.gamepadButtons).toEqual({ jump: ['a'] });
  });

  it('update_settings deep-merges codeStyle', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({
      name: 'update_settings',
      arguments: { codeStyle: { formatOnSave: false } },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.data.codeStyle).toEqual({ formatOnSave: false });
    expect(ctx.store.project.codeStyle.formatOnSave).toBe(false);
  });

  it('run_playtest executes headlessly and returns a passing result', async () => {
    ctx = await connectClient();
    const sceneId = ctx.store.project.initialScene!;
    const createResult = await ctx.client.callTool({
      name: 'create_playtest',
      arguments: {
        name: 'smoke',
        scene: sceneId,
        steps: [
          { type: 'wait', frames: 30 },
          { type: 'assertEntityExists', entity: 'Player', exists: true },
          { type: 'assertNoErrors' },
        ],
      },
    });
    expect(createResult.isError).toBeFalsy();

    const runResult = await ctx.client.callTool({
      name: 'run_playtest',
      arguments: { playtest: 'smoke' },
    });
    expect(runResult.isError).toBeFalsy();
    const envelope = toolJson(runResult);
    expect(envelope.success).toBe(true);
    expect(envelope.data.passed).toBe(true);
    expect(envelope.data.framesRun).toBeGreaterThanOrEqual(30);
    expect(envelope.data.steps.length).toBe(3);
  });

  it('slice_spritesheet slices a sprite asset into frames', async () => {
    ctx = await connectClient(['read-only', 'safe-edit', 'asset-edit']);

    // Create a sprite asset first
    const createResult = await ctx.client.callTool({
      name: 'create_sprite_asset',
      arguments: { name: 'spritesheet', shape: 'rectangle', width: 64, height: 64 },
    });
    expect(createResult.isError).toBeFalsy();

    // Slice it
    const sliceResult = await ctx.client.callTool({
      name: 'slice_spritesheet',
      arguments: {
        asset: 'spritesheet',
        frameWidth: 32,
        frameHeight: 32,
        margin: 0,
        spacing: 0,
        namePrefix: 'sprite',
      },
    });
    expect(sliceResult.isError).toBeFalsy();
    const envelope = toolJson(sliceResult);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('sliceSpritesheet');
    expect(envelope.data.frameCount).toBeGreaterThan(0);
    expect(envelope.data.frames).toBeInstanceOf(Array);
  });

  it('lists undo, redo, and list_history among the registered tools', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('undo');
    expect(names).toContain('redo');
    expect(names).toContain('list_history');
  });

  it('undo, redo, and list_history dispatch to their core commands', async () => {
    ctx = await connectClient();

    const emptyUndo = await ctx.client.callTool({ name: 'undo', arguments: {} });
    expect(emptyUndo.isError).toBe(true);
    const emptyUndoEnvelope = toolJson(emptyUndo);
    expect(emptyUndoEnvelope.command).toBe('undo');
    expect(emptyUndoEnvelope.errors[0].code).toBe('NOT_FOUND');

    const createResult = await ctx.client.callTool({ name: 'create_scene', arguments: { name: 'Level 2' } });
    expect(createResult.isError).toBeFalsy();

    const listResult = await ctx.client.callTool({ name: 'list_history', arguments: {} });
    expect(listResult.isError).toBeFalsy();
    const listEnvelope = toolJson(listResult);
    expect(listEnvelope.command).toBe('listHistory');
    expect(listEnvelope.data.entries.length).toBe(1);
    expect(listEnvelope.data.entries[0].command).toBe('createScene');
    expect(listEnvelope.data.entries[0].undone).toBe(false);

    const undoResult = await ctx.client.callTool({ name: 'undo', arguments: {} });
    expect(undoResult.isError).toBeFalsy();
    const undoEnvelope = toolJson(undoResult);
    expect(undoEnvelope.command).toBe('undo');
    expect(undoEnvelope.data.undone).toBe('createScene');

    const redoResult = await ctx.client.callTool({ name: 'redo', arguments: {} });
    expect(redoResult.isError).toBeFalsy();
    const redoEnvelope = toolJson(redoResult);
    expect(redoEnvelope.command).toBe('redo');
    expect(redoEnvelope.data.redone).toBe('createScene');
  });

  it('list_journal is registered and dispatches to listJournal, mirroring every param', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'list_journal');
    expect(tool).toBeDefined();
    // Mirror every field of listJournal's paramsSchema (Wave D lesson: a
    // stripped inputShape silently drops a param the tool description still
    // advertises) — both since and limit must round-trip through the schema.
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['limit', 'since']);

    const createResult = await ctx.client.callTool({ name: 'create_scene', arguments: { name: 'Level 2' } });
    expect(createResult.isError).toBeFalsy();

    const result = await ctx.client.callTool({ name: 'list_journal', arguments: {} });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.command).toBe('listJournal');
    expect(envelope.data.entries.length).toBe(1);
    expect(envelope.data.entries[0].command).toBe('createScene');
    expect(envelope.data.lastSeq).toBe(1);

    const paged = await ctx.client.callTool({ name: 'list_journal', arguments: { since: 0, limit: 1 } });
    expect(paged.isError).toBeFalsy();
    const pagedEnvelope = toolJson(paged);
    expect(pagedEnvelope.data.entries.length).toBe(1);
    expect(pagedEnvelope.data.entries[0].seq).toBe(1);
  });

  it('create_animation_from_sheet creates an animation from sliced frames', async () => {
    ctx = await connectClient(['read-only', 'safe-edit', 'asset-edit']);

    // Create and slice a sprite
    const createResult = await ctx.client.callTool({
      name: 'create_sprite_asset',
      arguments: { name: 'anim_source', shape: 'circle', width: 64, height: 64 },
    });
    expect(createResult.isError).toBeFalsy();

    const sliceResult = await ctx.client.callTool({
      name: 'slice_spritesheet',
      arguments: {
        asset: 'anim_source',
        frameWidth: 32,
        frameHeight: 32,
        namePrefix: 'frame',
      },
    });
    expect(sliceResult.isError).toBeFalsy();
    const sliceEnvelope = toolJson(sliceResult);
    const frames = (sliceEnvelope.data.frames as string[]).slice(0, 2);

    // Create animation
    const animResult = await ctx.client.callTool({
      name: 'create_animation_from_sheet',
      arguments: {
        name: 'spin',
        sheet: 'anim_source',
        frames,
        frameDuration: 0.1,
        loop: true,
      },
    });
    expect(animResult.isError).toBeFalsy();
    const animEnvelope = toolJson(animResult);
    expect(animEnvelope.success).toBe(true);
    expect(animEnvelope.command).toBe('createAnimationFromSheet');
    expect(animEnvelope.data.asset.id).toBeTruthy();
  });

  it('duplicate_scene is registered, mirrors every param, and clones playtests with --withPlaytests', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'duplicate_scene');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['newName', 'scene', 'withPlaytests']);

    const ptResult = await ctx.client.callTool({
      name: 'create_playtest',
      arguments: { name: 'smoke', scene: 'Main' },
    });
    expect(ptResult.isError).toBeFalsy();

    const result = await ctx.client.callTool({
      name: 'duplicate_scene',
      arguments: { scene: 'Main', newName: 'Main Copy', withPlaytests: true },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.command).toBe('duplicateScene');
    expect(envelope.data.name).toBe('Main Copy');
    expect(envelope.data.playtestsCloned).toBe(1);
  });

  it('duplicate_entity is registered, mirrors every param, and deep-copies with a fresh id', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'duplicate_entity');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['entity', 'newName', 'offset', 'scene']);

    const sceneId = ctx.store.project.initialScene;
    const player = ctx.store.getScene(sceneId!)!.entities.find((e) => e.name === 'Player')!;

    const result = await ctx.client.callTool({
      name: 'duplicate_entity',
      arguments: { scene: sceneId, entity: player.id, newName: 'Player Two', offset: { x: 1, y: 1 } },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.command).toBe('duplicateEntity');
    expect(envelope.data.name).toBe('Player Two');
    expect(envelope.data.entityId).not.toBe(player.id);
    expect(envelope.data.copiedCount).toBe(1);
  });

  it('set_entity_enabled is registered, mirrors every param, and toggles an entity', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'set_entity_enabled');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['enabled', 'entity', 'scene']);

    const sceneId = ctx.store.project.initialScene;
    const player = ctx.store.getScene(sceneId!)!.entities.find((e) => e.name === 'Player')!;

    const result = await ctx.client.callTool({
      name: 'set_entity_enabled',
      arguments: { scene: sceneId, entity: player.id, enabled: false },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.command).toBe('setEntityEnabled');
    expect(envelope.data.enabled).toBe(false);
    expect(ctx.store.getScene(sceneId!)!.entities.find((e) => e.id === player.id)!.enabled).toBe(false);
  });

  it('set_entity_tags is registered, mirrors every param, and replaces an entity\'s tags', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'set_entity_tags');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['entity', 'scene', 'tags']);

    const sceneId = ctx.store.project.initialScene;
    const player = ctx.store.getScene(sceneId!)!.entities.find((e) => e.name === 'Player')!;

    const result = await ctx.client.callTool({
      name: 'set_entity_tags',
      arguments: { scene: sceneId, entity: player.id, tags: ['hero', 'controllable'] },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.command).toBe('setEntityTags');
    expect(envelope.data.tags).toEqual(['hero', 'controllable']);
    expect(ctx.store.getScene(sceneId!)!.entities.find((e) => e.id === player.id)!.tags).toEqual([
      'hero',
      'controllable',
    ]);
  });

  it('remove_asset is registered, mirrors every param, and unregisters an asset', async () => {
    ctx = await connectClient(['read-only', 'safe-edit', 'asset-edit']);
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'remove_asset');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['asset', 'deleteFile']);

    const create = await ctx.client.callTool({
      name: 'create_sprite_asset',
      arguments: { name: 'coin', shape: 'circle', color: 'yellow' },
    });
    expect(create.isError).toBeFalsy();

    const result = await ctx.client.callTool({
      name: 'remove_asset',
      arguments: { asset: 'coin', deleteFile: true },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.command).toBe('removeAsset');
    expect(envelope.data.fileDeleted).toBe(true);
  });

  it('import_assets is registered, mirrors every param, and imports a batch in one atomic step', async () => {
    ctx = await connectClient(['read-only', 'safe-edit', 'asset-edit']);
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'import_assets');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['sourcePaths', 'type']);

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    await ctx.fs.writeFile('/tmp/coin.png', pngBytes);
    await ctx.fs.writeFile('/tmp/notes.xyz', pngBytes);

    const result = await ctx.client.callTool({
      name: 'import_assets',
      arguments: { sourcePaths: ['/tmp/coin.png', '/tmp/notes.xyz', '/tmp/missing.png'] },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.command).toBe('importAssets');
    expect(envelope.data.imported).toHaveLength(1);
    expect(envelope.data.imported[0]).toMatchObject({ name: 'coin', type: 'sprite' });
    expect(envelope.data.skipped).toHaveLength(2);
    expect(envelope.data.skipped.map((s: any) => s.code).sort()).toEqual(['NOT_FOUND', 'UNKNOWN_TYPE']);

    const journal = await ctx.session.execute<any>('listJournal');
    expect(journal.data.entries.filter((e: any) => e.command === 'importAssets')).toHaveLength(1);
  });

  it('create_prefab and instantiate_prefab are registered, mirror every param, and round-trip a subtree', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();

    const createTool = tools.find((t) => t.name === 'create_prefab');
    expect(createTool).toBeDefined();
    expect(Object.keys(createTool!.inputSchema.properties as Record<string, unknown>).sort()).toEqual([
      'entity',
      'name',
      'scene',
    ]);

    const placeTool = tools.find((t) => t.name === 'instantiate_prefab');
    expect(placeTool).toBeDefined();
    expect(Object.keys(placeTool!.inputSchema.properties as Record<string, unknown>).sort()).toEqual([
      'name',
      'position',
      'prefab',
      'scene',
    ]);

    const sceneId = ctx.store.project.initialScene!;
    const player = ctx.store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;

    const create = await ctx.client.callTool({
      name: 'create_prefab',
      arguments: { scene: sceneId, entity: player.id, name: 'PlayerPrefab' },
    });
    expect(create.isError).toBeFalsy();
    const createEnvelope = toolJson(create);
    expect(createEnvelope.command).toBe('createPrefab');
    expect(createEnvelope.data.asset.type).toBe('prefab');

    const place = await ctx.client.callTool({
      name: 'instantiate_prefab',
      arguments: { prefab: 'PlayerPrefab', scene: sceneId, position: { x: 1, y: 2 }, name: 'Player Clone' },
    });
    expect(place.isError).toBeFalsy();
    const placeEnvelope = toolJson(place);
    expect(placeEnvelope.command).toBe('instantiatePrefab');
    expect(placeEnvelope.data.entity.name).toBe('Player Clone');
    expect(placeEnvelope.data.entity.components.Transform.position).toEqual({ x: 1, y: 2 });
  });

  it('update_prefab and sync_prefab_instances are registered, mirror every param, and round-trip instance edits', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();

    const updateTool = tools.find((t) => t.name === 'update_prefab');
    expect(updateTool).toBeDefined();
    expect(Object.keys(updateTool!.inputSchema.properties as Record<string, unknown>).sort()).toEqual([
      'entity',
      'prefab',
      'scene',
    ]);

    const syncTool = tools.find((t) => t.name === 'sync_prefab_instances');
    expect(syncTool).toBeDefined();
    expect(Object.keys(syncTool!.inputSchema.properties as Record<string, unknown>).sort()).toEqual([
      'prefab',
      'scene',
    ]);

    const sceneId = ctx.store.project.initialScene!;
    const player = ctx.store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;

    const create = await ctx.client.callTool({
      name: 'create_prefab',
      arguments: { scene: sceneId, entity: player.id, name: 'PlayerPrefab' },
    });
    expect(create.isError).toBeFalsy();
    const createEnvelope = toolJson(create);
    const assetId = createEnvelope.data.asset.id as string;

    const place = await ctx.client.callTool({
      name: 'instantiate_prefab',
      arguments: { prefab: assetId, scene: sceneId, name: 'Player Two' },
    });
    expect(place.isError).toBeFalsy();
    const placeEnvelope = toolJson(place);
    const secondRootId = placeEnvelope.data.entity.id as string;

    const setColor = await ctx.client.callTool({
      name: 'set_component_property',
      arguments: { scene: sceneId, entity: player.id, property: 'SpriteRenderer.color', value: '#123456' },
    });
    expect(setColor.isError).toBeFalsy();

    const update = await ctx.client.callTool({
      name: 'update_prefab',
      arguments: { prefab: assetId, scene: sceneId, entity: player.id },
    });
    expect(update.isError).toBeFalsy();
    const updateEnvelope = toolJson(update);
    expect(updateEnvelope.command).toBe('updatePrefab');
    expect(updateEnvelope.data.asset.id).toBe(assetId);

    const sync = await ctx.client.callTool({
      name: 'sync_prefab_instances',
      arguments: { prefab: assetId, scene: sceneId },
    });
    expect(sync.isError).toBeFalsy();
    const syncEnvelope = toolJson(sync);
    expect(syncEnvelope.command).toBe('syncPrefabInstances');
    expect(syncEnvelope.data.total).toBe(2);

    const secondRoot = ctx.store.getScene(sceneId)!.entities.find((e) => e.id === secondRootId)!;
    expect(secondRoot.components.SpriteRenderer!.color).toBe('#123456');
  });

  it('create_state_machine_asset and update_state_machine_asset are registered, mirror every param, and round-trip', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();

    const createTool = tools.find((t) => t.name === 'create_state_machine_asset');
    expect(createTool).toBeDefined();
    expect(Object.keys(createTool!.inputSchema.properties as Record<string, unknown>).sort()).toEqual([
      'data',
      'name',
    ]);

    const updateTool = tools.find((t) => t.name === 'update_state_machine_asset');
    expect(updateTool).toBeDefined();
    expect(Object.keys(updateTool!.inputSchema.properties as Record<string, unknown>).sort()).toEqual([
      'assetId',
      'data',
    ]);

    const f1 = await ctx.client.callTool({ name: 'create_sprite_asset', arguments: { name: 'walk_f1' } });
    const f2 = await ctx.client.callTool({ name: 'create_sprite_asset', arguments: { name: 'walk_f2' } });
    expect(f1.isError).toBeFalsy();
    expect(f2.isError).toBeFalsy();

    const anim = await ctx.client.callTool({
      name: 'create_animation_asset',
      arguments: { name: 'Walk', frames: ['walk_f1', 'walk_f2'] },
    });
    expect(anim.isError).toBeFalsy();
    const animId = toolJson(anim).data.asset.id as string;

    const doc = {
      params: { moving: { type: 'bool', default: false } },
      states: [
        { name: 'idle', animation: animId, speed: 1 },
        { name: 'walk', animation: animId, speed: 1 },
      ],
      initial: 'idle',
      transitions: [
        { from: 'idle', to: 'walk', conditions: [{ param: 'moving', op: 'eq', value: true }] },
        { from: 'walk', to: 'idle', conditions: [{ param: 'moving', op: 'eq', value: false }] },
      ],
    };

    const create = await ctx.client.callTool({
      name: 'create_state_machine_asset',
      arguments: { name: 'Enemy AI', data: doc },
    });
    expect(create.isError).toBeFalsy();
    const createEnvelope = toolJson(create);
    expect(createEnvelope.command).toBe('createStateMachineAsset');
    expect(createEnvelope.data.path).toBe('assets/statemachines/enemy_ai.asm.json');
    const assetId = createEnvelope.data.assetId as string;

    const badDoc = {
      ...doc,
      states: doc.states.map((s) => (s.name === 'idle' ? { ...s, animation: 'ast_nope' } : s)),
    };
    const badAnim = await ctx.client.callTool({
      name: 'create_state_machine_asset',
      arguments: { name: 'Bad AI', data: badDoc },
    });
    expect(badAnim.isError).toBe(true);
    expect(toolJson(badAnim).errors[0].code).toBe('ASM_ANIMATION_NOT_FOUND');

    const newDoc = { ...doc, states: [...doc.states, { name: 'attack', animation: animId, speed: 2 }] };
    const update = await ctx.client.callTool({
      name: 'update_state_machine_asset',
      arguments: { assetId, data: newDoc },
    });
    expect(update.isError).toBeFalsy();
    const updateEnvelope = toolJson(update);
    expect(updateEnvelope.command).toBe('updateStateMachineAsset');
    expect(updateEnvelope.data).toEqual({ assetId });

    const listAssets = await ctx.client.callTool({ name: 'list_assets', arguments: { type: 'stateMachine' } });
    const listed = toolJson(listAssets).data.assets.find((a: any) => a.id === assetId);
    expect(listed.stateMachine.states.map((s: any) => s.name)).toEqual(['idle', 'walk', 'attack']);
  });
});
