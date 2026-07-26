/**
 * Skills on disk, and the two ways they reach an agent.
 *
 * What matters here is that the format is genuinely the shared one — a folder
 * with a SKILL.md whose frontmatter names it — because that is the whole claim
 * the feature makes: one skill, either agent. The rest is the safety around
 * writing into the user's home from a request.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_SKILLS_DIR,
  deleteSkill,
  hearthHome,
  importSkill,
  listSkills,
  parseSkillFile,
  readSkillSource,
  renderSkillFile,
  safeRelativePath,
  safeSegment,
  setSkillEnabled,
  skillSlug,
  skillsRoot,
  syncSkillsIntoProject,
  uniqueSkillSlug,
  writeSkill,
} from '../server/skills';
import { getSkills, postSkills } from '../server/skillsRoutes';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('the SKILL.md format', () => {
  it('reads the frontmatter both agents require', () => {
    const parsed = parseSkillFile('---\nname: pixel-art\ndescription: "Sprites, tilesets."\n---\n\nUse 16 colours.\n');
    expect(parsed).toEqual({ name: 'pixel-art', description: 'Sprites, tilesets.', body: 'Use 16 colours.' });
  });

  it('treats a file with no frontmatter as all body rather than failing', () => {
    expect(parseSkillFile('just instructions')).toEqual({ name: '', description: '', body: 'just instructions' });
  });

  it('survives a field it has never heard of', () => {
    const parsed = parseSkillFile('---\nname: a\nlicense: MIT\ndescription: b\n---\nbody');
    expect(parsed.name).toBe('a');
    expect(parsed.description).toBe('b');
  });

  it('writes frontmatter that cannot be broken by a colon in the description', () => {
    const text = renderSkillFile({ name: 'Pixel art', description: 'Use when: drawing sprites', body: 'x' });
    expect(parseSkillFile(text).description).toBe('Use when: drawing sprites');
  });

  it('round-trips through render and parse', () => {
    const draft = { name: 'Sound design', description: 'Making sound effects.', body: 'Prefer short samples.' };
    expect(parseSkillFile(renderSkillFile(draft))).toEqual(draft);
  });
});

describe('naming', () => {
  it('folds a display name into something a path and an agent both accept', () => {
    expect(skillSlug('Pixel Art!')).toBe('pixel-art');
    expect(skillSlug("Don't Repeat")).toBe('dont-repeat');
    expect(skillSlug('***')).toBe('skill');
  });

  it('steps aside for a name already taken', () => {
    expect(uniqueSkillSlug('pixel-art', new Set(['pixel-art']))).toBe('pixel-art-2');
    expect(uniqueSkillSlug('pixel-art', new Set())).toBe('pixel-art');
  });

  it('refuses a segment that would leave the folder', () => {
    expect(safeSegment('..')).toBeNull();
    expect(safeSegment('a/b')).toBeNull();
    expect(safeSegment('  ')).toBeNull();
    expect(safeSegment('pixel-art')).toBe('pixel-art');
  });

  it('refuses an imported path that climbs out', () => {
    expect(safeRelativePath('../../.ssh/id_rsa')).toBeNull();
    expect(safeRelativePath('scripts/build.sh')).toBe('scripts/build.sh');
    expect(safeRelativePath('a/b/c/d/e/f/g/h/i/j')).toBeNull();
  });
});

describe('the folder', () => {
  let home: string;
  const previous = process.env.HEARTH_HOME;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-home-'));
    process.env.HEARTH_HOME = home;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.HEARTH_HOME;
    else process.env.HEARTH_HOME = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('is somewhere the user can find', () => {
    expect(hearthHome()).toBe(home);
    expect(skillsRoot()).toBe(path.join(home, 'skills'));
  });

  it('is empty, not broken, before anything is written', async () => {
    expect(await listSkills()).toEqual([]);
  });

  it('writes a skill an agent would recognise', async () => {
    const skill = await writeSkill({ name: 'Pixel art', description: 'Sprites.', body: 'Use 16 colours.' });
    expect(skill?.id).toBe('pixel-art');
    const text = await fsp.readFile(path.join(skillsRoot(), 'pixel-art', 'SKILL.md'), 'utf8');
    expect(text.startsWith('---\nname: Pixel art\n')).toBe(true);
    expect(text).toContain('Use 16 colours.');
  });

  it('rewrites in place rather than renaming the folder out from under an agent', async () => {
    await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
    const updated = await writeSkill({ name: 'Pixel Art Pro', description: 'c', body: 'd' }, 'pixel-art');
    expect(updated?.id).toBe('pixel-art');
    expect(updated?.name).toBe('Pixel Art Pro');
    expect(await listSkills()).toHaveLength(1);
  });

  it('refuses to rewrite a skill that is not there, rather than forking a new one', async () => {
    // A stale id (a delete that raced a save, or a client bug) used to fall
    // through to the create path and quietly mint a duplicate.
    expect(await writeSkill({ name: 'Ghost', description: 'a', body: 'b' }, 'ghost')).toBeNull();
    expect(await writeSkill({ name: 'Ghost', description: 'a', body: 'b' }, '../evil')).toBeNull();
    expect(await listSkills()).toEqual([]);
  });

  it('hands the editor back what was written', async () => {
    await writeSkill({ name: 'Sound', description: 'Making noise.', body: 'Short samples.' });
    expect(await readSkillSource('sound')).toEqual({
      name: 'Sound',
      description: 'Making noise.',
      body: 'Short samples.',
    });
  });

  it('remembers which ones are switched off, across a re-read', async () => {
    await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
    expect((await setSkillEnabled('pixel-art', false))?.enabled).toBe(false);
    expect((await listSkills())[0].enabled).toBe(false);
    expect((await setSkillEnabled('pixel-art', true))?.enabled).toBe(true);
  });

  it('ignores a folder with no SKILL.md in it', async () => {
    await fsp.mkdir(path.join(skillsRoot(), 'not-a-skill'), { recursive: true });
    await writeSkill({ name: 'Real', description: 'a', body: 'b' });
    expect((await listSkills()).map((s) => s.id)).toEqual(['real']);
  });

  it('deletes the folder, and forgets it was disabled', async () => {
    await writeSkill({ name: 'Gone', description: 'a', body: 'b' });
    await setSkillEnabled('gone', false);
    expect(await deleteSkill('gone')).toBe(true);
    expect(await listSkills()).toEqual([]);
    // The name is free again, and comes back enabled rather than remembering
    // a switch someone flipped on a skill that no longer exists.
    await writeSkill({ name: 'Gone', description: 'a', body: 'b' });
    expect((await listSkills())[0].enabled).toBe(true);
  });

  it('will not delete its way out of the skills folder', async () => {
    expect(await deleteSkill('../..')).toBe(false);
    expect(await deleteSkill('')).toBe(false);
  });
});

describe('importing a folder someone picked', () => {
  let home: string;
  const previous = process.env.HEARTH_HOME;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-home-'));
    process.env.HEARTH_HOME = home;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.HEARTH_HOME;
    else process.env.HEARTH_HOME = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('takes a real skill, files and all', async () => {
    const result = await importSkill(
      [
        { relPath: 'SKILL.md', data: b64('---\nname: Tilemaps\ndescription: d\n---\nbody') },
        { relPath: 'reference/notes.md', data: b64('more') },
      ],
      'fallback',
    );
    expect(result.skill?.id).toBe('tilemaps');
    expect(await fsp.readFile(path.join(skillsRoot(), 'tilemaps', 'reference', 'notes.md'), 'utf8')).toBe('more');
  });

  it('refuses a folder that is not a skill, and says why', async () => {
    const result = await importSkill([{ relPath: 'readme.txt', data: b64('hi') }], 'whatever');
    expect(result.skill).toBeNull();
    expect(result.error).toContain('SKILL.md');
  });

  it('drops a file trying to climb out, without failing the import', async () => {
    const result = await importSkill(
      [
        { relPath: 'SKILL.md', data: b64('---\nname: Safe\ndescription: d\n---\nbody') },
        { relPath: '../../../evil.sh', data: b64('rm -rf /') },
      ],
      'safe',
    );
    expect(result.skill?.id).toBe('safe');
    await expect(fsp.stat(path.join(home, '..', 'evil.sh'))).rejects.toThrow();
  });
});

describe('reaching the Agent SDK', () => {
  let home: string;
  let project: string;
  const previous = process.env.HEARTH_HOME;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-home-'));
    project = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-project-'));
    process.env.HEARTH_HOME = home;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.HEARTH_HOME;
    else process.env.HEARTH_HOME = previous;
    await fsp.rm(home, { recursive: true, force: true });
    await fsp.rm(project, { recursive: true, force: true });
  });

  it('puts an enabled skill where the SDK looks for one', async () => {
    await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
    expect(await syncSkillsIntoProject(project)).toEqual(['pixel-art']);
    const linked = path.join(project, CLAUDE_SKILLS_DIR, 'pixel-art', 'SKILL.md');
    expect(await fsp.readFile(linked, 'utf8')).toContain('name: Pixel art');
  });

  it('takes a switched-off skill back out again', async () => {
    await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
    await syncSkillsIntoProject(project);
    await setSkillEnabled('pixel-art', false);
    expect(await syncSkillsIntoProject(project)).toEqual([]);
    await expect(fsp.stat(path.join(project, CLAUDE_SKILLS_DIR, 'pixel-art'))).rejects.toThrow();
  });

  it('never touches a skill the user put there by hand', async () => {
    const mine = path.join(project, CLAUDE_SKILLS_DIR, 'mine');
    await fsp.mkdir(mine, { recursive: true });
    await fsp.writeFile(path.join(mine, 'SKILL.md'), 'mine');
    await writeSkill({ name: 'Hearth one', description: 'a', body: 'b' });
    await syncSkillsIntoProject(project);
    expect(await fsp.readFile(path.join(mine, 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it('refreshes and removes a COPIED skill, not just a linked one', async () => {
    // The Windows path: where a symlink is refused the skill is copied, and a
    // copy that can never be refreshed or removed would leave a switched-off
    // skill live to the agent.
    await writeSkill({ name: 'Copied', description: 'a', body: 'first' });
    const link = path.join(project, CLAUDE_SKILLS_DIR, 'copied');
    await fsp.mkdir(path.dirname(link), { recursive: true });
    await fsp.cp(path.join(skillsRoot(), 'copied'), link, { recursive: true });
    await fsp.writeFile(path.join(link, '.hearth-copy'), `${path.join(skillsRoot(), 'copied')}\n`);

    // An edit reaches it…
    await writeSkill({ name: 'Copied', description: 'a', body: 'second' }, 'copied');
    await syncSkillsIntoProject(project);
    expect(await fsp.readFile(path.join(link, 'SKILL.md'), 'utf8')).toContain('second');

    // …and switching it off actually removes it.
    await setSkillEnabled('copied', false);
    await syncSkillsIntoProject(project);
    await expect(fsp.stat(link)).rejects.toThrow();
  });

  it('is safe to run twice', async () => {
    await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
    await syncSkillsIntoProject(project);
    expect(await syncSkillsIntoProject(project)).toEqual(['pixel-art']);
  });
});

describe('the route', () => {
  let home: string;
  const previous = process.env.HEARTH_HOME;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-home-'));
    process.env.HEARTH_HOME = home;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.HEARTH_HOME;
    else process.env.HEARTH_HOME = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('answers with the list and where it lives', async () => {
    const result = await getSkills();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ skills: [], root: skillsRoot() });
  });

  it('creates, and answers with the list that resulted', async () => {
    const result = await postSkills({ action: 'create', draft: { name: 'Pixel art', description: 'a', body: 'b' } });
    expect(result.status).toBe(200);
    expect((result.body as { skills: unknown[] }).skills).toHaveLength(1);
  });

  it('refuses a nameless skill with a sentence, not a stack trace', async () => {
    const result = await postSkills({ action: 'create', draft: { name: '  ', description: '', body: 'x' } });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('name');
  });

  it('rejects an action it does not have', async () => {
    expect((await postSkills({ action: 'exfiltrate' })).status).toBe(400);
    expect((await postSkills(null)).status).toBe(400);
  });

  it('404s a skill that is not there rather than inventing one', async () => {
    expect((await postSkills({ action: 'enable', id: 'ghost', enabled: false })).status).toBe(404);
    expect((await postSkills({ action: 'delete', id: 'ghost' })).status).toBe(404);
  });
});
