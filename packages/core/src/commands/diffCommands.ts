import { z } from 'zod';
import { defineCommand } from './types.js';
import { ProjectError, readJson, writeJson, ProjectStore, type ProjectSnapshot } from '../project/store.js';
import { diffSnapshots } from '../diff/diff.js';
import { joinPath } from '../fs.js';
import { BASELINE_FILE, PLAYTESTS_DIR, SCRIPTS_DIR } from '../schema/project.js';
import { generateId, slugify } from '../ids.js';
import { PlaytestSchema, PlaytestStepSchema } from '../schema/project.js';
import { validateProject } from '../validate.js';

async function loadBaseline(ctx: any): Promise<ProjectSnapshot | null> {
  const path = joinPath(ctx.store.root, BASELINE_FILE);
  if (!(await ctx.fs.exists(path))) return null;
  return (await readJson(ctx.fs, path)) as ProjectSnapshot;
}

export const snapshotProject = defineCommand({
  name: 'snapshotProject',
  description:
    'Save the current project state as the diff baseline (.hearth/baseline.json). ' +
    'Run this BEFORE making changes so the human can review your diff afterwards.',
  permission: 'safe-edit',
  mutates: false, // does not change the project model itself
  paramsSchema: z.object({}),
  async run(ctx) {
    const snapshot = await ctx.store.toSnapshot();
    await writeJson(ctx.fs, joinPath(ctx.store.root, BASELINE_FILE), snapshot);
    ctx.changed({ kind: 'file', path: BASELINE_FILE, action: 'modified' });
    return {
      baseline: BASELINE_FILE,
      scenes: Object.keys(snapshot.scenes).length,
      scripts: Object.keys(snapshot.scripts).length,
      assets: snapshot.assets.assets.length,
    };
  },
});

export const diffProject = defineCommand({
  name: 'diffProject',
  description:
    'Structural diff of the current project vs the last snapshot baseline: scenes, entities, components, properties, scripts, assets.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run(ctx) {
    const baseline = await loadBaseline(ctx);
    if (!baseline) {
      throw new ProjectError(
        'No baseline snapshot found. Run snapshotProject first (before making changes), then diff after.',
        'NOT_FOUND',
      );
    }
    const current = await ctx.store.toSnapshot();
    return diffSnapshots(baseline, current);
  },
});

export const revertProject = defineCommand({
  name: 'revertProject',
  description:
    'Restore the project to the last snapshot baseline (undoes all model/script changes since snapshotProject).',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({ confirm: z.boolean().default(false) }),
  async run(ctx, params) {
    if (!params.confirm) {
      throw new ProjectError(
        'revertProject discards all changes since the last snapshot. Pass confirm=true to proceed.',
        'INVALID_INPUT',
      );
    }
    const baseline = await loadBaseline(ctx);
    if (!baseline) throw new ProjectError('No baseline snapshot found.', 'NOT_FOUND');

    // Restore in-memory model.
    ctx.store.project = baseline.project;
    ctx.store.scenes = new Map(Object.entries(baseline.scenes));
    ctx.store.assets = baseline.assets;
    ctx.store.playtests = new Map(Object.entries(baseline.playtests));

    // Restore script files (including removing scripts created after the snapshot).
    const currentScripts = await ctx.store.listScripts();
    for (const path of currentScripts) {
      if (!(path in baseline.scripts)) {
        await ctx.fs.remove(joinPath(ctx.store.root, path));
        ctx.changed({ kind: 'script', path, action: 'deleted' });
      }
    }
    for (const [path, source] of Object.entries(baseline.scripts)) {
      await ctx.fs.writeFile(joinPath(ctx.store.root, path), source);
      ctx.changed({ kind: 'script', path, action: 'modified' });
    }
    ctx.changed({ kind: 'project', id: ctx.store.project.id, action: 'modified' });
    return { reverted: true, baseline: BASELINE_FILE };
  },
});

export const createPlaytest = defineCommand({
  name: 'createPlaytest',
  description:
    'Create a playtest definition: a scripted sequence of waits, input presses, and assertions run headlessly against a scene.',
  permission: 'safe-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    scene: z.string().min(1),
    steps: z.array(PlaytestStepSchema).default([]),
    maxFrames: z.number().int().positive().default(600),
  }),
  async run(ctx, params) {
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    if (ctx.store.getPlaytest(params.name)) {
      throw new ProjectError(`A playtest named "${params.name}" already exists`, 'CONFLICT');
    }
    const playtest = PlaytestSchema.parse({
      formatVersion: 1,
      id: generateId('ptt'),
      name: params.name,
      scene: scene.id,
      steps: params.steps,
      maxFrames: params.maxFrames,
    });
    ctx.store.playtests.set(playtest.id, playtest);
    ctx.changed({
      kind: 'playtest',
      id: playtest.id,
      name: playtest.name,
      path: joinPath(PLAYTESTS_DIR, `${slugify(playtest.name)}.playtest.json`),
      action: 'created',
    });
    ctx.suggest(`runPlaytest ${playtest.name}`);
    return { playtestId: playtest.id, name: playtest.name, sceneId: scene.id, steps: playtest.steps.length };
  },
});

