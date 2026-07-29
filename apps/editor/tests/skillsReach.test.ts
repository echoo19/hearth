/**
 * Who can actually use a skill.
 *
 * A skill is a folder with a SKILL.md in it, and Hearth finds them in three
 * places: its own, Claude Code's, and Codex's. The list showed the folder each
 * one came from, and people read that badge as the set of agents the skill
 * worked with. It never meant that, and it must not become true by accident.
 *
 * Reaching an agent takes whatever that agent supports, so the guarantee is
 * layered and each layer is pinned here:
 *
 *   the mirror   every ENABLED skill, from every source, is materialised in
 *                the project. This is the single source both native paths and
 *                the prompt all point at.
 *   native       the Agent SDK discovers the mirror from its cwd; codex is
 *                handed the same folder through `skills/extraRoots/set`.
 *   everyone     the folder is NAMED in the house facts, which is the only
 *                thing that reaches an agent Hearth did not write a driver
 *                for, and most of what people run here is exactly that.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_SKILLS_DIR, syncSkillsIntoProject } from '../server/skills';
import { hearthFactsPrompt, SKILLS_PROMPT_DIR } from '../server/agentFacts';

let home: string;
let claude: string;
let project: string;

/** A skill folder in one of the source roots, as a real SKILL.md on disk. */
async function writeSkill(root: string, slug: string, name: string): Promise<void> {
  const dir = path.join(root, 'skills', slug);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: when to use ${name}\n---\n\nDo the thing.\n`,
    'utf8',
  );
}

beforeEach(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'skills-reach-'));
  home = path.join(base, 'hearth');
  claude = path.join(base, 'claude');
  project = path.join(base, 'project');
  await fsp.mkdir(project, { recursive: true });
  process.env.HEARTH_HOME = home;
  process.env.HEARTH_CLAUDE_HOME = claude;
  process.env.HEARTH_CODEX_HOME = path.join(base, 'codex');
});

afterEach(async () => {
  delete process.env.HEARTH_HOME;
  delete process.env.HEARTH_CLAUDE_HOME;
  delete process.env.HEARTH_CODEX_HOME;
});

describe('the mirror every agent is pointed at', () => {
  it('carries a skill found in another agent folder, not just Hearth own', async () => {
    // The whole complaint in one assertion. A skill sitting in
    // `~/.claude/skills` used to be reachable by Claude Code and by nothing
    // else Hearth drives, while the screen listed it as installed.
    await writeSkill(home, 'mine', 'mine');
    await writeSkill(claude, 'borrowed', 'borrowed');

    const mirrored = await syncSkillsIntoProject(project);

    expect(mirrored.sort()).toEqual(['borrowed', 'mine']);
    const inProject = await fsp.readdir(path.join(project, CLAUDE_SKILLS_DIR));
    expect(inProject).toContain('borrowed');
  });

  it('resolves to the borrowed skill own file, rather than a stale copy of it', async () => {
    await writeSkill(claude, 'borrowed', 'borrowed');
    await syncSkillsIntoProject(project);
    const text = await fsp.readFile(
      path.join(project, CLAUDE_SKILLS_DIR, 'borrowed', 'SKILL.md'),
      'utf8',
    );
    expect(text).toContain('name: borrowed');
  });

  it('is empty when there are no skills, so nothing is claimed that is not there', async () => {
    expect(await syncSkillsIntoProject(project)).toEqual([]);
  });
});

describe('what every agent is told', () => {
  it('names the folder, so an agent with no skills protocol can still go and read it', () => {
    // The open-ended half. Neither native path exists for a registered CLI or
    // anything else a person runs here, and every one of them can read a file.
    const facts = hearthFactsPrompt({ probeCli: false, skills: true });
    expect(facts).toContain(SKILLS_PROMPT_DIR);
    expect(facts).toMatch(/SKILL\.md/);
  });

  it('says the folder name means nothing about who the skills are for', () => {
    // The path is `.claude/skills` only because the Agent SDK cannot be
    // pointed anywhere else. Left unsaid, the name reinstates in the prompt
    // exactly the misreading the badge caused in the list.
    expect(hearthFactsPrompt({ probeCli: false, skills: true })).toMatch(/means nothing about who it is for/);
  });

  it('says nothing at all when no skill was mirrored', () => {
    // Same rule the probe paragraph follows: never spend the person's tokens
    // pointing an agent at something that is not there.
    const facts = hearthFactsPrompt({ probeCli: false, skills: false });
    expect(facts).not.toContain(SKILLS_PROMPT_DIR);
    expect(facts.toLowerCase()).not.toContain('skill');
  });

  it('points at the folder the mirror actually writes', () => {
    // Two modules name this path: skills.ts creates it, agentFacts.ts tells the
    // agent about it. They are written separately on purpose (agentFacts is a
    // leaf) so nothing but this stops them drifting apart, and a prompt naming
    // a folder that does not exist is worse than saying nothing.
    expect(SKILLS_PROMPT_DIR.replace(/\/$/, '')).toBe(CLAUDE_SKILLS_DIR.split(path.sep).join('/'));
  });
});
