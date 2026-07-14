/**
 * The embedded best-practices skill constant (packages/core/src/agentSkillContent.ts)
 * is generated from the canonical skills/hearth/SKILL.md by
 * `node scripts/sync-agent-skill.mjs`. This test is the drift gate: it fails CI
 * whenever the two get out of sync, telling you to re-run the sync script. The
 * sync is deliberately NOT wired into the build — this test is the only gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SKILL_CONTENT, AGENT_SKILL_FILE } from '@hearth/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills', 'hearth', 'SKILL.md');

describe('embedded agent skill', () => {
  it('byte-matches the canonical skills/hearth/SKILL.md', () => {
    const canonical = readFileSync(SKILL_PATH, 'utf8');
    expect(
      AGENT_SKILL_CONTENT,
      'Embedded skill has drifted from skills/hearth/SKILL.md — run node scripts/sync-agent-skill.mjs',
    ).toBe(canonical);
  });

  it('scaffolds to the project-local .claude path', () => {
    expect(AGENT_SKILL_FILE).toBe('.claude/skills/hearth/SKILL.md');
  });
});
