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
  slugFromName,
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

describe('slugFromName — a typed name is not a prompt', () => {
  it('keeps every word, because every word was chosen', () => {
    // Run through the prompt rule these lose their whole meaning: all three
    // words of "My New Game" are stopwords, so it fell through to the generic
    // fallback, and "My Space Game" came out as bare `space`.
    expect(slugFromName('My New Game')).toBe('my-new-game');
    expect(slugFromName('My Space Game')).toBe('my-space-game');
    expect(slugFromPrompt('My New Game')).toBe(FALLBACK_SLUG);
  });

  it('applies the same character rules as the prompt path', () => {
    expect(slugFromName("Don't Starve — Clone!")).toBe('dont-starve-clone');
    expect(slugFromName('  Tower   Defense  ')).toBe('tower-defense');
  });

  it('still names something when the name is only punctuation', () => {
    expect(slugFromName('!!!')).toBe(FALLBACK_SLUG);
    expect(slugFromName('   ')).toBe(FALLBACK_SLUG);
    expect(slugFromName(undefined)).toBe(FALLBACK_SLUG);
  });

  it('caps length the way the prompt path does', () => {
    const slug = slugFromName('extraordinarily complicated interdimensional bureaucracy');
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_CHARS);
    expect(slug.endsWith('-')).toBe(false);
  });
});

/**
 * A folder name is ASCII because a path has to survive every filesystem,
 * shell and git remote. That is a constraint on the FOLDER and it must never
 * become a constraint on who may name a game: `우주 게임` used to produce the
 * generic `new-game`, which is the app saying it did not understand the name
 * it had just asked for.
 */
