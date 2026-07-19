/**
 * Tests for the `screenshot` MCP tool. Unlike every other tool it is not
 * dispatched through TOOL_SPECS/session.execute (see server.ts's comment on
 * why), so its permission check and error shape are tested by hand here.
 * The real-capture test is gated behind canLaunchChromium() and needs a
 * NodeFileSystem-backed project (screenshot output is a real PNG on a real
 * filesystem — a MemoryFileSystem `/proj` root, which the rest of this
 * package's MCP tests use, can't receive one).
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryFileSystem, createProject, HearthSession, PERMISSION_MODES, type PermissionMode } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { canLaunchChromium } from '@hearth/playtest';
import { createHearthMcpServer } from '../src/server.js';

function toolJson<T = any>(result: any): T {
  return JSON.parse(result.content[0].text);
}

async function connectClient(granted?: PermissionMode[]) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'MCP Screenshot Test' });
  const session = HearthSession.fromStore(store, { granted });
  const server = createHearthMcpServer(session, session.granted);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, session, fs, store };
}

describe('screenshot tool: listing and permissions', () => {
  let ctx: Awaited<ReturnType<typeof connectClient>>;

  afterEach(async () => {
    await ctx?.client.close();
    await ctx?.server.close();
  });

  it('is listed among the server tools', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name)).toContain('screenshot');
  });

  it('does not require "build" — screenshot is read-only observation', async () => {
    // A session granting only read-only (no build, no edit) must still be able
    // to screenshot: seeing the scene is observation, the visual sibling of
    // inspect/playtest, not a build step. It may still fail for a non-permission
    // reason (no Chromium in this env), but never PERMISSION_DENIED.
    ctx = await connectClient(['read-only']);
    const result = await ctx.client.callTool({ name: 'screenshot', arguments: {} });
    const envelope = toolJson(result);
    if (!envelope.success) {
      expect(envelope.errors[0].code).not.toBe('PERMISSION_DENIED');
    }
    expect(envelope.command).toBe('screenshot');
  });
});

// ---------------------------------------------------------------------------
// Real capture: needs a real filesystem (NodeFileSystem) and real Chromium.
// ---------------------------------------------------------------------------
const hasChromium = await canLaunchChromium();

describe.skipIf(!hasChromium)('screenshot tool: real capture', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-mcp-screenshot-'));
  }, 30000);

  afterAll(async () => {
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('captures a real PNG and returns metadata + files[0]', async () => {
    const fs = new NodeFileSystem();
    const { store } = await createProject(fs, tmpRoot, { name: 'MCP Screenshot Real Test' });
    const session = HearthSession.fromStore(store, { granted: [...PERMISSION_MODES] });
    const server = createHearthMcpServer(session, session.granted);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: 'screenshot',
        arguments: { frame: 3, seed: 1, out: 'mcp-shot.png' },
      });
      expect(result.isError).toBeFalsy();
      const envelope = toolJson(result);
      expect(envelope.success).toBe(true);
      expect(envelope.data.frame).toBe(3);
      expect(envelope.files).toEqual([envelope.data.path]);

      const info = await fsp.stat(path.join(tmpRoot, 'mcp-shot.png'));
      expect(info.size).toBeGreaterThan(1000);
    } finally {
      await client.close();
      await server.close();
    }
  }, 30000);
});
