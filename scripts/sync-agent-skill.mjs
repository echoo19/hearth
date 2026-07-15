#!/usr/bin/env node
/**
 * Sync the two canonical coding-agent skills into TypeScript constants that
 * @hearth/core can embed and scaffold into every project's `.claude/skills/`:
 *
 *   - skills/hearth/SKILL.md        → operating the engine (best practices)
 *   - skills/hearth-craft/SKILL.md  → making the game good (game feel, UX,
 *                                     asset sourcing, quality bar)
 *
 *   node scripts/sync-agent-skill.mjs
 *
 * The canonical sources are the SKILL.md files; this script only regenerates
 * packages/core/src/agentSkillContent.ts from them. A core test byte-compares
 * the constants against the canonical files and fails CI if they drift, so run
 * this after editing either skill. It is deliberately NOT wired into any build
 * script — the test is the gate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const SKILL_PATH = path.join(repoRoot, 'skills', 'hearth', 'SKILL.md');
const CRAFT_SKILL_PATH = path.join(repoRoot, 'skills', 'hearth-craft', 'SKILL.md');
const OUT_PATH = path.join(repoRoot, 'packages', 'core', 'src', 'agentSkillContent.ts');

const content = readFileSync(SKILL_PATH, 'utf8');
const craftContent = readFileSync(CRAFT_SKILL_PATH, 'utf8');

const module = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * The canonical sources are skills/hearth/SKILL.md and
 * skills/hearth-craft/SKILL.md in the Hearth engine repo.
 * Regenerate this file with: node scripts/sync-agent-skill.mjs
 * A core test byte-compares these constants against the canonical files, so any
 * drift fails CI.
 *
 * @hearth/core embeds these so \`createProject\` / the template scaffolder / the
 * editor's agent-prepare route can write them into each project under
 * \`.claude/skills/\`, making both coding-agent skills travel with the project
 * (repo-scoped install is no longer required).
 */

/** The full contents of the canonical best-practices skill (operating Hearth). */
export const AGENT_SKILL_CONTENT = ${JSON.stringify(content)};

/** Project-relative path the best-practices skill is scaffolded to. */
export const AGENT_SKILL_FILE = '.claude/skills/hearth/SKILL.md';

/** The full contents of the canonical game-craft skill (making a game good). */
export const AGENT_CRAFT_SKILL_CONTENT = ${JSON.stringify(craftContent)};

/** Project-relative path the game-craft skill is scaffolded to. */
export const AGENT_CRAFT_SKILL_FILE = '.claude/skills/hearth-craft/SKILL.md';
`;

writeFileSync(OUT_PATH, module);
console.log(
  `Wrote ${path.relative(repoRoot, OUT_PATH)} (${content.length} + ${craftContent.length} bytes of skill content).`,
);