describe('slugFromName — names the ASCII rule cannot spell', () => {
  it('folds an accent to its letter rather than dropping the letter', () => {
    expect(slugFromName('Café Adventure')).toBe('cafe-adventure');
    expect(slugFromName('Über Kart')).toBe('uber-kart');
    expect(slugFromName('Pokémon Ranch')).toBe('pokemon-ranch');
  });

  it('derives a stable folder for a name with no Latin letters at all', () => {
    const korean = slugFromName('우주 게임');
    expect(korean).not.toBe(FALLBACK_SLUG);
    expect(korean).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    // Stable: the same name always lands in the same folder, on any machine.
    expect(slugFromName('우주 게임')).toBe(korean);
  });

  it('gives two different names two different folders', () => {
    // Silently mapping every non-Latin name onto one slug would make the
    // dedupe suffix the only thing telling two games apart.
    const slugs = ['우주 게임', 'ゲーム', '宇宙ゲーム', 'Игра'].map((name) => slugFromName(name));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('still falls back to the generic name when there is nothing to derive from', () => {
    expect(slugFromName('!!!')).toBe(FALLBACK_SLUG);
    expect(slugFromName('   ')).toBe(FALLBACK_SLUG);
    expect(slugFromName(undefined)).toBe(FALLBACK_SLUG);
  });

  it('never hands back a name Windows refuses to make a folder for', () => {
    // CON, PRN, AUX, NUL, COM1-9 and LPT1-9 are device names on Windows, in
    // any case, and mkdir fails on every one of them.
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
    for (const name of ['CON', 'prn', 'Aux', 'nul', 'COM1', 'lpt9']) {
      expect(slugFromName(name)).not.toMatch(reserved);
      expect(slugFromName(name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
    expect(slugFromPrompt('NUL')).not.toMatch(reserved);
  });

  it('never returns something that is not a folder name', () => {
    const names = ['../../etc/passwd', '/absolute/path', 'C:\\Windows', '우주 게임', '💥💥💥', 'a'.repeat(200), '  ...  '];
    for (const name of names) {
      const slug = slugFromName(name);
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slug).not.toContain('..');
      expect(slug.startsWith('.')).toBe(false);
      expect(slug.endsWith('.')).toBe(false);
      expect(slug.trim()).toBe(slug);
    }
  });
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

  it('keeps the name that was typed, and does not show the folder instead', async () => {
    // The defect this pins: the slug WAS the name, everywhere and forever.
    const body = (await ctx.createWorkspace(undefined, '우주 게임')).body as CreateBody;
    expect(body.ok).toBe(true);
    expect(body.name).toBe('우주 게임');
    // The folder is still a plain ASCII path, because it is a path.
    expect(path.basename(body.path!)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('stores the name in the project, beside its mark and colour', async () => {
    const body = (await ctx.createWorkspace(undefined, 'Café Adventure')).body as CreateBody;
    const raw = await fsp.readFile(path.join(body.path!, '.hearth', 'project.json'), 'utf8');
    expect(JSON.parse(raw).name).toBe('Café Adventure');
    expect(path.basename(body.path!)).toBe('cafe-adventure');
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

/**
 * Every reader that hands a project's name to the window has to hand back the
 * one the person typed. The folder basename is the fallback, not the answer:
 * a project made before names were stored keeps working, unchanged, with no
 * migration.
 */
describe('the name every reader reports', () => {
  it('prefers the stored name over the folder basename when opening', async () => {
    const body = (await ctx.createWorkspace(undefined, 'Neon Drifter')).body as CreateBody;
    const reopened = (await ctx.openWorkspace(body.path!)).body as CreateBody;
    expect(reopened.name).toBe('Neon Drifter');
  });

  it('falls back to the basename for a project that stored no name', async () => {
    const legacy = path.join(tmp, 'legacy-game');
    await fsp.mkdir(legacy, { recursive: true });
    expect(((await ctx.openWorkspace(legacy)).body as CreateBody).name).toBe('legacy-game');
  });

  it('shows the stored name in the rail, not the slug it had to make', async () => {
    const body = (await ctx.createWorkspace(undefined, 'ゲーム')).body as CreateBody;
    const projects = ((await ctx.recentWorkspaces()).body as { projects: { path: string; name: string }[] }).projects;
    expect(projects.find((row) => row.path === body.path)?.name).toBe('ゲーム');
  });

  it('keeps the name when the rail changes the project’s appearance', async () => {
    // Both live in `.hearth/project.json`, and the Appearance flyout writes to
    // it without knowing a name is in there. A merge that replaced would drop
    // the name on the first colour change.
    const body = (await ctx.createWorkspace(undefined, 'Neon Drifter')).body as CreateBody;
    await ctx.setProjectIdentity(body.path, 'flame', 'coral');
    expect(((await ctx.openWorkspace(body.path!)).body as CreateBody).name).toBe('Neon Drifter');
  });

  it('shows it on a chat row, which names the project the chat is about', async () => {
    const body = (await ctx.createWorkspace(undefined, 'Café Adventure')).body as CreateBody;
    const chatsDir = path.join(body.path!, '.hearth', 'chats');
    await fsp.mkdir(chatsDir, { recursive: true });
    await fsp.writeFile(
      path.join(chatsDir, 'index.json'),
      JSON.stringify([
        { id: 'c1', title: 'First light', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ]),
    );
    const chats = ((await ctx.recentChats()).body as { chats: { id: string; project: { name: string } }[] }).chats;
    expect(chats.find((chat) => chat.id === 'c1')?.project.name).toBe('Café Adventure');
  });

  it('shows it on a playtest row, which names the game that was played', async () => {
    const body = (await ctx.createWorkspace(undefined, 'Neon Drifter')).body as CreateBody;
    const sessionDir = path.join(body.path!, '.hearth', 'tester', 'sessions', '1');
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(
      path.join(sessionDir, 'note.json'),
      JSON.stringify({ session: 1, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z' }),
    );
    const runs = ((await ctx.testerHistoryAll()).body as { runs: { project: { path: string; name: string } }[] }).runs;
    expect(runs.find((run) => run.project.path === body.path)?.project.name).toBe('Neon Drifter');
  });
});
