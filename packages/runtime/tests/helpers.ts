/**
 * Test helpers: build a small in-memory Hearth project around a single
 * hand-authored scene, persist it, and reload it through ProjectStore so
 * tests exercise the same parse path as real projects.
 */
import {
  MemoryFileSystem,
  ProjectStore,
  SceneSchema,
  createProject,
  type Entity,
  type Scene,
} from '@hearth/core';

let entitySeq = 0;

/** Build a scene entity literal with a fresh id. */
export function ent(
  name: string,
  components: Record<string, unknown>,
  extra: Partial<Pick<Entity, 'parentId' | 'enabled' | 'tags'>> & { id?: string } = {},
): Record<string, unknown> {
  return {
    id: extra.id ?? `ent_t${entitySeq++}`,
    name,
    parentId: extra.parentId ?? null,
    enabled: extra.enabled ?? true,
    tags: extra.tags ?? [],
    components,
  };
}

export interface TestProjectOptions {
  entities: Record<string, unknown>[];
  /** Filename under scripts/ → source. */
  scripts?: Record<string, string>;
  actions?: Record<string, string[]>;
  /** Asset index entries, e.g. { id: 'ast_beep', name: 'beep', type: 'audio', path: '...' }. */
  assets?: { id: string; name: string; type: string; path: string }[];
}

export async function makeStore(
  opts: TestProjectOptions,
): Promise<{ store: ProjectStore; fs: MemoryFileSystem }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test', starterScene: false });
  if (opts.actions) store.project.inputMappings.actions = opts.actions;
  store.project.scenes.push({ id: 'scn_test', name: 'Test', path: 'scenes/test.scene.json' });
  store.project.initialScene = 'scn_test';
  const scene = SceneSchema.parse({
    formatVersion: 1,
    id: 'scn_test',
    name: 'Test',
    entities: opts.entities,
  }) as Scene;
  store.scenes.set(scene.id, scene);
  for (const [name, source] of Object.entries(opts.scripts ?? {})) {
    await fs.writeFile(`/proj/scripts/${name}`, source);
  }
  for (const asset of opts.assets ?? []) {
    store.assets.assets.push({ ...asset, metadata: {} } as (typeof store.assets.assets)[number]);
  }
  await store.save();
  return { store: await ProjectStore.load(fs, '/proj'), fs };
}
