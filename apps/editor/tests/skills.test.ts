/**
 * Skills on disk, and the two ways they reach an agent.
 *
 * What matters here is that the format is genuinely the shared one — a folder
 * with a SKILL.md whose frontmatter names it — because that is the whole claim
 * the feature makes: one skill, either agent. The rest is the safety around
 * writing into the user's home from a request, and around NOT writing into the
 * two homes that are not Hearth's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_SKILLS_DIR,
  claudeHome,
  codexHome,
  deleteSkill,
  disabledKey,
  hearthHome,
  importSkill,
  listSkills,
  MIRROR_IGNORE_MARKER,
  parseSkillFile,
  readSkill,
  readSkillSource,
  renderSkillFile,
  safeRelativePath,
  safeSegment,
  setSkillEnabled,
  skillSlug,
  skillSources,
  skillsConfigPath,
  skillsRoot,
  syncSkillsIntoProject,
  uniqueSkillSlug,
  writeSkill,
} from '../server/skills';
import { getSkills, postSkills } from '../server/skillsRoutes';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const HOMES = {
  hearth: 'HEARTH_HOME',
  claude: 'HEARTH_CLAUDE_HOME',
  codex: 'HEARTH_CODEX_HOME',
} as const;

type Homes = Record<keyof typeof HOMES, string>;

/**
 * Point all three homes at temp folders, not just Hearth's.
 *
 * Leaving the discovered ones unset would have the suite read whatever skills
 * the machine running it happens to own — eighteen of them on the author's
 * laptop — so "is empty before anything is written" would depend on whose
 * computer it ran on.
 */
function useTempHomes(): Homes {
  const homes: Homes = { hearth: '', claude: '', codex: '' };
  const previous: Partial<Record<string, string | undefined>> = {};
  const keys = Object.keys(HOMES) as (keyof typeof HOMES)[];

  beforeEach(async () => {
    for (const key of keys) {
      previous[HOMES[key]] = process.env[HOMES[key]];
      homes[key] = await fsp.mkdtemp(path.join(os.tmpdir(), `hearth-${key}-`));
      process.env[HOMES[key]] = homes[key];
    }
  });

  afterEach(async () => {
    for (const key of keys) {
      const was = previous[HOMES[key]];
      if (was === undefined) delete process.env[HOMES[key]];
      else process.env[HOMES[key]] = was;
      await fsp.rm(homes[key], { recursive: true, force: true });
    }
  });

  return homes;
}

