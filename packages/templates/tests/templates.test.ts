import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ProjectStore,
  validateProject,
  ProjectFileSchema,
  SceneSchema,
  HEARTH_VERSION,
} from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { runPlaytest } from '@hearth/playtest';
import { listTemplates, getTemplatePath, applyTemplate, type TemplateName } from '../src/index.js';

const NAMES: TemplateName[] = ['platformer', 'topdown', 'arcade'];

function loadStore(dir: string) {
  return ProjectStore.load(new NodeFileSystem(), dir);
}

describe('templates package API', () => {
  it('listTemplates returns the three genre templates with descriptions', () => {
    const templates = listTemplates();
    expect(templates.map((t) => t.name)).toEqual(NAMES);
    for (const t of templates) {
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it('getTemplatePath resolves each template to an existing directory', () => {
    for (const name of NAMES) {
      const dir = getTemplatePath(name);
      expect(path.basename(dir)).toBe(name);
    }
  });

  it('getTemplatePath prefers $HEARTH_TOOLS_DIR when set', () => {
    const prev = process.env.HEARTH_TOOLS_DIR;
    process.env.HEARTH_TOOLS_DIR = '/nonexistent-tools-dir';
    try {
      // The tools-dir candidate does not exist, so resolution falls through
      // to the package-relative copy — proving the tools-dir path is tried
      // first without breaking the fallback.
      const dir = getTemplatePath('platformer');
      expect(path.basename(dir)).toBe('platformer');
    } finally {
      if (prev === undefined) delete process.env.HEARTH_TOOLS_DIR;
      else process.env.HEARTH_TOOLS_DIR = prev;
    }
  });

  it('getTemplatePath throws for an unknown template', () => {
    expect(() => getTemplatePath('does-not-exist')).toThrow(/not found/);
  });
});

describe('genre templates', () => {
  for (const name of NAMES) {
    describe(name, () => {
      it('parses under ProjectFileSchema and every scene under SceneSchema', async () => {
        const dir = getTemplatePath(name);
        const projectRaw = JSON.parse(await readFile(path.join(dir, 'hearth.json'), 'utf8'));
        const parsed = ProjectFileSchema.safeParse(projectRaw);
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;

        for (const entry of parsed.data.scenes) {
          const sceneRaw = JSON.parse(await readFile(path.join(dir, entry.path), 'utf8'));
          expect(SceneSchema.safeParse(sceneRaw).success).toBe(true);
        }
      });

      it('embeds the current HEARTH_VERSION', async () => {
        const store = await loadStore(getTemplatePath(name));
        expect(store.project.hearthVersion).toBe(HEARTH_VERSION);
      });

      it('validates clean through core validateProject', async () => {
        const store = await loadStore(getTemplatePath(name));
        expect(store.project.initialScene).toBeTruthy();
        expect(store.scenes.size).toBeGreaterThan(0);
        const report = await validateProject(store);
        expect(report.errors).toEqual([]);
      });

      it('is a small skeleton (<= 12 authored entities)', async () => {
        const store = await loadStore(getTemplatePath(name));
        const total = [...store.scenes.values()].reduce((n, s) => n + s.entities.length, 0);
        expect(total).toBeLessThanOrEqual(12);
      });

      it('is scripted in Lua', async () => {
        const store = await loadStore(getTemplatePath(name));
        const scripts = await store.listScripts();
        expect(scripts.length).toBeGreaterThan(0);
        expect(scripts.every((p) => p.endsWith('.lua'))).toBe(true);
      });

      it('the smoke playtest moves the player under injected input', async () => {
        const store = await loadStore(getTemplatePath(name));
        const result = await runPlaytest(store, 'smoke');
        expect(result.passed).toBe(true);
      });
    });
  }
});

describe('applyTemplate', () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
  });

  it('copies a template and rewrites id/name/description into a fresh project', async () => {
    const fs = new NodeFileSystem();
    const src = getTemplatePath('platformer');
    const target = await mkdtemp(path.join(os.tmpdir(), 'hearth-tpl-apply-'));
    cleanups.push(target);

    const templateProject = JSON.parse(await readFile(path.join(src, 'hearth.json'), 'utf8'));

    const result = await applyTemplate(fs, src, target, {
      name: 'My Game',
      description: 'A game of my own',
    });

    // Reports the copied files, including the project file and a script.
    expect(result.files).toContain('hearth.json');
    expect(result.files.some((f) => f.startsWith('scripts/'))).toBe(true);

    const applied = JSON.parse(await readFile(path.join(target, 'hearth.json'), 'utf8'));
    expect(applied.name).toBe('My Game');
    expect(applied.description).toBe('A game of my own');
    expect(applied.id).toMatch(/^prj_/);
    expect(applied.id).not.toBe(templateProject.id);
    // The exported game's window title follows the new project name, not the
    // template's ("Platformer Starter").
    expect(applied.buildSettings.title).toBe('My Game');
    expect(applied.buildSettings.title).not.toBe(templateProject.buildSettings.title);

    // The scaffolded project still loads and validates clean.
    const store = await loadStore(target);
    const report = await validateProject(store);
    expect(report.errors).toEqual([]);
  });

  it('produces a distinct project id on each application', async () => {
    const fs = new NodeFileSystem();
    const src = getTemplatePath('topdown');
    const a = await mkdtemp(path.join(os.tmpdir(), 'hearth-tpl-apply-'));
    const b = await mkdtemp(path.join(os.tmpdir(), 'hearth-tpl-apply-'));
    cleanups.push(a, b);

    await applyTemplate(fs, src, a, { name: 'A' });
    await applyTemplate(fs, src, b, { name: 'B' });

    const idA = JSON.parse(await readFile(path.join(a, 'hearth.json'), 'utf8')).id;
    const idB = JSON.parse(await readFile(path.join(b, 'hearth.json'), 'utf8')).id;
    expect(idA).not.toBe(idB);
  });

  it('does not copy authoring state: .hearth/history, .hearth/log, build/, or .gitignore', async () => {
    const fs = new NodeFileSystem();

    // Build a fake "template" that looks like a checked-out template dir does
    // after being edited in the editor: real project content, plus the
    // authoring history/log/build artifacts that accumulate from use.
    const src = await mkdtemp(path.join(os.tmpdir(), 'hearth-tpl-src-'));
    cleanups.push(src);
    await writeFile(
      path.join(src, 'hearth.json'),
      JSON.stringify({
        formatVersion: 1,
        hearthVersion: HEARTH_VERSION,
        id: 'prj_fakesrc0',
        name: 'Fake',
        description: '',
        initialScene: null,
        scenes: [],
        inputMappings: { actions: {} },
        buildSettings: { width: 800, height: 600, title: 'Fake' },
      }),
    );
    await mkdir(path.join(src, '.hearth', 'history'), { recursive: true });
    await writeFile(path.join(src, '.hearth', 'history', 'index.json'), '{}');
    await writeFile(path.join(src, '.hearth', 'history', 'state-1.json'), '{}');
    await mkdir(path.join(src, '.hearth', 'log'), { recursive: true });
    await writeFile(path.join(src, '.hearth', 'log', 'commands.jsonl'), '{}\n');
    await writeFile(path.join(src, '.hearth', 'baseline.json'), '{}');
    await writeFile(path.join(src, '.hearth', 'agent-config.json'), '{}');
    await mkdir(path.join(src, 'build'), { recursive: true });
    await writeFile(path.join(src, 'build', 'game.js'), '// built output');
    await writeFile(path.join(src, '.gitignore'), 'build/\n');

    const target = await mkdtemp(path.join(os.tmpdir(), 'hearth-tpl-apply-'));
    cleanups.push(target);

    const result = await applyTemplate(fs, src, target, { name: 'My Game' });

    // The returned files list excludes every authoring-state path.
    for (const f of result.files) {
      expect(f.startsWith('.hearth/history/')).toBe(false);
      expect(f.startsWith('.hearth/log/')).toBe(false);
      expect(f).not.toBe('.hearth/baseline.json');
      expect(f.startsWith('build/')).toBe(false);
      expect(path.basename(f)).not.toBe('.gitignore');
    }
    expect(result.files).toContain('hearth.json');
    // The engine-expected part of .hearth/ (agent-config.json) is preserved.
    expect(result.files).toContain('.hearth/agent-config.json');

    // The target directory itself has none of these paths on disk.
    await expect(readFile(path.join(target, '.hearth', 'history', 'index.json'))).rejects.toThrow();
    await expect(readFile(path.join(target, '.hearth', 'log', 'commands.jsonl'))).rejects.toThrow();
    await expect(readFile(path.join(target, '.hearth', 'baseline.json'))).rejects.toThrow();
    await expect(readFile(path.join(target, 'build', 'game.js'))).rejects.toThrow();
    await expect(readFile(path.join(target, '.gitignore'))).rejects.toThrow();
  });
});
