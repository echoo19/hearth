/**
 * What a project looks like, on disk.
 *
 * Identity lives in `.hearth/project.json` rather than in `app.json` for one
 * reason worth pinning: `app.json` holds API keys and is written 0600, and a
 * mark is the opposite kind of thing — you want it committed, so a repo
 * someone clones opens with the mark its author saw.
 *
 * The server owns no palette. It stores two short strings and hands them back;
 * anything it cannot vouch for reads as "nothing stored", which is a complete
 * answer because the renderer derives a mark from the path in that case.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDENTITY_FILE, readProjectIdentity, writeProjectIdentity } from '../server/projectIdentity';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-identity-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const identityFile = (): string => path.join(root, IDENTITY_FILE);

describe('reading', () => {
  it('says nothing stored for a project that has never been given a mark', async () => {
    expect(await readProjectIdentity(root)).toEqual({});
  });

  it('survives a file that is not JSON at all', async () => {
    await fsp.mkdir(path.dirname(identityFile()), { recursive: true });
    await fsp.writeFile(identityFile(), 'not json {{{');
    expect(await readProjectIdentity(root)).toEqual({});
  });

  it('survives a file holding the wrong shape', async () => {
    await fsp.mkdir(path.dirname(identityFile()), { recursive: true });
    await fsp.writeFile(identityFile(), '["teal"]');
    expect(await readProjectIdentity(root)).toEqual({});
  });

  it('drops a field that could not be a mark or a palette key', async () => {
    // Both of these are read back as an icon-set index and a CSS custom
    // property lookup. Neither should ever carry punctuation, a path, or a
    // paragraph, and a hand-edited file must not be able to smuggle one in.
    await fsp.mkdir(path.dirname(identityFile()), { recursive: true });
    await fsp.writeFile(
      identityFile(),
      JSON.stringify({ icon: '../../etc/passwd', color: 'a'.repeat(200) }),
    );
    expect(await readProjectIdentity(root)).toEqual({});
  });

  it('keeps the good field when the other one is junk', async () => {
    await fsp.mkdir(path.dirname(identityFile()), { recursive: true });
    await fsp.writeFile(identityFile(), JSON.stringify({ icon: 'flame', color: { nope: true } }));
    expect(await readProjectIdentity(root)).toEqual({ icon: 'flame' });
  });
});

describe('writing', () => {
  it('round-trips a mark and a colour', async () => {
    await writeProjectIdentity(root, { icon: 'grid', color: 'teal' });
    expect(await readProjectIdentity(root)).toEqual({ icon: 'grid', color: 'teal' });
  });

  it('merges rather than replaces, so setting one does not drop the other', async () => {
    await writeProjectIdentity(root, { icon: 'grid', color: 'teal' });
    await writeProjectIdentity(root, { color: 'coral' });
    expect(await readProjectIdentity(root)).toEqual({ icon: 'grid', color: 'coral' });
  });

  it('clears a field back to derived when given an empty string', async () => {
    await writeProjectIdentity(root, { icon: 'grid', color: 'teal' });
    await writeProjectIdentity(root, { icon: '' });
    expect(await readProjectIdentity(root)).toEqual({ color: 'teal' });
  });

  it('makes the .hearth directory rather than failing on a fresh project', async () => {
    await writeProjectIdentity(root, { color: 'iris' });
    expect((await fsp.stat(identityFile())).isFile()).toBe(true);
  });

  it('writes plain readable JSON — this is a file people commit', async () => {
    await writeProjectIdentity(root, { icon: 'star', color: 'moss' });
    const raw = await fsp.readFile(identityFile(), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual({ icon: 'star', color: 'moss' });
  });

  it('is not written next to the API keys', async () => {
    // app.json is chmod 0600 and holds secrets; identity is neither.
    expect(IDENTITY_FILE).not.toContain('app.json');
    expect(IDENTITY_FILE.startsWith('.hearth')).toBe(true);
  });
});

/**
 * The name is the third thing a project says about itself, and the only one a
 * person typed. The folder it lives in is a slug, because a path has to
 * survive every filesystem, shell and git remote; the name has to survive
 * nothing at all, so it keeps every character it was given.
 */
describe('the name a person typed', () => {
  it('round-trips a name in any script, unchanged', async () => {
    for (const name of ['우주 게임', 'ゲーム', 'Café Adventure', 'The Legend of Zelda Ocarina']) {
      await writeProjectIdentity(root, { name });
      expect((await readProjectIdentity(root)).name).toBe(name);
    }
  });

  it('keeps punctuation a folder name could never hold', async () => {
    await writeProjectIdentity(root, { name: "Don't Starve: Clone! (v2)" });
    expect((await readProjectIdentity(root)).name).toBe("Don't Starve: Clone! (v2)");
  });

  it('does not disturb the mark or the colour', async () => {
    await writeProjectIdentity(root, { icon: 'grid', color: 'teal' });
    await writeProjectIdentity(root, { name: 'Neon Drifter' });
    expect(await readProjectIdentity(root)).toEqual({ icon: 'grid', color: 'teal', name: 'Neon Drifter' });
  });

  it('clears back to the folder basename when given an empty string', async () => {
    await writeProjectIdentity(root, { name: 'Neon Drifter' });
    await writeProjectIdentity(root, { name: '   ' });
    expect((await readProjectIdentity(root)).name).toBeUndefined();
  });

  it('collapses the whitespace and control characters a paste can carry', async () => {
    await writeProjectIdentity(root, { name: '  Neon\tDrifter\n' });
    expect((await readProjectIdentity(root)).name).toBe('Neon Drifter');
  });

  it('bounds the length rather than storing a novel', async () => {
    await writeProjectIdentity(root, { name: 'a'.repeat(500) });
    const stored = (await readProjectIdentity(root)).name ?? '';
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThanOrEqual(120);
  });

  it('reads as nothing stored when the file holds the wrong shape for a name', async () => {
    await fsp.mkdir(path.dirname(identityFile()), { recursive: true });
    await fsp.writeFile(identityFile(), JSON.stringify({ icon: 'flame', name: { nope: true } }));
    expect(await readProjectIdentity(root)).toEqual({ icon: 'flame' });
  });
});
