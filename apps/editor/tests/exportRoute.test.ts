/**
 * Tests for the project server's web-export route handler (POST /api/export/web
 * dispatches to ctx.exportWebBuild). The player bundle is resolved via
 * HEARTH_TOOLS_DIR, so a stub file stands in for the built runtime player.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';

const STUB_PLAYER = 'window.HearthPlayer={boot(){}}';

let tmpDir: string;
let toolsDir: string;
let projectPath: string;
let ctx: ProjectServerContext;
let savedToolsDir: string | undefined;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-export-route-'));
  toolsDir = path.join(tmpDir, 'tools');
  await fsp.mkdir(toolsDir, { recursive: true });
  await fsp.writeFile(path.join(toolsDir, 'hearth-player.js'), STUB_PLAYER);

  savedToolsDir = process.env.HEARTH_TOOLS_DIR;
  ctx = createProjectServerContext({
    recentsFile: path.join(tmpDir, 'recent-projects.json'),
    // No packages/runtime here: the only resolvable player is HEARTH_TOOLS_DIR.
    repoRoot: tmpDir,
  });
  const created = await ctx.createNewProject(path.join(tmpDir, 'projects'), 'Web Game');
  expect(created.status).toBe(200);
  projectPath = (created.body as { path: string }).path;
});

afterAll(async () => {
  if (savedToolsDir === undefined) delete process.env.HEARTH_TOOLS_DIR;
  else process.env.HEARTH_TOOLS_DIR = savedToolsDir;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('POST /api/export/web handler', () => {
  it('fails with MISSING_RESOURCE when no player bundle can be found', async () => {
    delete process.env.HEARTH_TOOLS_DIR;
    const result = await ctx.exportWebBuild(projectPath, undefined, undefined);
    expect(result.status).toBe(200); // envelope carries the error
    const body = result.body as { success: boolean; errors: { code: string; message: string }[] };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('MISSING_RESOURCE');
    expect(body.errors[0].message).toContain('hearth-player.js');
  });

  it('exports a web build through the command envelope', async () => {
    process.env.HEARTH_TOOLS_DIR = toolsDir;
    const result = await ctx.exportWebBuild(projectPath, undefined, undefined);
    expect(result.status).toBe(200);
    const body = result.body as { success: boolean; command: string; data: any };
    expect(body.success).toBe(true);
    expect(body.command).toBe('exportWeb');
    expect(body.data.outDir).toBe('export/web');

    const player = await fsp.readFile(path.join(projectPath, 'export', 'web', 'hearth-player.js'), 'utf8');
    expect(player).toBe(STUB_PLAYER);
    const html = await fsp.readFile(path.join(projectPath, 'export', 'web', 'index.html'), 'utf8');
    expect(html).toContain('<title>Web Game</title>');
  });

  it('supports singleFile and a custom outDir', async () => {
    process.env.HEARTH_TOOLS_DIR = toolsDir;
    const result = await ctx.exportWebBuild(projectPath, 'export/single', true);
    const body = result.body as { success: boolean; data: any };
    expect(body.success).toBe(true);
    expect(body.data.singleFile).toBe(true);
    const html = await fsp.readFile(path.join(projectPath, 'export', 'single', 'index.html'), 'utf8');
    expect(html).toContain(STUB_PLAYER);
  });

  it('rejects a missing project path with the standard envelope', async () => {
    const result = await ctx.exportWebBuild(undefined, undefined, undefined);
    expect(result.status).toBe(200);
    const body = result.body as { success: boolean; errors: { code: string }[] };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('NO_PROJECT');
  });

  it('with zip=true, writes <slug>-web.zip next to the output folder and reports its path', async () => {
    process.env.HEARTH_TOOLS_DIR = toolsDir;
    const result = await ctx.exportWebBuild(projectPath, 'export/web', false, true);
    expect(result.status).toBe(200);
    const body = result.body as { success: boolean; data: { slug: string; zip?: string; files: string[] } };
    expect(body.success).toBe(true);
    // Mirrors the CLI: <slug>-web.zip sits next to (not inside) the out dir.
    const expectedZipRel = `export/${body.data.slug}-web.zip`;
    expect(body.data.zip).toBe(expectedZipRel);
    expect(body.data.files).toContain(expectedZipRel);
    const stat = await fsp.stat(path.join(projectPath, expectedZipRel));
    expect(stat.size).toBeGreaterThan(0);
  });

  it('with zip omitted, writes no zip and reports no zip path', async () => {
    process.env.HEARTH_TOOLS_DIR = toolsDir;
    const result = await ctx.exportWebBuild(projectPath, 'export/nozip', false);
    const body = result.body as { success: boolean; data: { zip?: string } };
    expect(body.success).toBe(true);
    expect(body.data.zip).toBeUndefined();
  });
});
