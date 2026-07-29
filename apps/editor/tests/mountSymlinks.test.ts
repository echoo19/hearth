/**
 * The static mounts, against a project folder that contains symlinks.
 *
 * The threat model is the whole point: game code in a project folder is written
 * by an AGENT, and creating a file in that folder is the most ordinary thing it
 * does. Both mount guards were lexical (`path.resolve`, then `path.relative`
 * against the base), and `readFile` follows links, so a link was a complete
 * bypass of the `.hearth` / `.git` / `.env` denial and of the "stays inside the
 * project" rule:
 *
 *   ln -s .hearth assets        -> GET assets/app.json served the saved API keys
 *   ln -s .hearth/app.json a.png -> the same, through one file
 *   ln -s ../outside.txt b.png  -> bytes from outside the project entirely
 *
 * The mounts are on their own origin (gameServer.ts) and the mount key is
 * sitting in the game's own location.pathname, so this was reachable from a
 * two-line fetch in the game itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectServerContext, encodeRootKey, type ProjectServerContext } from '../server/projectServer';

let tmp: string;
let folder: string;
let ctx: ProjectServerContext;

/** The bytes a 200 carried, or the empty string when the mount served none. */
function body(result: { status: number; data?: Uint8Array }): string {
  return result.status === 200 && result.data ? Buffer.from(result.data).toString('utf8') : '';
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-mount-links-'));
  folder = path.join(tmp, 'my-game');
  await fsp.mkdir(path.join(folder, '.hearth'), { recursive: true });
  await fsp.writeFile(path.join(folder, 'index.html'), '<canvas></canvas>');
  await fsp.writeFile(path.join(folder, '.hearth', 'app.json'), '{"apiKey":"sk-SECRET-KEY"}');
  await fsp.writeFile(path.join(tmp, 'outside.txt'), 'NOT PART OF THE PROJECT');

  // Exactly what an agent writing game code can create.
  await fsp.symlink('.hearth', path.join(folder, 'assets'), 'dir');
  await fsp.symlink(path.join('.hearth', 'app.json'), path.join(folder, 'atlas.png'));
  await fsp.symlink(path.join('..', 'outside.txt'), path.join(folder, 'sprite.png'));
  await fsp.symlink(path.join('..', 'nothing-here.txt'), path.join(folder, 'broken.png'));
  // A link that stays inside the project is ordinary and must keep working:
  // a shared asset folder, a vendored engine build.
  await fsp.mkdir(path.join(folder, 'shared'), { recursive: true });
  await fsp.writeFile(path.join(folder, 'shared', 'sprite.png'), 'REAL SPRITE BYTES');
  await fsp.symlink(path.join('shared', 'sprite.png'), path.join(folder, 'hero.png'));

  ctx = createProjectServerContext({ recentsFile: path.join(tmp, 'recents.json'), repoRoot: tmp });
  await ctx.openWorkspace(folder);
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('the game mount and symlinks', () => {
  it('refuses a hidden folder reached through a linked directory', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), 'assets/app.json');
    expect(body(result)).not.toContain('sk-SECRET-KEY');
    expect(result.status).toBe(403);
  });

  it('refuses a hidden file reached through a link that names itself an image', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), 'atlas.png');
    expect(body(result)).not.toContain('sk-SECRET-KEY');
    expect(result.status).toBe(403);
  });

  it('refuses a link that points outside the project root', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), 'sprite.png');
    expect(body(result)).not.toContain('NOT PART OF THE PROJECT');
    expect(result.status).toBe(403);
  });

  it('404s a link that points at nothing rather than throwing', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), 'broken.png');
    expect(result.status).toBe(404);
  });

  it('still serves a link that stays inside the project', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), 'hero.png');
    expect(result.status).toBe(200);
    expect(body(result)).toBe('REAL SPRITE BYTES');
  });

  it('still serves an ordinary file', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), 'index.html');
    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/html');
  });
});

/**
 * The evidence mount rebases to `.hearth/evidence` BEFORE the hidden-segment
 * check, which is the whole reason it can serve anything at all. Resolving links
 * must not undo that.
 */
describe('the evidence mount and symlinks', () => {
  it('still serves evidence, whose base is itself inside a hidden folder', async () => {
    await fsp.mkdir(path.join(folder, '.hearth', 'evidence', 'sweeps'), { recursive: true });
    await fsp.writeFile(path.join(folder, '.hearth', 'evidence', 'sweeps', 'a.png'), 'PNGDATA');
    const result = await ctx.serveMounted('evidence', encodeRootKey(folder), 'sweeps/a.png');
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('image/png');
  });

  it('refuses a link out of the evidence folder into the rest of .hearth', async () => {
    await fsp.mkdir(path.join(folder, '.hearth', 'evidence'), { recursive: true });
    const link = path.join(folder, '.hearth', 'evidence', 'keys.png');
    await fsp.rm(link, { force: true });
    await fsp.symlink(path.join('..', 'app.json'), link);
    const result = await ctx.serveMounted('evidence', encodeRootKey(folder), 'keys.png');
    expect(body(result)).not.toContain('sk-SECRET-KEY');
    expect(result.status).toBe(403);
  });
});
