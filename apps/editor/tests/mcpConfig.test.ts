/**
 * Tests for auto-provisioning the `hearth` MCP server entry into a project's
 * `.mcp.json` (apps/editor/server/mcpConfig.ts). This is passive config
 * writing — no process is ever spawned — so it cannot reintroduce the old
 * launcher's silent "nothing happens" spawn failures.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureHearthMcpConfig,
  hearthMcpArgs,
  McpConfigParseError,
} from '../server/mcpConfig.js';

let root: string;
const MCP = '/opt/hearth/tools/hearth-mcp.mjs';

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-mcpcfg-'));
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(root, '.mcp.json'), 'utf8'));
}

describe('hearthMcpArgs', () => {
  it('maps the "full" tier to every editing mode except build', () => {
    expect(hearthMcpArgs(MCP, '/p', 'full')).toEqual([
      MCP,
      '--project',
      '/p',
      '--mode',
      'safe-edit,code-edit,asset-edit',
    ]);
  });

  it('maps "all" to the literal all shorthand', () => {
    expect(hearthMcpArgs(MCP, '/p', 'all')).toEqual([MCP, '--project', '/p', '--mode', 'all']);
  });
});

describe('ensureHearthMcpConfig', () => {
  it('writes the hearth server entry when .mcp.json is absent', async () => {
    const result = await ensureHearthMcpConfig(root, MCP, 'full');
    expect(result.written).toBe(true);
    const config = await readConfig();
    expect(config).toEqual({
      mcpServers: {
        hearth: {
          command: 'node',
          args: [MCP, '--project', root, '--mode', 'safe-edit,code-edit,asset-edit'],
        },
      },
    });
  });

  it('merges into an existing .mcp.json, preserving other servers', async () => {
    await fsp.writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'foo', args: ['bar'] } } }),
      'utf8',
    );
    const result = await ensureHearthMcpConfig(root, MCP, 'full');
    expect(result.written).toBe(true);
    const config = (await readConfig()).mcpServers as Record<string, unknown>;
    expect(config.other).toEqual({ command: 'foo', args: ['bar'] });
    expect(config.hearth).toBeDefined();
  });

  it('is idempotent: a second call writes nothing', async () => {
    await ensureHearthMcpConfig(root, MCP, 'full');
    const before = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');
    const result = await ensureHearthMcpConfig(root, MCP, 'full');
    expect(result.written).toBe(false);
    const after = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');
    expect(after).toBe(before);
  });

  it('preserves a mode the user changed by hand instead of forcing the default', async () => {
    await fsp.writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          hearth: { command: 'node', args: [MCP, '--project', root, '--mode', 'read-only'] },
        },
      }),
      'utf8',
    );
    const result = await ensureHearthMcpConfig(root, MCP, 'full');
    expect(result.written).toBe(false);
    const hearth = (await readConfig()).mcpServers as Record<string, { args: string[] }>;
    expect(hearth.hearth.args).toContain('read-only');
  });

  it('corrects a stale mcp path while preserving the existing mode', async () => {
    await fsp.writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          hearth: {
            command: 'node',
            args: ['/old/app/v1/hearth-mcp.mjs', '--project', root, '--mode', 'safe-edit'],
          },
        },
      }),
      'utf8',
    );
    const result = await ensureHearthMcpConfig(root, MCP, 'full');
    expect(result.written).toBe(true);
    const hearth = (await readConfig()).mcpServers as Record<string, { args: string[] }>;
    expect(hearth.hearth.args[0]).toBe(MCP); // path corrected
    expect(hearth.hearth.args).toContain('safe-edit'); // mode preserved, not reset to full
  });

  it('throws McpConfigParseError on a malformed .mcp.json rather than clobbering it', async () => {
    await fsp.writeFile(path.join(root, '.mcp.json'), '{ not valid json', 'utf8');
    await expect(ensureHearthMcpConfig(root, MCP, 'full')).rejects.toBeInstanceOf(McpConfigParseError);
  });
});
