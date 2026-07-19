/**
 * New-project creation: writes a minimal-but-complete Hearth project with a
 * starter scene, default input mappings, and agent integration files.
 */
import type { FsLike } from '../fs.js';
import { joinPath } from '../fs.js';
import { generateId, slugify } from '../ids.js';
import {
  HEARTH_VERSION,
  PROJECT_FILE,
  ASSET_INDEX_FILE,
  SCENES_DIR,
  SCRIPTS_DIR,
  ASSETS_DIR,
  PLAYTESTS_DIR,
  HEARTH_DIR,
  AGENT_CONFIG_FILE,
  MEMORY_FILE,
  ProjectFileSchema,
  type ProjectFile,
} from '../schema/project.js';
import { SceneSchema } from '../schema/scene.js';
import { createComponent } from '../schema/components.js';
import { generateAgentsMd, generateClaudeMd, generateAgentConfig } from '../agentFiles.js';
import {
  AGENT_SKILLS,
} from '../agentSkillContent.js';
import { writeJson, ProjectError, ProjectStore } from './store.js';
import { writeDigest } from './digest.js';
import { MEMORY_TEMPLATE } from './memory.js';

export interface CreateProjectOptions {
  name: string;
  description?: string;
  /** Create a starter scene with camera + ground + player placeholder (default true). */
  starterScene?: boolean;
  width?: number;
  height?: number;
}

export const DEFAULT_INPUT_ACTIONS: Record<string, string[]> = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  jump: ['Space'],
  action: ['KeyE', 'Enter'],
};

/**
 * The standard `.gitignore` written into every new Hearth project — the single
 * source of truth for it, shared by `createProject` (blank projects) and the
 * template scaffolder in `@hearth/templates` (which regenerates it fresh rather
 * than copying the template's own copy).
 *
 * .hearth-tmp/: scratch dir for tools that need an ephemeral in-project export
 * (hearth screenshot). Cleaned up after every run, but a crash mid-capture can
 * leave residue — keep it out of the user's git status. screenshot.png:
 * `hearth screenshot`'s own default --out — an agent running it without an
 * explicit --out would otherwise litter a throwaway debug capture straight into
 * the project root.
 */
export const PROJECT_GITIGNORE = [
  'build/',
  '.hearth/baseline.json',
  '.hearth/history/',
  '.hearth/log/',
  // digest.md is engine-derived state, regenerated after every change — cache,
  // not source. memory.md (agent decisions/todos/gotchas) is authored intent and
  // is intentionally NOT ignored: it should be committed and travel with the repo.
  '.hearth/digest.md',
  '.hearth-tmp/',
  'screenshot.png',
  // The editor auto-provisions .mcp.json with machine-absolute paths (rewritten
  // on each open), so it is per-machine and must not be committed.
  '.mcp.json',
  '.DS_Store',
  '',
].join('\n');

