#!/usr/bin/env node
/**
 * Sync the canonical best-practices skill (skills/hearth/SKILL.md) into a
 * TypeScript constant that @hearth/core can embed and scaffold into every
 * project's `.claude/skills/hearth/SKILL.md`.
 *
 *   node scripts/sync-agent-skill.mjs
 *
 * The canonical source is skills/hearth/SKILL.md; this script only regenerates
 * packages/core/src/agentSkillContent.ts from it. A core test byte-compares the
 * two and fails CI if they drift, so run this after editing the skill. It is
 * deliberately NOT wired into any build script — the test is the gate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const SKILL_PATH = path.join(repoRoot, 'skills', 'hearth', 'SKILL.md');
const OUT_PATH = path.join(repoRoot, 'packages', 'core', 'src', 'agentSkillContent.ts');

const content = readFileSync(SKILL_PATH, 'utf8');

const module = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * The canonical source is skills/hearth/SKILL.md in the Hearth engine repo.
 * Regenerate this file with: node scripts/sync-agent-skill.mjs
 * A core test byte-compares this constant against the canonical file, so any
 * drift fails CI.
 *
 * @hearth/core embeds this so \`createProject\` / the template scaffolder / the
 * editor's agent-prepare route can write it into each project at
 * \`.claude/skills/hearth/SKILL.md\`, making the best-practices skill travel
 * with the project (repo-scoped install is no longer required).
 */

/** The full contents of the canonical best-practices skill. */
export const AGENT_SKILL_CONTENT = ${JSON.stringify(content)};

/** Project-relative path the skill is scaffolded to. */
export const AGENT_SKILL_FILE = '.claude/skills/hearth/SKILL.md';
`;

writeFileSync(OUT_PATH, module);
console.log(`Wrote ${path.relative(repoRoot, OUT_PATH)} (${content.length} bytes of skill content).`);
