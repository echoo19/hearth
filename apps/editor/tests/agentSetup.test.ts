/**
 * Tests for agent CLI detection and .mcp.json preparation.
 *
 * detectAgents() shells out to `which`/`--version`, so these tests point
 * PATH at real temp directories: an empty one to prove "missing" is clean,
 * and one with a fake executable script to prove "present" reports a
 * version. No real `claude`/`codex` binaries are invoked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, accessSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectAgents, prepareMcpConfig, McpConfigParseError } from '../server/agentSetup';

let tmpDir: string;
let savedPath: string | undefined;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-agentsetup-'));
  savedPath = process.env.PATH;
});

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// Minimal system dirs so `which`/`where` itself is resolvable, without
// pulling in whatever real agent CLIs happen to be installed on the host
// running this test.
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((d) => {
  try {
    accessSync(d);
    return true;
  } catch {
    return false;
  }
});

describe('detectAgents', () => {
  it('reports found=false cleanly when neither binary is on PATH', async () => {
    process.env.PATH = SYSTEM_DIRS.join(path.delimiter);
    const result = await detectAgents();
    expect(result.claude.found).toBe(false);
    expect(result.claude.version).toBeUndefined();
    expect(result.codex.found).toBe(false);
  });

  it('reports found=true with a version when the binary is on PATH', async () => {
    const binDir = path.join(tmpDir, 'bin');
    await fsp.mkdir(binDir, { recursive: true });
    const script = path.join(binDir, 'claude');
    await fsp.writeFile(
      script,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude-fake 1.2.3"; exit 0; fi\nexit 1\n',
    );
    await fsp.chmod(script, 0o755);

    process.env.PATH = [binDir, ...SYSTEM_DIRS].join(path.delimiter);
    const result = await detectAgents();
    expect(result.claude.found).toBe(true);
    expect(result.claude.version).toBe('claude-fake 1.2.3');
    // codex still absent.
    expect(result.codex.found).toBe(false);
  });
});

describe('prepareMcpConfig', () => {
  it('creates .mcp.json fresh with the hearth entry', async () => {
    const root = path.join(tmpDir, 'proj-fresh');
    await fsp.mkdir(root, { recursive: true });

    const result = await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'safe-edit');
    expect(result.written).toBe(true);

    const raw = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.hearth).toEqual({
      command: 'node',
      args: ['/tools/hearth-mcp/main.js', '--project', root, '--mode', 'safe-edit'],
    });
  });

  it('merges into an existing .mcp.json, preserving another server', async () => {
    const root = path.join(tmpDir, 'proj-merge');
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'python', args: ['other.py'] } } }, null, 2),
    );

    await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'full');

    const parsed = JSON.parse(await fsp.readFile(path.join(root, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.other).toEqual({ command: 'python', args: ['other.py'] });
    expect(parsed.mcpServers.hearth).toEqual({
      command: 'node',
      args: ['/tools/hearth-mcp/main.js', '--project', root, '--mode', 'safe-edit,code-edit,asset-edit'],
    });
  });

  it('is idempotent: re-running with the same args produces the same file', async () => {
    const root = path.join(tmpDir, 'proj-idempotent');
    await fsp.mkdir(root, { recursive: true });

    await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'all');
    const first = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');
    await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'all');
    const second = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');

    expect(second).toBe(first);
  });

  it('refuses to clobber an .mcp.json that fails to parse', async () => {
    const root = path.join(tmpDir, 'proj-broken');
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(path.join(root, '.mcp.json'), '{ not valid json');

    await expect(prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'read-only')).rejects.toThrow(
      McpConfigParseError,
    );

    // The broken file must be untouched.
    const raw = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');
    expect(raw).toBe('{ not valid json');
  });
});
