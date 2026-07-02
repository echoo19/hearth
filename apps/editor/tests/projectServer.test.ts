/**
 * Tests for the editor's project server (the Vite plugin's route handlers).
 * The handlers are pure functions on a context object, so no HTTP or Vite
 * server is needed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';

let tmpDir: string;
let ctx: ProjectServerContext;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-editor-test-'));
  ctx = createProjectServerContext({
    recentsFile: path.join(tmpDir, 'recent-projects.json'),
    repoRoot: tmpDir, // no packages/examples here; examples must return []
  });
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('project open/create', () => {
  it('rejects opening a directory without hearth.json', async () => {
    const emptyDir = path.join(tmpDir, 'not-a-project');
    await fsp.mkdir(emptyDir, { recursive: true });
    const result = await ctx.openProject(emptyDir);
    expect(result.status).toBe(400);
    expect((result.body as { ok: boolean }).ok).toBe(false);
    expect((result.body as { error: string }).error).toContain('hearth.json');
  });

  it('rejects a missing path argument', async () => {
    const result = await ctx.openProject(undefined);
    expect(result.status).toBe(400);
  });

  it('creates a project and opens it round-trip', async () => {
    const created = await ctx.createNewProject(path.join(tmpDir, 'projects'), 'Test Game', 'a test');
    expect(created.status).toBe(200);
    const createdBody = created.body as { ok: boolean; path: string; info: { name: string } };
    expect(createdBody.ok).toBe(true);
    expect(createdBody.path).toBe(path.join(tmpDir, 'projects', 'test_game'));
    expect(createdBody.info.name).toBe('Test Game');

    const opened = await ctx.openProject(createdBody.path);
    expect(opened.status).toBe(200);
    const openedBody = opened.body as { ok: boolean; info: { name: string; scenes: unknown[] } };
    expect(openedBody.ok).toBe(true);
    expect(openedBody.info.name).toBe('Test Game');
    expect(openedBody.info.scenes.length).toBeGreaterThan(0); // starter scene

    // it also lands in recents
    const recent = await ctx.recentProjects();
    const projects = (recent.body as { projects: { path: string; exists: boolean }[] }).projects;
    expect(projects.some((p) => p.path === createdBody.path && p.exists)).toBe(true);
  });

  it('returns 409 when creating over an existing project', async () => {
    const again = await ctx.createNewProject(path.join(tmpDir, 'projects'), 'Test Game');
    expect(again.status).toBe(409);
  });
});

describe('command endpoint', () => {
  let projectPath: string;

  beforeAll(async () => {
    const created = await ctx.createNewProject(path.join(tmpDir, 'projects'), 'Command Game');
    projectPath = (created.body as { path: string }).path;
  });

  it('executes inspectProject and returns the CommandResult envelope', async () => {
    const result = await ctx.runCommand(projectPath, 'inspectProject', {});
    expect(result.status).toBe(200);
    const body = result.body as {
      success: boolean;
      command: string;
      data: { name: string; scenes: { id: string }[] };
      errors: unknown[];
    };
    expect(body.success).toBe(true);
    expect(body.command).toBe('inspectProject');
    expect(body.data.name).toBe('Command Game');
    expect(body.data.scenes.length).toBe(1);
  });

  it('returns the error envelope (still HTTP 200) for unknown commands', async () => {
    const result = await ctx.runCommand(projectPath, 'definitelyNotACommand', {});
    expect(result.status).toBe(200);
    const body = result.body as { success: boolean; errors: { code: string }[] };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('UNKNOWN_COMMAND');
  });

  it('returns a NO_PROJECT envelope when the project is not a Hearth project', async () => {
    const result = await ctx.runCommand(path.join(tmpDir, 'nowhere'), 'inspectProject', {});
    expect(result.status).toBe(200);
    const body = result.body as { success: boolean; errors: { code: string }[] };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('NO_PROJECT');
  });

  it('mutating commands persist through the session (createEntity then inspectScene)', async () => {
    const info = await ctx.runCommand(projectPath, 'inspectProject', {});
    const sceneId = (info.body as { data: { scenes: { id: string }[] } }).data.scenes[0].id;

    const created = await ctx.runCommand(projectPath, 'createEntity', {
      scene: sceneId,
      name: 'TestCoin',
      components: { SpriteRenderer: { shape: 'circle', color: '#f1c40f' } },
    });
    expect((created.body as { success: boolean }).success).toBe(true);

    const scene = await ctx.runCommand(projectPath, 'inspectScene', { scene: sceneId, full: true });
    const entities = (scene.body as { data: { entities: { name: string }[] } }).data.entities;
    expect(entities.some((e) => e.name === 'TestCoin')).toBe(true);
  });
});

describe('/api/file security', () => {
  let projectPath: string;

  beforeAll(async () => {
    const created = await ctx.createNewProject(path.join(tmpDir, 'projects'), 'File Game');
    projectPath = (created.body as { path: string }).path;
    await fsp.writeFile(path.join(tmpDir, 'projects', 'secret.txt'), 'top secret');
  });

  it('serves a project file with the right content type', async () => {
    const result = await ctx.readProjectFile(projectPath, 'hearth.json');
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/json');
    const parsed = JSON.parse(new TextDecoder().decode(result.data!));
    expect(parsed.name).toBe('File Game');
  });

  it('returns 403 for ../ path escapes', async () => {
    const result = await ctx.readProjectFile(projectPath, '../secret.txt');
    expect(result.status).toBe(403);
  });

  it('returns 403 for absolute path escapes', async () => {
    const result = await ctx.readProjectFile(projectPath, '/etc/hosts');
    expect(result.status).toBe(403);
  });

  it('returns 403 for a project that is not a Hearth project', async () => {
    const result = await ctx.readProjectFile(tmpDir, 'projects/secret.txt');
    expect(result.status).toBe(403);
  });

  it('returns 404 for missing files inside the project', async () => {
    const result = await ctx.readProjectFile(projectPath, 'does-not-exist.png');
    expect(result.status).toBe(404);
  });
});

describe('/api/fs for the browser ProjectStore', () => {
  let projectPath: string;

  beforeAll(async () => {
    const created = await ctx.createNewProject(path.join(tmpDir, 'projects'), 'Fs Game');
    projectPath = (created.body as { path: string }).path;
  });

  it('read/exists/readdir/stat work project-relative', async () => {
    const read = await ctx.fsOperation(projectPath, 'read', 'hearth.json');
    expect(read.status).toBe(200);
    expect(JSON.parse((read.body as { content: string }).content).name).toBe('Fs Game');

    const exists = await ctx.fsOperation(projectPath, 'exists', 'assets.json');
    expect((exists.body as { exists: boolean }).exists).toBe(true);

    const readdir = await ctx.fsOperation(projectPath, 'readdir', 'scenes');
    expect((readdir.body as { entries: string[] }).entries).toContain('main.scene.json');

    const stat = await ctx.fsOperation(projectPath, 'stat', 'scenes');
    expect((stat.body as { stat: { isDirectory: boolean } }).stat.isDirectory).toBe(true);
  });

  it('rejects escapes', async () => {
    const result = await ctx.fsOperation(projectPath, 'read', '../../secret.txt');
    expect(result.status).toBe(403);
  });
});

describe('misc endpoints', () => {
  it('examples returns an empty list when packages/examples is missing', async () => {
    const result = await ctx.exampleProjects();
    expect(result.status).toBe(200);
    expect((result.body as { examples: unknown[] }).examples).toEqual([]);
  });

  it('meta reports the repo root', async () => {
    const result = await ctx.meta();
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; repoRoot: string; runtimeAvailable: boolean };
    expect(body.ok).toBe(true);
    expect(body.repoRoot).toBe(tmpDir);
    expect(typeof body.runtimeAvailable).toBe('boolean');
  });
});
