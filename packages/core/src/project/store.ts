/**
 * ProjectStore: the single in-memory representation of an open Hearth
 * project. Editor, CLI, and MCP server all mutate projects exclusively
 * through commands operating on this store, then persist with `save()`.
 */
import {
  ProjectFileSchema,
  AssetIndexSchema,
  PlaytestSchema,
  type ProjectFile,
  type AssetIndex,
  type Asset,
  type Playtest,
  type SceneRef,
  PROJECT_FILE,
  ASSET_INDEX_FILE,
  PLAYTESTS_DIR,
} from '../schema/project.js';
import { SceneSchema, type Scene } from '../schema/scene.js';
import { joinPath, type FsLike } from '../fs.js';

export interface ProjectSnapshot {
  project: ProjectFile;
  scenes: Record<string, Scene>; // keyed by scene id
  assets: AssetIndex;
  /** Script path -> file contents. */
  scripts: Record<string, string>;
  playtests: Record<string, Playtest>; // keyed by playtest id
}

export class ProjectError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'PARSE_ERROR'
      | 'SCHEMA_ERROR'
      | 'CONFLICT'
      | 'MISSING_RESOURCE'
      | 'INVALID_INPUT' = 'INVALID_INPUT',
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

export class ProjectStore {
  project: ProjectFile;
  scenes = new Map<string, Scene>();
  assets: AssetIndex;
  playtests = new Map<string, Playtest>();
  /** Files (project-relative) modified since last save. */
  private dirty = new Set<string>();

  constructor(
    public readonly root: string,
    public readonly fs: FsLike,
    project: ProjectFile,
    assets: AssetIndex,
  ) {
    this.project = project;
    this.assets = assets;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  static async load(fs: FsLike, root: string): Promise<ProjectStore> {
    const projectPath = joinPath(root, PROJECT_FILE);
    if (!(await fs.exists(projectPath))) {
      throw new ProjectError(
        `No Hearth project found at ${root} (missing ${PROJECT_FILE})`,
        'NOT_FOUND',
      );
    }
    const project = ProjectFileSchema.parse(await readJson(fs, projectPath));

    let assets: AssetIndex = { formatVersion: 1, assets: [] };
    const assetIndexPath = joinPath(root, ASSET_INDEX_FILE);
    if (await fs.exists(assetIndexPath)) {
      assets = AssetIndexSchema.parse(await readJson(fs, assetIndexPath));
    }

    const store = new ProjectStore(root, fs, project, assets);

    for (const ref of project.scenes) {
      const scenePath = joinPath(root, ref.path);
      if (!(await fs.exists(scenePath))) {
        throw new ProjectError(
          `Scene file missing: ${ref.path} (referenced by hearth.json as "${ref.name}")`,
          'NOT_FOUND',
        );
      }
      const scene = SceneSchema.parse(await readJson(fs, scenePath)) as Scene;
      store.scenes.set(scene.id, scene);
    }

    // Playtests are optional.
    const playtestsDir = joinPath(root, PLAYTESTS_DIR);
    if (await fs.exists(playtestsDir)) {
      for (const file of await fs.readdir(playtestsDir)) {
        if (!file.endsWith('.playtest.json')) continue;
        const pt = PlaytestSchema.parse(await readJson(fs, joinPath(playtestsDir, file)));
        store.playtests.set(pt.id, pt);
      }
    }

    return store;
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  markDirty(relativePath: string): void {
    this.dirty.add(relativePath);
  }

  /** Persist the full project model (project file, asset index, scenes, playtests). */
  async save(): Promise<string[]> {
    const written: string[] = [];
    await writeJson(this.fs, joinPath(this.root, PROJECT_FILE), this.project);
    written.push(PROJECT_FILE);
    await writeJson(this.fs, joinPath(this.root, ASSET_INDEX_FILE), this.assets);
    written.push(ASSET_INDEX_FILE);
    for (const ref of this.project.scenes) {
      const scene = this.scenes.get(ref.id);
      if (scene) {
        await writeJson(this.fs, joinPath(this.root, ref.path), scene);
        written.push(ref.path);
      }
    }
    for (const pt of this.playtests.values()) {
      const path = joinPath(PLAYTESTS_DIR, `${slugFromName(pt.name)}.playtest.json`);
      await writeJson(this.fs, joinPath(this.root, path), pt);
      written.push(path);
    }
    this.dirty.clear();
    return written;
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** Resolve a scene by id or (exact, then case-insensitive) name. */
  getScene(idOrName: string): Scene | undefined {
    const byId = this.scenes.get(idOrName);
    if (byId) return byId;
    const ref =
      this.project.scenes.find((s) => s.name === idOrName) ??
      this.project.scenes.find((s) => s.name.toLowerCase() === idOrName.toLowerCase());
    return ref ? this.scenes.get(ref.id) : undefined;
  }

  sceneRef(sceneId: string): SceneRef | undefined {
    return this.project.scenes.find((s) => s.id === sceneId);
  }

  getAsset(idOrName: string): Asset | undefined {
    return (
      this.assets.assets.find((a) => a.id === idOrName) ??
      this.assets.assets.find((a) => a.name === idOrName)
    );
  }

  getPlaytest(idOrName: string): Playtest | undefined {
    const byId = this.playtests.get(idOrName);
    if (byId) return byId;
    return [...this.playtests.values()].find((p) => p.name === idOrName);
  }

  /** Read a script's source (project-relative path). */
  async readScript(scriptPath: string): Promise<string> {
    return this.fs.readFile(joinPath(this.root, scriptPath));
  }

  async listScripts(): Promise<string[]> {
    const dir = joinPath(this.root, 'scripts');
    if (!(await this.fs.exists(dir))) return [];
    const out: string[] = [];
    for (const f of await this.fs.readdir(dir)) {
      if (f.endsWith('.lua') || f.endsWith('.js') || f.endsWith('.ts')) out.push(joinPath('scripts', f));
    }
    return out.sort();
  }

  /** Deep-copy snapshot of the whole project model (for diff baselines). */
  async toSnapshot(): Promise<ProjectSnapshot> {
    const scripts: Record<string, string> = {};
    for (const path of await this.listScripts()) {
      scripts[path] = await this.readScript(path);
    }
    return structuredClone({
      project: this.project,
      scenes: Object.fromEntries(this.scenes),
      assets: this.assets,
      scripts,
      playtests: Object.fromEntries(this.playtests),
    });
  }
}

// ---------------------------------------------------------------------------

export async function readJson(fs: FsLike, path: string): Promise<unknown> {
  const text = await fs.readFile(path);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProjectError(`Invalid JSON in ${path}: ${(err as Error).message}`, 'PARSE_ERROR');
  }
}

export async function writeJson(fs: FsLike, path: string, value: unknown): Promise<void> {
  await fs.writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

function slugFromName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'unnamed'
  );
}