export async function createProject(
  fs: FsLike,
  root: string,
  options: CreateProjectOptions,
): Promise<{ store: ProjectStore; files: string[] }> {
  if (await fs.exists(joinPath(root, PROJECT_FILE))) {
    throw new ProjectError(`A Hearth project already exists at ${root}`, 'CONFLICT');
  }
  const files: string[] = [];
  const projectId = generateId('prj');

  for (const dir of [SCENES_DIR, SCRIPTS_DIR, ASSETS_DIR, PLAYTESTS_DIR, HEARTH_DIR]) {
    await fs.mkdir(joinPath(root, dir));
  }

  const project: ProjectFile = ProjectFileSchema.parse({
    formatVersion: 1,
    hearthVersion: HEARTH_VERSION,
    id: projectId,
    name: options.name,
    description: options.description ?? '',
    initialScene: null,
    scenes: [],
    inputMappings: { actions: { ...DEFAULT_INPUT_ACTIONS } },
    buildSettings: {
      width: options.width ?? 800,
      height: options.height ?? 600,
      title: options.name,
    },
  });

  if (options.starterScene !== false) {
    const sceneId = generateId('scn');
    const scenePath = joinPath(SCENES_DIR, 'main.scene.json');
    const scene = SceneSchema.parse({
      formatVersion: 1,
      id: sceneId,
      name: 'Main',
      entities: [
        {
          id: generateId('ent'),
          name: 'Main Camera',
          parentId: null,
          enabled: true,
          tags: [],
          components: {
            Transform: createComponent('Transform', { position: { x: 400, y: 300 } }),
            Camera: createComponent('Camera'),
          },
        },
        {
          id: generateId('ent'),
          name: 'Ground',
          parentId: null,
          enabled: true,
          tags: ['ground'],
          components: {
            Transform: createComponent('Transform', { position: { x: 400, y: 550 } }),
            SpriteRenderer: createComponent('SpriteRenderer', {
              shape: 'rectangle',
              color: '#2ecc71',
              width: 800,
              height: 64,
            }),
            Collider: createComponent('Collider', { shape: 'box', width: 800, height: 64 }),
            PhysicsBody: createComponent('PhysicsBody', { bodyType: 'static' }),
          },
        },
        {
          id: generateId('ent'),
          name: 'Player',
          parentId: null,
          enabled: true,
          tags: ['player'],
          components: {
            Transform: createComponent('Transform', { position: { x: 400, y: 480 } }),
            SpriteRenderer: createComponent('SpriteRenderer', {
              shape: 'rectangle',
              color: '#3498db',
              width: 32,
              height: 48,
            }),
            Collider: createComponent('Collider', { shape: 'box', width: 32, height: 48 }),
            PhysicsBody: createComponent('PhysicsBody', { bodyType: 'dynamic' }),
          },
        },
      ],
    });
    await writeJson(fs, joinPath(root, scenePath), scene);
    files.push(scenePath);
    project.scenes.push({ id: sceneId, name: 'Main', path: scenePath });
    project.initialScene = sceneId;
  }

  await writeJson(fs, joinPath(root, PROJECT_FILE), project);
  files.push(PROJECT_FILE);
  await writeJson(fs, joinPath(root, ASSET_INDEX_FILE), { formatVersion: 1, assets: [] });
  files.push(ASSET_INDEX_FILE);

  await fs.writeFile(joinPath(root, 'AGENTS.md'), generateAgentsMd(options.name));
  files.push('AGENTS.md');
  await fs.writeFile(joinPath(root, 'CLAUDE.md'), generateClaudeMd(options.name));
  files.push('CLAUDE.md');
  // The coding-agent skills travel with the project so Claude Code (and any
  // agent that reads project-local skills) gets them without a repo-scoped
  // install. Content is embedded from the canonical skills/*/SKILL.md files:
  // `hearth` is the operating core (and routes to the rest), `hearth-build`
  // structures the world, `hearth-code` writes behavior, `hearth-art` sources
  // and uses assets, `hearth-feel` polishes and judges done-ness.
  for (const skill of AGENT_SKILLS) {
    await fs.writeFile(joinPath(root, skill.file), skill.content);
    files.push(skill.file);
  }
  await writeJson(fs, joinPath(root, AGENT_CONFIG_FILE), generateAgentConfig(options.name, projectId));
  files.push(AGENT_CONFIG_FILE);
  await fs.writeFile(joinPath(root, '.gitignore'), PROJECT_GITIGNORE);
  files.push('.gitignore');
  // Seed the durable agent-memory file so it exists (and is committed) from the
  // start; the agent appends to it via `hearth remember`.
  await fs.writeFile(joinPath(root, MEMORY_FILE), MEMORY_TEMPLATE);
  files.push(MEMORY_FILE);

  const store = await ProjectStore.load(fs, root);
  // Write the initial state digest so a first agent session has a snapshot to
  // read before making any change. Best-effort — never blocks project creation.
  await writeDigest(fs, root, store);
  return { store, files };
}