export const listPlaytests = defineCommand({
  name: 'listPlaytests',
  description: 'List all playtest definitions.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run(ctx) {
    return {
      playtests: [...ctx.store.playtests.values()].map((p) => ({
        id: p.id,
        name: p.name,
        scene: p.scene,
        steps: p.steps.length,
        maxFrames: p.maxFrames,
      })),
    };
  },
});

export const runPlaytest = defineCommand({
  name: 'runPlaytest',
  description:
    'Run a playtest headlessly (simulated frames, scripted inputs, assertions). Returns pass/fail with per-step results.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({ playtest: z.string().min(1) }),
  async run(ctx, params) {
    if (!ctx.runtime?.runPlaytest) {
      throw new ProjectError(
        'Playtest runtime not available in this context (runtime hooks not injected).',
        'INVALID_INPUT',
      );
    }
    const pt = ctx.store.getPlaytest(params.playtest);
    if (!pt) throw new ProjectError(`Playtest not found: ${params.playtest}`, 'NOT_FOUND');
    return ctx.runtime.runPlaytest(ctx.store, pt.id);
  },
});

export const runSceneSmoke = defineCommand({
  name: 'runScene',
  description:
    'Run a scene headlessly for N frames and report script/runtime errors (a smoke test without assertions). ' +
    'For the visual preview, use the editor.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    scene: z.string().min(1),
    frames: z.number().int().positive().max(36000).default(120),
  }),
  async run(ctx, params) {
    if (!ctx.runtime?.runSceneSmoke) {
      throw new ProjectError(
        'Scene runtime not available in this context (runtime hooks not injected).',
        'INVALID_INPUT',
      );
    }
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    return ctx.runtime.runSceneSmoke(ctx.store, scene.id, params.frames);
  },
});

export const buildProject = defineCommand({
  name: 'buildProject',
  description:
    'Validate then export the project to build/: a self-contained copy of all project files plus a build manifest. ' +
    '(Standalone web/desktop export is on the roadmap; built projects run via the Hearth editor/runtime.)',
  permission: 'build',
  mutates: false,
  paramsSchema: z.object({
    outDir: z.string().default('build'),
  }),
  async run(ctx, params) {
    if (!isSafeOut(params.outDir)) {
      throw new ProjectError(`Build outDir must be a project-relative path (got: ${params.outDir})`, 'INVALID_INPUT');
    }
    const report = await validateProject(ctx.store);
    if (!report.valid) {
      throw new ProjectError(
        `Cannot build: project has ${report.errors.length} validation error(s). Run validateProject for details.`,
        'SCHEMA_ERROR',
      );
    }
    const outRoot = joinPath(ctx.store.root, params.outDir, slugify(ctx.store.project.name));
    await ctx.fs.mkdir(outRoot);

    const written: string[] = [];
    const copyFile = async (rel: string) => {
      const src = joinPath(ctx.store.root, rel);
      if (!(await ctx.fs.exists(src))) return;
      const dest = joinPath(outRoot, rel);
      await ctx.fs.mkdir(dest.slice(0, dest.lastIndexOf('/')));
      await ctx.fs.copyFile(src, dest);
      written.push(rel);
    };

    await copyFile('hearth.json');
    await copyFile('assets.json');
    for (const ref of ctx.store.project.scenes) await copyFile(ref.path);
    for (const asset of ctx.store.assets.assets) await copyFile(asset.path);
    for (const script of await ctx.store.listScripts()) await copyFile(script);
    const ptDir = joinPath(ctx.store.root, PLAYTESTS_DIR);
    if (await ctx.fs.exists(ptDir)) {
      for (const f of await ctx.fs.readdir(ptDir)) {
        if (f.endsWith('.playtest.json')) await copyFile(joinPath(PLAYTESTS_DIR, f));
      }
    }

    const manifest = {
      builtWith: `hearth ${ctx.store.project.hearthVersion}`,
      project: ctx.store.project.name,
      projectId: ctx.store.project.id,
      initialScene: ctx.store.project.initialScene,
      files: written,
      validation: { errors: 0, warnings: report.warnings.length },
    };
    await writeJson(ctx.fs, joinPath(outRoot, 'build-manifest.json'), manifest);
    ctx.changed({ kind: 'file', path: joinPath(params.outDir, slugify(ctx.store.project.name)), action: 'created' });
    return { outDir: joinPath(params.outDir, slugify(ctx.store.project.name)), files: written.length + 1, manifest };
  },
});

function isSafeOut(p: string): boolean {
  return !p.startsWith('/') && !p.includes('..') && !/^[a-zA-Z]:/.test(p);
}
