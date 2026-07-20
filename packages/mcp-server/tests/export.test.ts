/**
 * Tests for the v0.2 tool additions: create_sound and export_web, plus the
 * later exportDesktop tool and export_web's `zip` flag.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  PERMISSION_MODES,
  slugify,
  type CommandResources,
  type DesktopBuildResult,
} from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { createHearthMcpServer } from '../src/server.js';
import { TOOL_SPECS } from '../src/tools.js';

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

  it('export_web is registered with outDir, singleFile, and zip in its schema', async () => {
    ctx = await connectClient();
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'export_web');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['outDir', 'singleFile', 'zip']);
  });
});

describe('hearth-mcp export_desktop tool', () => {
  let ctx: Awaited<ReturnType<typeof connectClient>>;

  afterEach(async () => {
    await ctx?.client.close();
    await ctx?.server.close();
  });

  const stubBuild = (platform: string): DesktopBuildResult => ({
    platform: platform as DesktopBuildResult['platform'],
    appDir: `export/desktop/${platform}/App`,
    zip: `export/desktop/${platform}.zip`,
    signed: 'adhoc',
    notarized: false,
  });

  it('is registered in the tool list (67 -> 68 with exportDesktop)', async () => {
    ctx = await connectClient({ getPlayerBundle: async () => STUB_PLAYER });
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name)).toContain('export_desktop');
    // TOOL_SPECS is the single source of truth the server registers
    // session.execute-backed tools from; exportDesktop brought it from 67 to
    // 68, set_entity_enabled/set_entity_tags (parity closure) brought it
    // to 70, and create_music/delete_playtest/bench_scene brought it to 75
    // (screenshot, capture, and get_agent_instructions are registered
    // separately, outside TOOL_SPECS, so they're not counted here).
    expect(TOOL_SPECS.length).toBe(75);
  });

  it('mirrors exportDesktop paramsSchema: outDir and platforms', async () => {
    ctx = await connectClient({ getPlayerBundle: async () => STUB_PLAYER });
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === 'export_desktop');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['outDir', 'platforms']);
  });

  it('produces builds for the requested platforms via a stubbed packageDesktop resource', async () => {
    ctx = await connectClient({
      getPlayerBundle: async () => STUB_PLAYER,
      packageDesktop: async (spec) => spec.platforms.map((p) => stubBuild(p)),
    });
    const result = await ctx.client.callTool({
      name: 'export_desktop',
      arguments: { platforms: ['linux-x64', 'win32-x64'] },
    });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('exportDesktop');
    expect(envelope.data.outDir).toBe('export/desktop');
    expect(envelope.data.builds.map((b: DesktopBuildResult) => b.platform)).toEqual(['linux-x64', 'win32-x64']);
  });

  it('defaults to all four platforms when none are requested', async () => {
    ctx = await connectClient({
      getPlayerBundle: async () => STUB_PLAYER,
      packageDesktop: async (spec) => spec.platforms.map((p) => stubBuild(p)),
    });
    const result = await ctx.client.callTool({ name: 'export_desktop', arguments: {} });
    expect(result.isError).toBeFalsy();
    const envelope = toolJson(result);
    expect(envelope.data.builds.map((b: DesktopBuildResult) => b.platform).sort()).toEqual(
      ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].sort(),
    );
  });

  it('fails with DESKTOP_EXPORT_UNSUPPORTED when no packageDesktop resource is wired (never runs real Electron packaging)', async () => {
    ctx = await connectClient({ getPlayerBundle: async () => STUB_PLAYER });
    const result = await ctx.client.callTool({ name: 'export_desktop', arguments: {} });
    expect(result.isError).toBe(true);
    const envelope = toolJson(result);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('DESKTOP_EXPORT_UNSUPPORTED');
  });

  it('denies export_desktop when the session does not grant build', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'MCP Export Test' });
    const session = HearthSession.fromStore(store, {
      granted: ['read-only', 'safe-edit', 'code-edit', 'asset-edit'],
      resources: { getPlayerBundle: async () => STUB_PLAYER, packageDesktop: async () => [] },
    });
    const server = createHearthMcpServer(session, session.granted);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    ctx = { client, server, session, fs, store };

    const result = await ctx.client.callTool({ name: 'export_desktop', arguments: {} });
    expect(result.isError).toBe(true);
    const envelope = toolJson(result);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('PERMISSION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// export_web `zip` flag: needs a real filesystem, since it zips the exported
// folder from disk via @hearth/shipping's zipDirectory (same reason
// screenshot.test.ts's real-capture block needs NodeFileSystem). No Electron
// packaging is involved here, only a plain directory zip.
// ---------------------------------------------------------------------------
describe('hearth-mcp export_web zip flag (real fs)', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-mcp-export-zip-'));
  }, 30000);

  afterAll(async () => {
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('zip:true writes <slug>-web.zip next to the output folder and adds it to data + files', async () => {
    const fs = new NodeFileSystem();
    const { store } = await createProject(fs, tmpRoot, { name: 'Zip Game' });
    const session = HearthSession.fromStore(store, {
      granted: [...PERMISSION_MODES],
      resources: { getPlayerBundle: async () => STUB_PLAYER },
    });
    const server = createHearthMcpServer(session, session.granted);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({ name: 'export_web', arguments: { zip: true } });
      expect(result.isError).toBeFalsy();
      const envelope = toolJson(result);
      expect(envelope.success).toBe(true);
      expect(envelope.data.outDir).toBe('export/web');
      expect(envelope.data.zip).toBe('export/zip_game-web.zip');
      expect(envelope.files).toContain('export/zip_game-web.zip');

      const zipBuf = await fsp.readFile(path.join(tmpRoot, 'export', 'zip_game-web.zip'));
      expect(zipBuf.readUInt32LE(0)).toBe(0x04034b50); // local file header signature
      expect(zipBuf.readUInt32LE(zipBuf.length - 22)).toBe(0x06054b50); // end of central directory
      const names = zipBuf.toString('latin1');
      expect(names).toContain('index.html');
      expect(names).toContain('project.bundle.json');
      expect(names).toContain('hearth-player.js');
      expect(names).not.toContain('web/index.html'); // entries are rooted at the folder itself
    } finally {
      await client.close();
      await server.close();
    }
  }, 30000);

  it('without zip, no zip file is written and data.zip is absent', async () => {
    const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-mcp-export-nozip-'));
    try {
      const fs = new NodeFileSystem();
      const { store } = await createProject(fs, projectDir, { name: 'No Zip Game' });
      const session = HearthSession.fromStore(store, {
        granted: [...PERMISSION_MODES],
        resources: { getPlayerBundle: async () => STUB_PLAYER },
      });
      const server = createHearthMcpServer(session, session.granted);
      const client = new Client({ name: 'test-client', version: '0.0.1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      try {
        const result = await client.callTool({ name: 'export_web', arguments: {} });
        expect(result.isError).toBeFalsy();
        const envelope = toolJson(result);
        expect(envelope.success).toBe(true);
        expect(envelope.data.zip).toBeUndefined();
        await expect(fsp.access(path.join(projectDir, 'export', 'no_zip_game-web.zip'))).rejects.toThrow();
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await fsp.rm(projectDir, { recursive: true, force: true });
    }
  }, 30000);

  it('zip failure after a successful export still returns the structured envelope, with export data intact and the failure surfaced as a warning', async () => {
    const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-mcp-export-zipfail-'));
    try {
      const fs = new NodeFileSystem();
      const { store } = await createProject(fs, projectDir, { name: 'Zip Fail Game' });
      const session = HearthSession.fromStore(store, {
        granted: [...PERMISSION_MODES],
        resources: { getPlayerBundle: async () => STUB_PLAYER },
      });
      const server = createHearthMcpServer(session, session.granted);
      const client = new Client({ name: 'test-client', version: '0.0.1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      // zipExportedWebBuild writes to <projectRoot>/export/<slug>-web.zip.
      // Pre-creating a directory at that exact path (instead of mocking
      // zipDirectory, which every other test in this file relies on being
      // real) forces zipDirectory's fsp.writeFile to throw EISDIR — a
      // real-fs stand-in for "disk full / permissions" that doesn't touch
      // the export step itself.
      const slug = slugify('Zip Fail Game');
      const zipPath = path.join(projectDir, 'export', `${slug}-web.zip`);
      await fsp.mkdir(zipPath, { recursive: true });

      try {
        const result = await client.callTool({ name: 'export_web', arguments: { zip: true } });

        // The failure must never escape as the MCP SDK's generic
        // unstructured-text error response.
        expect(result.isError).toBeFalsy();
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');

        const envelope = toolJson(result);
        // Structured CommandResult envelope, not bare text: the export
        // succeeded, so success stays true and outDir/slug are intact.
        expect(envelope.success).toBe(true);
        expect(envelope.command).toBe('exportWeb');
        expect(envelope.data.outDir).toBe('export/web');
        expect(envelope.data.slug).toBe(slug);
        await expect(fsp.access(path.join(projectDir, 'export', 'web', 'index.html'))).resolves.toBeUndefined();

        // No zip field/entry, since zipping failed.
        expect(envelope.data.zip).toBeUndefined();
        expect(envelope.files).not.toContain(`export/${slug}-web.zip`);

        // The zip failure is visible in the envelope's warnings, not silently dropped.
        expect(envelope.warnings).toHaveLength(1);
        expect(envelope.warnings[0].code).toBe('ZIP_FAILED');
        expect(envelope.warnings[0].message).toMatch(/zip/i);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await fsp.rm(projectDir, { recursive: true, force: true });
    }
  }, 30000);
});
