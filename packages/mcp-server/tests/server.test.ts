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
});
