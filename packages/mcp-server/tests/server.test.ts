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
});