/** Put a skill in a home's folder by hand, the way another agent's would be. */
async function putSkill(home: string, id: string, body = 'their instructions'): Promise<string> {
  const dir = path.join(home, 'skills', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: theirs\n---\n${body}\n`);
  return dir;
}

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

  it('reads a folded block scalar, which is how hand-written skills wrap', () => {
    // Six of the skills on this machine describe themselves with `>`, and
    // reading the marker as the value put a literal ">" in the list where the
    // sentence belongs.
    const parsed = parseSkillFile(
      '---\nname: ponytail\ndescription: >\n  Forces the laziest solution\n  that actually works.\n---\n\nBody.\n',
    );
    expect(parsed.description).toBe('Forces the laziest solution that actually works.');
    expect(parsed.name).toBe('ponytail');
    expect(parsed.body).toBe('Body.');
  });

  it('keeps the lines apart in a literal block scalar', () => {
    const parsed = parseSkillFile('---\nname: a\ndescription: |\n  one\n  two\n---\nbody');
    expect(parsed.description).toBe('one\ntwo');
  });

  it('ends a block at the next field rather than swallowing it', () => {
    const parsed = parseSkillFile('---\ndescription: >\n  wrapped text\nname: after-the-block\n---\nbody');
    expect(parsed.description).toBe('wrapped text');
    expect(parsed.name).toBe('after-the-block');
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
  const homes = useTempHomes();

  it('is somewhere the user can find', () => {
    expect(hearthHome()).toBe(homes.hearth);
    expect(skillsRoot()).toBe(path.join(homes.hearth, 'skills'));
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
  const homes = useTempHomes();

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
    await expect(fsp.stat(path.join(homes.hearth, '..', 'evil.sh'))).rejects.toThrow();
  });

  it('steps aside for a name another agent already uses', async () => {
    // Taking `humanizer` here would shadow the one in ~/.claude/skills and
    // leave two folders of one name, only one of which any agent would load.
    await putSkill(homes.claude, 'humanizer');
    const result = await importSkill(
      [{ relPath: 'SKILL.md', data: b64('---\nname: Humanizer\ndescription: d\n---\nbody') }],
      'humanizer',
    );
    expect(result.skill?.id).toBe('humanizer-2');
  });
});

describe('reaching the Agent SDK', () => {
  const homes = useTempHomes();
  let project: string;

  beforeEach(async () => {
    project = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-project-'));
  });

  afterEach(async () => {
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

  it('mirrors a discovered skill too, because the SDK only looks around its cwd', async () => {
    const theirs = await putSkill(homes.claude, 'impeccable');
    expect(await syncSkillsIntoProject(project)).toEqual(['impeccable']);
    const link = path.join(project, CLAUDE_SKILLS_DIR, 'impeccable');
    expect(await fsp.readlink(link)).toBe(theirs);
  });

  it('takes a switched-off discovered skill back out again', async () => {
    // The cleanup used to recognise links into Hearth's root only, so a
    // discovered skill switched off kept its link and stayed live to the agent
    // while the panel said it was off.
    await putSkill(homes.codex, 'ponytail');
    await syncSkillsIntoProject(project);
    await setSkillEnabled('ponytail', false);
    expect(await syncSkillsIntoProject(project)).toEqual([]);
    await expect(fsp.stat(path.join(project, CLAUDE_SKILLS_DIR, 'ponytail'))).rejects.toThrow();
  });

  it('leaves the folder it borrowed exactly as it found it', async () => {
    const theirs = await putSkill(homes.claude, 'impeccable');
    await syncSkillsIntoProject(project);
    await setSkillEnabled('impeccable', false);
    await syncSkillsIntoProject(project);
    expect(await fsp.readFile(path.join(theirs, 'SKILL.md'), 'utf8')).toContain('their instructions');
  });

  /**
   * The mirror is the one place a personal thing is written into a game folder,
   * and a game folder is a git repo somebody pushes. What gets committed if
   * nothing stops it: on macOS and Linux a symlink into the user's home, which
   * both leaks where they live on disk and resolves to nothing for whoever
   * clones the game; on Windows without developer mode a full copy, which
   * publishes the text of every private skill they own.
   */
  describe('keeping the mirror out of the project’s git history', () => {
    const ignoreFile = (): string => path.join(project, CLAUDE_SKILLS_DIR, '.gitignore');

    it('names every skill it mirrored', async () => {
      await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
      await putSkill(homes.claude, 'impeccable');
      await syncSkillsIntoProject(project);
      const text = await fsp.readFile(ignoreFile(), 'utf8');
      expect(text.startsWith(MIRROR_IGNORE_MARKER)).toBe(true);
      const rules = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
      // Leading slash: anchored to this folder, so a skill called `art` cannot
      // also silence `something/art` deeper in the project.
      expect(rules.sort()).toEqual(['/impeccable', '/pixel-art']);
    });

    it('never names a skill the project ships itself', async () => {
      // The whole reason this is a list of names and not a blanket
      // `.claude/skills/` rule. A template scaffolds `hearth-*` skills into this
      // same folder; those belong to the GAME, they are meant to be committed,
      // and a clone that arrives without them is a broken copy.
      const shipped = path.join(project, CLAUDE_SKILLS_DIR, 'hearth-art');
      await fsp.mkdir(shipped, { recursive: true });
      await fsp.writeFile(path.join(shipped, 'SKILL.md'), 'the project’s own');
      await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
      await syncSkillsIntoProject(project);
      const text = await fsp.readFile(ignoreFile(), 'utf8');
      expect(text).toContain('/pixel-art');
      expect(text).not.toContain('hearth-art');
      // And it is still there to be committed.
      expect(await fsp.readFile(path.join(shipped, 'SKILL.md'), 'utf8')).toBe('the project’s own');
    });

    it('drops the line when the skill is switched off', async () => {
      await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
      await writeSkill({ name: 'Impeccable', description: 'a', body: 'b' });
      await syncSkillsIntoProject(project);
      await setSkillEnabled('pixel-art', false);
      await syncSkillsIntoProject(project);
      const text = await fsp.readFile(ignoreFile(), 'utf8');
      expect(text).toContain('/impeccable');
      expect(text).not.toContain('/pixel-art');
    });

    it('removes the file entirely once nothing is mirrored', async () => {
      // A project with no mirrors in it should look untouched. An empty
      // .gitignore left behind is a file the person has to wonder about.
      await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
      await syncSkillsIntoProject(project);
      await setSkillEnabled('pixel-art', false);
      await syncSkillsIntoProject(project);
      await expect(fsp.stat(ignoreFile())).rejects.toThrow();
    });

    it('will not touch a .gitignore somebody wrote by hand', async () => {
      // Same rule as `.hearth-copy` enforces for the mirrors: Hearth only ever
      // edits what Hearth wrote. Silently rewriting a file the person put here
      // would be the app deciding what their repo ignores.
      const mine = '# mine\n/secret\n';
      await fsp.mkdir(path.join(project, CLAUDE_SKILLS_DIR), { recursive: true });
      await fsp.writeFile(ignoreFile(), mine);
      await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
      await syncSkillsIntoProject(project);
      expect(await fsp.readFile(ignoreFile(), 'utf8')).toBe(mine);
      // Even when there is nothing left to ignore, it is not ours to delete.
      await setSkillEnabled('pixel-art', false);
      await syncSkillsIntoProject(project);
      expect(await fsp.readFile(ignoreFile(), 'utf8')).toBe(mine);
    });

    it('leaves the mirrors themselves working', async () => {
      // The guard must not have cost the feature: the SDK still has to be able
      // to read the skill out of the folder it looks in.
      await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
      await syncSkillsIntoProject(project);
      const linked = path.join(project, CLAUDE_SKILLS_DIR, 'pixel-art', 'SKILL.md');
      expect(await fsp.readFile(linked, 'utf8')).toContain('name: Pixel art');
    });
  });
});

describe('skills the other agents already have', () => {
  const homes = useTempHomes();

  it('reads from three folders, and may only write to one', () => {
    expect(skillSources()).toEqual([
      { source: 'hearth', dir: path.join(homes.hearth, 'skills'), editable: true },
      { source: 'claude', dir: path.join(homes.claude, 'skills'), editable: false },
      { source: 'codex', dir: path.join(homes.codex, 'skills'), editable: false },
    ]);
    expect(claudeHome()).toBe(homes.claude);
    expect(codexHome()).toBe(homes.codex);
  });

  it('lists what the other agents were taught, marked as theirs', async () => {
    await putSkill(homes.claude, 'impeccable');
    await putSkill(homes.codex, 'ponytail');
    await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
    // Hearth's own come first: the panel groups them, and what someone wrote
    // themselves is what they came to this screen to find.
    expect((await listSkills()).map((skill) => [skill.id, skill.source, skill.editable])).toEqual([
      ['pixel-art', 'hearth', true],
      ['impeccable', 'claude', false],
      ['ponytail', 'codex', false],
    ]);
  });

  it('carries on when a folder it hoped to read is not there', async () => {
    await fsp.rm(homes.codex, { recursive: true, force: true });
    process.env.HEARTH_CLAUDE_HOME = path.join(homes.claude, 'nowhere');
    await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
    expect((await listSkills()).map((skill) => skill.id)).toEqual(['pixel-art']);
  });

  it('lets a skill written here shadow one of the same name', async () => {
    // Both agents match on the folder name, so only one `humanizer` can ever
    // win. The one the user wrote is the one they meant.
    await putSkill(homes.claude, 'humanizer');
    // Written by hand, because creating one through Hearth deliberately steps
    // aside to `humanizer-2` rather than minting the collision in the first
    // place. This is the folder that was already there when Hearth learned to
    // look elsewhere.
    await putSkill(homes.hearth, 'humanizer', 'my rules');
    const listed = await listSkills();
    expect(listed.map((skill) => skill.id)).toEqual(['humanizer']);
    expect(listed[0].source).toBe('hearth');
    expect(listed[0].editable).toBe(true);
    expect((await readSkillSource('humanizer'))?.body).toBe('my rules');
    // And it is Hearth's copy that a write reaches, not the borrowed one.
    expect((await writeSkill({ name: 'humanizer', description: 'd', body: 'edited' }, 'humanizer'))?.path).toBe(
      path.join(skillsRoot(), 'humanizer'),
    );
  });

  it('shows a discovered skill its own markdown, read-only', async () => {
    await putSkill(homes.claude, 'impeccable', 'never ship a bland interface');
    expect(await readSkillSource('impeccable')).toEqual({
      name: 'impeccable',
      description: 'theirs',
      body: 'never ship a bland interface',
    });
  });

  it('will not rewrite a skill that belongs to another agent', async () => {
    const theirs = await putSkill(homes.claude, 'impeccable');
    expect(await writeSkill({ name: 'impeccable', description: 'x', body: 'mine now' }, 'impeccable')).toBeNull();
    expect(await fsp.readFile(path.join(theirs, 'SKILL.md'), 'utf8')).toContain('their instructions');
  });

  it('will not delete a skill that belongs to another agent', async () => {
    const theirs = await putSkill(homes.codex, 'ponytail');
    expect(await deleteSkill('ponytail')).toBe(false);
    await expect(fsp.stat(path.join(theirs, 'SKILL.md'))).resolves.toBeTruthy();
  });

  it('switches a discovered skill off, and remembers across a re-read', async () => {
    await putSkill(homes.claude, 'impeccable');
    expect((await setSkillEnabled('impeccable', false))?.enabled).toBe(false);
    expect((await listSkills())[0].enabled).toBe(false);
    expect((await readSkill('impeccable'))?.enabled).toBe(false);
    expect((await setSkillEnabled('impeccable', true))?.enabled).toBe(true);
  });

  it('writes a discovered skill into the list under the agent it came from', async () => {
    await putSkill(homes.claude, 'humanizer');
    await setSkillEnabled('humanizer', false);
    const saved = JSON.parse(await fsp.readFile(skillsConfigPath(), 'utf8')) as { disabled: string[] };
    expect(saved.disabled).toEqual(['claude/humanizer']);
    expect(disabledKey('claude', 'humanizer')).toBe('claude/humanizer');
    expect(disabledKey('hearth', 'humanizer')).toBe('humanizer');
  });

  it('still honours a bare id from a skills.json written before any of this', async () => {
    // Every entry in every existing skills.json is a bare Hearth id, because
    // there was nowhere else to read from when it was written. If those stopped
    // meaning anything, everyone's switched-off list would silently reset.
    await writeSkill({ name: 'Pixel art', description: 'a', body: 'b' });
    await fsp.writeFile(skillsConfigPath(), `${JSON.stringify({ disabled: ['pixel-art'] })}\n`);
    expect((await listSkills())[0].enabled).toBe(false);
  });

  it('does not let a bare id reach into a folder it never described', async () => {
    await putSkill(homes.claude, 'humanizer');
    await fsp.mkdir(hearthHome(), { recursive: true });
    await fsp.writeFile(skillsConfigPath(), `${JSON.stringify({ disabled: ['humanizer'] })}\n`);
    // The bare id is a leftover from a Hearth skill that is no longer here. It
    // has no business reaching into Claude Code's folder.
    expect((await listSkills())[0].enabled).toBe(true);
  });
});

describe('the route', () => {
  const homes = useTempHomes();

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

  it('says whose skill it is rather than failing quietly', async () => {
    await putSkill(homes.claude, 'impeccable');
    const edit = await postSkills({ action: 'update', id: 'impeccable', draft: { name: 'x', description: '', body: 'y' } });
    expect(edit.status).toBe(403);
    expect((edit.body as { error: string }).error).toContain('belongs to Claude Code');
    expect((edit.body as { error: string }).error).toContain('switch it on or off');

    const remove = await postSkills({ action: 'delete', id: 'impeccable' });
    expect(remove.status).toBe(403);
    expect((remove.body as { error: string }).error).toContain('belongs to Claude Code');
  });

  it('still lets a discovered skill be switched off', async () => {
    await putSkill(homes.codex, 'ponytail');
    const result = await postSkills({ action: 'enable', id: 'ponytail', enabled: false });
    expect(result.status).toBe(200);
    expect((result.body as { skill: { enabled: boolean } }).skill.enabled).toBe(false);
  });
});
