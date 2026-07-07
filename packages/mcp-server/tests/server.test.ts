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
});
