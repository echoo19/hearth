/**
 * Creating the folder a chat is about to fill (POST /api/workspace/create).
 *
 * Home has no picker: the first message IS the project, so the slug rule is a
 * product decision and gets pinned here. The endpoint itself must be
 * indistinguishable from /api/workspace/open once the folder exists — same
 * response shape, same recents registration — because the client treats both
 * the same way.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';
import {
  FALLBACK_SLUG,
  PROJECTS_DIR_NAME,
  SLUG_MAX_CHARS,
  resolveProjectsHome,
  slugFromPrompt,
  uniqueFolderName,
} from '../server/workspaceSlug';

let tmp: string;
let projectsDir: string;
let recentsFile: string;
let ctx: ProjectServerContext;

interface CreateBody {
  ok: boolean;
  path?: string;
  name?: string;
  isHearthProject?: boolean;
  error?: string;
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-create-'));
  projectsDir = path.join(tmp, 'Games');
  recentsFile = path.join(tmp, 'recents.json');
  ctx = createProjectServerContext({ recentsFile, projectsDir, repoRoot: tmp });
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('slugFromPrompt', () => {
  it('drops the words that describe the asking, not the game', () => {
    expect(slugFromPrompt('make me a little platformer with slimes')).toBe('little-platformer-slimes');
    expect(slugFromPrompt('Can you build a game about space pirates?')).toBe('space-pirates');
  });

  it('keeps at most four words', () => {
    expect(slugFromPrompt('neon cyberpunk racing sim with drift physics and rain')).toBe('neon-cyberpunk-racing-sim');
  });

  it('strips punctuation and casing, and joins apostrophes rather than splitting them', () => {
    expect(slugFromPrompt("Top-Down shooter — don't ask!")).toBe('top-down-shooter-dont');
    expect(slugFromPrompt('  Tower   Defense  ')).toBe('tower-defense');
  });

  it('falls back to a generic name when nothing meaningful is left', () => {
    expect(slugFromPrompt('make me a game')).toBe(FALLBACK_SLUG);
    expect(slugFromPrompt('   ')).toBe(FALLBACK_SLUG);
    expect(slugFromPrompt('!!! ???')).toBe(FALLBACK_SLUG);
    expect(slugFromPrompt(undefined)).toBe(FALLBACK_SLUG);
  });

  it('caps the length on a word boundary', () => {
    const slug = slugFromPrompt('extraordinarily complicated interdimensional bureaucracy');
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_CHARS);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toBe('extraordinarily-complicated');
  });

  it('never returns something that is not a folder name', () => {
    for (const prompt of ['../../etc/passwd', '/absolute/path', 'C:\\Windows', '💥💥💥', 'a'.repeat(200)]) {
      const slug = slugFromPrompt(prompt);
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_CHARS);
    }
  });
});

describe('resolveProjectsHome', () => {
  const saved = process.env.HEARTH_PROJECTS_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.HEARTH_PROJECTS_DIR;
    else process.env.HEARTH_PROJECTS_DIR = saved;
  });

  it('prefers an explicit override, then the env var, then ~/Hearth', () => {
    process.env.HEARTH_PROJECTS_DIR = '/tmp/from-env';
    expect(resolveProjectsHome('/tmp/explicit')).toBe(path.resolve('/tmp/explicit'));
    expect(resolveProjectsHome()).toBe(path.resolve('/tmp/from-env'));
    delete process.env.HEARTH_PROJECTS_DIR;
    expect(resolveProjectsHome()).toBe(path.join(os.homedir(), PROJECTS_DIR_NAME));
  });
});

describe('uniqueFolderName', () => {
  it('suffixes rather than reusing a taken name', async () => {
    const parent = path.join(tmp, 'dedupe');
    await fsp.mkdir(path.join(parent, 'shooter'), { recursive: true });
    expect(await uniqueFolderName(parent, 'shooter')).toBe('shooter-2');
    await fsp.mkdir(path.join(parent, 'shooter-2'), { recursive: true });
    expect(await uniqueFolderName(parent, 'shooter')).toBe('shooter-3');
    expect(await uniqueFolderName(parent, 'untouched')).toBe('untouched');
  });
});

describe('createWorkspace', () => {
  it('makes the folder under the projects home and opens it', async () => {
    const result = await ctx.createWorkspace('build a cozy farming sim');
    expect(result.status).toBe(200);
    const body = result.body as CreateBody;
    expect(body.ok).toBe(true);
    expect(body.path).toBe(path.join(projectsDir, 'cozy-farming-sim'));
    expect(body.name).toBe('cozy-farming-sim');
    expect(body.isHearthProject).toBe(false);
    expect((await fsp.stat(body.path!)).isDirectory()).toBe(true);
  });

  it('registers the new folder in recents, exactly like opening one', async () => {
    await ctx.createWorkspace('a roguelike about mushrooms');
    const recents = await ctx.recentWorkspaces();
    const projects = (recents.body as { projects: { path: string; name: string; exists: boolean }[] }).projects;
    expect(projects[0]).toMatchObject({
      path: path.join(projectsDir, 'roguelike-mushrooms'),
      name: 'roguelike-mushrooms',
      exists: true,
    });
  });

  it('never clobbers an existing folder for the same prompt', async () => {
    const first = (await ctx.createWorkspace('tiny puzzle box')).body as CreateBody;
    const second = (await ctx.createWorkspace('tiny puzzle box')).body as CreateBody;
    expect(first.path).toBe(path.join(projectsDir, 'tiny-puzzle-box'));
    expect(second.path).toBe(path.join(projectsDir, 'tiny-puzzle-box-2'));
  });

  it('prefers an explicit name over the prompt', async () => {
    const body = (await ctx.createWorkspace('something entirely different', 'Neon Drifter')).body as CreateBody;
    expect(body.path).toBe(path.join(projectsDir, 'neon-drifter'));
  });

  it('still makes a folder when no prompt is supplied at all', async () => {
    const body = (await ctx.createWorkspace(undefined)).body as CreateBody;
    expect(body.ok).toBe(true);
    expect(path.basename(body.path!)).toMatch(new RegExp(`^${FALLBACK_SLUG}(-\\d+)?$`));
  });

  it('reports a creation failure instead of throwing', async () => {
    // A projects home that is a FILE cannot be mkdir'd into.
    const blocked = path.join(tmp, 'blocked');
    await fsp.writeFile(blocked, 'not a folder');
    const hostile = createProjectServerContext({ recentsFile, projectsDir: blocked, repoRoot: tmp });
    const result = await hostile.createWorkspace('anything at all');
    expect(result.status).toBe(500);
    expect((result.body as CreateBody).ok).toBe(false);
  });
});
