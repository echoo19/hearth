/**
 * The embedded coding-agent skills (packages/core/src/agentSkillContent.ts)
 * are generated from the canonical skills/<name>/SKILL.md files by
 * `node scripts/sync-agent-skill.mjs`. This test is the drift gate: it fails CI
 * whenever any skill gets out of sync, telling you to re-run the sync script.
 * The sync is deliberately NOT wired into the build — this test is the only gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SKILLS } from '@hearth/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** The canonical seven-skill set, core `hearth` first — the split is deliberate. */
const EXPECTED_NAMES = ['hearth', 'hearth-build', 'hearth-code', 'hearth-art', 'hearth-feel', 'hearth-design', 'hearth-playtest'];

describe('embedded agent skills', () => {
  it('embeds exactly the canonical skill set, core first', () => {
    expect(AGENT_SKILLS.map((s) => s.name)).toEqual(EXPECTED_NAMES);
  });

  for (const name of EXPECTED_NAMES) {
    it(`${name}: byte-matches skills/${name}/SKILL.md and scaffolds to .claude/skills/`, () => {
      const skill = AGENT_SKILLS.find((s) => s.name === name)!;
      const canonical = readFileSync(path.join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
      expect(
        skill.content,
        `Embedded ${name} skill has drifted from skills/${name}/SKILL.md — run node scripts/sync-agent-skill.mjs`,
      ).toBe(canonical);
      expect(skill.file).toBe(`.claude/skills/${name}/SKILL.md`);
    });
  }

  it('every skill has frontmatter with its own name and a description', () => {
    for (const skill of AGENT_SKILLS) {
      expect(skill.content.startsWith('---\n'), `${skill.name} missing frontmatter`).toBe(true);
      expect(skill.content).toContain(`name: ${skill.name}\n`);
      expect(skill.content).toMatch(/description: .{40,}/);
    }
  });

  it('the core skill routes to every domain skill by name', () => {
    const core = AGENT_SKILLS[0].content;
    for (const name of EXPECTED_NAMES.slice(1)) {
      expect(core, `core skill does not mention ${name}`).toContain(name);
    }
  });
});
