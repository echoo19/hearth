/**
 * Tests for the v0.2 tool additions: create_sound and export_web.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  PERMISSION_MODES,
  type CommandResources,
} from '@hearth/core';
import { createHearthMcpServer } from '../src/server.js';

const STUB_PLAYER = 'window.HearthPlayer={boot(){}}';

async function connectClient(resources?: CommandResources) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'MCP Export Test' });
  const session = HearthSession.fromStore(store, { granted: [...PERMISSION_MODES], resources });
  const server = createHearthMcpServer(session, session.granted);

  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, session, fs, store };
}

function toolJson<T = any>(result: any): T {
  return JSON.parse(result.content[0].text);
}

describe('hearth-mcp v0.2 tools', () => {
  let ctx: Awaited<ReturnType<typeof connectClient>>;

  afterEach(async () => {
    await ctx?.client.close();
    await ctx?.server.close();
  });

  it('exposes create_sound and export_web in the tool list', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('create_sound');
    expect(names).toContain('export_web');
  });

  it('create_sound writes a WAV and registers an audio asset', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({
      name: 'create_sound',
      arguments: { name: 'boom', preset: 'explosion', seed: 9 },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.success).toBe(true);
    expect(envelope.data.asset.type).toBe('audio');
    expect(await ctx.fs.exists('/proj/assets/sounds/boom.wav')).toBe(true);
  });

  it('export_web produces the web build when the player bundle is available', async () => {
    ctx = await connectClient({ getPlayerBundle: async () => STUB_PLAYER });
    const result = await ctx.client.callTool({ name: 'export_web', arguments: {} });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.success).toBe(true);
    expect(envelope.data.outDir).toBe('export/web');
    expect(await ctx.fs.readFile('/proj/export/web/hearth-player.js')).toBe(STUB_PLAYER);
    expect(await ctx.fs.exists('/proj/export/web/index.html')).toBe(true);
    expect(await ctx.fs.exists('/proj/export/web/project.bundle.json')).toBe(true);
  });

  it('export_web fails with MISSING_RESOURCE when no player bundle is wired', async () => {
    ctx = await connectClient();
    const result = await ctx.client.callTool({ name: 'export_web', arguments: {} });
    expect(result.isError).toBe(true);
    const envelope = toolJson(result);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('MISSING_RESOURCE');
  });
});
