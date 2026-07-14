/**
 * Tests for `scaffoldFromTemplate` — the shared helper that both `hearth init`
 * and the editor's create-project route use to turn a genre template into a
 * clean, personalized project: template content (project.json / scenes /
 * scripts / assets) is preserved, while the agent-config, AGENTS.md, CLAUDE.md,
 * and .gitignore are regenerated fresh for the new name and id.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore, validateProject, AGENT_SKILL_CONTENT, AGENT_SKILL_FILE } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { getTemplatePath, scaffoldFromTemplate, type TemplateName } from '../src/index.js';

const NAMES: TemplateName[] = ['platformer', 'topdown', 'arcade'];

function loadStore(dir: string) {
  return ProjectStore.load(new NodeFileSystem(), dir);
}

describe('scaffoldFromTemplate', () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
  });

  for (const name of NAMES) {
    it(`scaffolds "${name}" into a clean, validating project with fresh metadata`, async () => {
      const fs = new NodeFileSystem();
      const src = getTemplatePath(name);
      const target = await mkdtemp(path.join(os.tmpdir(), 'hearth-scaffold-'));
      cleanups.push(target);

      const templateProject = JSON.parse(await readFile(path.join(src, 'hearth.json'), 'utf8'));
      const templateAgentConfig = JSON.parse(
        await readFile(path.join(src, '.hearth', 'agent-config.json'), 'utf8'),
      );

      const { files } = await scaffoldFromTemplate(fs, src, target, {
        name: 'My Fresh Game',
        description: 'scaffolded from a template',
      });

      // Project metadata comes fresh, not from the template.
      const applied = JSON.parse(await readFile(path.join(target, 'hearth.json'), 'utf8'));
      expect(applied.name).toBe('My Fresh Game');
      expect(applied.description).toBe('scaffolded from a template');
      expect(applied.id).toMatch(/^prj_/);
      expect(applied.id).not.toBe(templateProject.id);
      // buildSettings.title (the exported game's window title) follows the new
      // name, not the template's.
      expect(applied.buildSettings.title).toBe('My Fresh Game');
      expect(applied.buildSettings.title).not.toBe(templateProject.buildSettings.title);

      // agent-config is regenerated: fresh name + id (matching hearth.json),
      // never the template's stale values.
      const agentConfig = JSON.parse(
        await readFile(path.join(target, '.hearth', 'agent-config.json'), 'utf8'),
      );
      expect(agentConfig.project).toBe('My Fresh Game');
      expect(agentConfig.projectId).toBe(applied.id);
      expect(agentConfig.projectId).not.toBe(templateAgentConfig.projectId);

      // AGENTS.md / CLAUDE.md carry the new name, not the template's.
      const agentsMd = await readFile(path.join(target, 'AGENTS.md'), 'utf8');
      const claudeMd = await readFile(path.join(target, 'CLAUDE.md'), 'utf8');
      expect(agentsMd).toContain('My Fresh Game');
      expect(agentsMd).not.toContain(templateProject.name);
      expect(claudeMd).toContain('My Fresh Game');
      expect(claudeMd).not.toContain(templateProject.name);

      // A standard .gitignore is written (applyTemplate skips it deliberately).
      const gitignore = await readFile(path.join(target, '.gitignore'), 'utf8');
      expect(gitignore).toContain('build/');
      expect(gitignore).toContain('.hearth/log/');
      expect(files).toContain('.gitignore');
      expect(files).toContain('.hearth/agent-config.json');

      // The project-local best-practices skill is written from core's embedded
      // canonical copy, so the scaffolded project carries it.
      expect(files).toContain(AGENT_SKILL_FILE);
      expect(await readFile(path.join(target, AGENT_SKILL_FILE), 'utf8')).toBe(AGENT_SKILL_CONTENT);

      // Template gameplay content is preserved: scene(s) and Lua script(s).
      expect(files.some((f) => f.startsWith('scripts/') && f.endsWith('.lua'))).toBe(true);
      expect(files.some((f) => f.startsWith('scenes/'))).toBe(true);

      // No authoring history leaks in.
      await expect(access(path.join(target, '.hearth', 'history'))).rejects.toThrow();
      await expect(access(path.join(target, '.hearth', 'log'))).rejects.toThrow();

      // The scaffolded project loads and validates clean.
      const store = await loadStore(target);
      const report = await validateProject(store);
      expect(report.errors).toEqual([]);
    });
  }

  it('produces a distinct project id (and matching agent-config id) per scaffold', async () => {
    const fs = new NodeFileSystem();
    const src = getTemplatePath('topdown');
    const a = await mkdtemp(path.join(os.tmpdir(), 'hearth-scaffold-'));
    const b = await mkdtemp(path.join(os.tmpdir(), 'hearth-scaffold-'));
    cleanups.push(a, b);

    await scaffoldFromTemplate(fs, src, a, { name: 'A' });
    await scaffoldFromTemplate(fs, src, b, { name: 'B' });

    const projA = JSON.parse(await readFile(path.join(a, 'hearth.json'), 'utf8'));
    const projB = JSON.parse(await readFile(path.join(b, 'hearth.json'), 'utf8'));
    const cfgA = JSON.parse(await readFile(path.join(a, '.hearth', 'agent-config.json'), 'utf8'));
    const cfgB = JSON.parse(await readFile(path.join(b, '.hearth', 'agent-config.json'), 'utf8'));

    expect(projA.id).not.toBe(projB.id);
    expect(cfgA.projectId).toBe(projA.id);
    expect(cfgB.projectId).toBe(projB.id);
  });
});
