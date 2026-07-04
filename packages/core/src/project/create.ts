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
  ProjectFileSchema,
  type ProjectFile,
} from '../schema/project.js';
import { SceneSchema } from '../schema/scene.js';
import { createComponent } from '../schema/components.js';
import { generateAgentsMd, generateClaudeMd, generateAgentConfig } from '../agentFiles.js';
import { writeJson, ProjectError, ProjectStore } from './store.js';

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
  await writeJson(fs, joinPath(root, AGENT_CONFIG_FILE), generateAgentConfig(options.name, projectId));
  files.push(AGENT_CONFIG_FILE);
  await fs.writeFile(
    joinPath(root, '.gitignore'),
    // .hearth-tmp/: scratch dir for tools that need an ephemeral in-project
    // export (hearth screenshot). Cleaned up after every run, but a crash
    // mid-capture can leave residue — keep it out of the user's git status.
    // screenshot.png: `hearth screenshot`'s own default --out — an agent
    // running it without an explicit --out would otherwise litter a
    // throwaway debug capture straight into the project root.
    ['build/', '.hearth/baseline.json', '.hearth-tmp/', 'screenshot.png', '.DS_Store', ''].join('\n'),
  );
  files.push('.gitignore');

  const store = await ProjectStore.load(fs, root);
  return { store, files };
}
