/**
 * Tests for the project server's agent routes: GET /api/agent/detect
 * (ctx.detectAgents) and POST /api/agent/prepare (ctx.prepareAgent), which
 * back the embedded agent panel's "is claude/codex installed" check and its
 * .mcp.json setup button.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';

let tmpDir: string;
let ctx: ProjectServerContext;
let projectPath: string;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-agent-routes-'));
  ctx = createProjectServerContext({
    recentsFile: path.join(tmpDir, 'recent-projects.json'),
    repoRoot: tmpDir,
  });
  const created = await ctx.createNewProject(path.join(tmpDir, 'projects'), 'Agent Route Game');
  expect(created.status).toBe(200);
  projectPath = (created.body as { path: string }).path;
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/agent/detect (ctx.detectAgents)', () => {
  it('returns an envelope with claude/codex detection results', async () => {
    const result = await ctx.detectAgents();
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; claude: { found: boolean }; codex: { found: boolean } };
    expect(body.ok).toBe(true);
    expect(typeof body.claude.found).toBe('boolean');
    expect(typeof body.codex.found).toBe('boolean');
  });
});

describe('POST /api/agent/prepare (ctx.prepareAgent)', () => {
  it('rejects a missing project', async () => {
    const result = await ctx.prepareAgent(undefined, 'safe-edit');
    expect(result.status).toBe(400);
  });

  it('rejects an unknown mode', async () => {
    const result = await ctx.prepareAgent(projectPath, 'super-admin');
    expect(result.status).toBe(400);
  });

  it('rejects a folder without hearth.json', async () => {
    const notAProject = path.join(tmpDir, 'not-a-project');
    await fsp.mkdir(notAProject, { recursive: true });
    const result = await ctx.prepareAgent(notAProject, 'safe-edit');
    expect(result.status).toBe(400);
  });

  it('writes .mcp.json with a hearth entry pointing at the resolved mcp tool path', async () => {
    const result = await ctx.prepareAgent(projectPath, 'read-only');
    expect(result.status).toBe(200);
    expect((result.body as { ok: boolean; written: boolean }).written).toBe(true);

    const parsed = JSON.parse(await fsp.readFile(path.join(projectPath, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.hearth.command).toBe('node');
    expect(parsed.mcpServers.hearth.args).toEqual([
      path.join(tmpDir, 'packages', 'mcp-server', 'dist', 'main.js'),
      '--project',
      projectPath,
      '--mode',
      'read-only',
    ]);
  });

  it('returns a 409 (not a clobber) when .mcp.json exists but fails to parse', async () => {
    const brokenDir = path.join(tmpDir, 'projects', 'broken');
    await fsp.mkdir(brokenDir, { recursive: true });
    await fsp.writeFile(path.join(brokenDir, 'hearth.json'), JSON.stringify({ name: 'Broken' }));
    await fsp.writeFile(path.join(brokenDir, '.mcp.json'), '{ not valid');

    const result = await ctx.prepareAgent(brokenDir, 'safe-edit');
    expect(result.status).toBe(409);

    const raw = await fsp.readFile(path.join(brokenDir, '.mcp.json'), 'utf8');
    expect(raw).toBe('{ not valid');
  });
});
