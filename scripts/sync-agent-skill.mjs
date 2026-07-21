#!/usr/bin/env node
/**
 * Sync the canonical coding-agent skills into TypeScript constants that
 * @hearth/core can embed and scaffold into every project's `.claude/skills/`:
 *
 *   - skills/hearth/SKILL.md        → the operating core (session loop, memory,
 *                                     permissions, verification, export) — the
 *                                     entry point that routes to the rest
 *   - skills/hearth-build/SKILL.md  → world structure (scenes, entities,
 *                                     tilemaps, prefabs, state machines, input)
 *   - skills/hearth-code/SKILL.md   → behavior (ctx scripting, modules,
 *                                     pitfalls, iteration)
 *   - skills/hearth-art/SKILL.md    → assets (sourcing, import/slice/animate,
 *                                     pixel discipline, sound)
 *   - skills/hearth-feel/SKILL.md   → polish (juice, game UX, quality bar)
 *   - skills/hearth-design/SKILL.md → design (scope, pacing, endings,
 *                                     completeness)
 *   - skills/hearth-playtest/SKILL.md → bot playtesting (sweeps, policies,
 *                                     objectives, bake-to-regression)
 *
 *   node scripts/sync-agent-skill.mjs
 *
 * The canonical sources are the SKILL.md files; this script only regenerates
 * packages/core/src/agentSkillContent.ts from them. A core test byte-compares
 * the constants against the canonical files and fails CI if they drift, so run
 * this after editing any skill. It is deliberately NOT wired into any build
 * script — the test is the gate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const OUT_PATH = path.join(repoRoot, 'packages', 'core', 'src', 'agentSkillContent.ts');

/** Skill names in scaffold order; the core `hearth` skill first. */
const SKILL_NAMES = ['hearth', 'hearth-build', 'hearth-code', 'hearth-art', 'hearth-feel', 'hearth-design', 'hearth-playtest'];

const skills = SKILL_NAMES.map((name) => {
  const content = readFileSync(path.join(repoRoot, 'skills', name, 'SKILL.md'), 'utf8');
  return { name, file: `.claude/skills/${name}/SKILL.md`, content };
});

const entries = skills
  .map(
    (s) =>
      `  {\n    name: ${JSON.stringify(s.name)},\n    file: ${JSON.stringify(s.file)},\n    content: ${JSON.stringify(s.content)},\n  },`,
  )
  .join('\n');

const module = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * The canonical sources are the skills/<name>/SKILL.md files in the Hearth
 * engine repo. Regenerate this file with: node scripts/sync-agent-skill.mjs
 * A core test byte-compares these constants against the canonical files, so any
 * drift fails CI.
 *
 * @hearth/core embeds these so \`createProject\` / the template scaffolder can
 * write them into each project under \`.claude/skills/\`, making every
 * coding-agent skill travel with the project (repo-scoped install is never
 * required).
 */

export interface AgentSkill {
  /** Skill name (the directory under .claude/skills/). */
  name: string;
  /** Project-relative path the skill is scaffolded to. */
  file: string;
  /** Full SKILL.md contents. */
  content: string;
}

/** Every coding-agent skill scaffolded into a project, core \`hearth\` first. */
export const AGENT_SKILLS: readonly AgentSkill[] = [
${entries}
];
`;

writeFileSync(OUT_PATH, module);
console.log(
  `Wrote ${path.relative(repoRoot, OUT_PATH)} (${skills.map((s) => `${s.name}: ${s.content.length}B`).join(', ')}).`,
);
