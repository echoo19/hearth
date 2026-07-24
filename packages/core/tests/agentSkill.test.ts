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
import { AGENT_SKILLS, generateAgentsMd, generateClaudeMd } from '@hearth/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** The canonical seven-skill set, core `hearth` first — the split is deliberate. */
const EXPECTED_NAMES = ['hearth', 'hearth-build', 'hearth-code', 'hearth-art', 'hearth-feel', 'hearth-design', 'hearth-playtest'];

function skillContent(name: string): string {
  return AGENT_SKILLS.find((skill) => skill.name === name)!.content;
}

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

  describe('asset-pack guidance', () => {
    it('inspects an unfamiliar local pack before importing it', () => {
      const art = skillContent('hearth-art');
      expect(art).toContain('hearth inspect asset-pack');
      expect(art).toContain('inspect_asset_pack');
      expect(art).toMatch(/inspect(?:ion| the pack)? before import/i);
    });

    it('preserves provenance and unchanged vendor files for online packs', () => {
      const art = skillContent('hearth-art');
      expect(art).toMatch(/source URL/i);
      expect(art).toMatch(/\bauthor\b/i);
      expect(art).toMatch(/\blicen[cs]e\b/i);
      expect(art).toMatch(/(?:preserve|keep)[\s\S]{0,120}(?:unchanged|unmodified)[\s\S]{0,120}vendor/i);
    });

    it('uses authored Tiled evidence instead of guessing tile adjacency', () => {
      const art = skillContent('hearth-art');
      expect(art).toMatch(/authored[\s\S]{0,120}(?:sample|example)[\s\S]{0,120}(?:TMX|Tiled)/i);
      expect(art).toMatch(/(?:TMX|TSX|Tiled)[\s\S]{0,120}metadata/i);
      expect(art).toMatch(/(?:do not|don't|never)[\s\S]{0,120}guess[\s\S]{0,120}(?:adjacency|neighbou?r)/i);
    });

    it('separates engine facts from vision and requires a visual proving ground', () => {
      const art = skillContent('hearth-art');
      expect(art).toMatch(/engine facts?[\s\S]{0,160}vision/i);
      for (const level of ['exact', 'corroborated', 'inferred', 'unknown']) {
        expect(art, `hearth-art does not define the ${level} evidence level`).toMatch(
          new RegExp(`\\b${level}\\b`, 'i'),
        );
      }
      expect(art).toMatch(/visual review/i);
      expect(art).toMatch(/proving ground/i);
    });

    it('chooses an asset representation from the supported rendering primitives', () => {
      const build = skillContent('hearth-build');
      for (const primitive of [
        'whole asset',
        'fixed frame',
        'animation',
        'genuine blob47',
        'authored layers',
        'bottom-aligned',
      ]) {
        expect(build, `hearth-build does not explain when to use ${primitive}`).toMatch(
          new RegExp(primitive, 'i'),
        );
      }
      expect(build).toMatch(/oversized sprite/i);
    });

    it('never invents blob47 connectivity from unrelated atlas tiles', () => {
      const build = skillContent('hearth-build');
      expect(build).toMatch(
        /(?:never|do not|don't)[\s\S]{0,100}(?:synthesi[sz]e|compose|invent)[\s\S]{0,100}blob47[\s\S]{0,100}unrelated/i,
      );
    });

    it('explicitly rejects unsupported isometric and depth workflows', () => {
      const build = skillContent('hearth-build');
      expect(build).toMatch(/isometric[\s\S]{0,120}unsupported/i);
      expect(build).toMatch(/depth[\s\S]{0,120}(?:unsupported|not supported)/i);
      expect(build).toMatch(/(?:reject|stop|do not proceed|don't proceed)/i);
    });

    it('routes unfamiliar packs through art before import and build before placement', () => {
      for (const [name, guide] of [
        ['AGENTS.md', generateAgentsMd('Asset Pack Test')],
        ['CLAUDE.md', generateClaudeMd('Asset Pack Test')],
      ] as const) {
        expect(guide, `${name} does not route unfamiliar packs to hearth-art before import`).toMatch(
          /unfamiliar[\s\S]{0,100}pack[\s\S]{0,100}hearth-art[\s\S]{0,100}before import/i,
        );
        expect(guide, `${name} does not route pack placement to hearth-build`).toMatch(
          /hearth-build[\s\S]{0,100}before placement/i,
        );
      }
    });
  });
});
