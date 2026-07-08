/**
 * Structural project diff.
 *
 * Compares two ProjectSnapshots (typically the `.hearth/baseline.json`
 * checkpoint vs the current state) and produces a typed, human- and
 * agent-readable change set. This powers `hearth diff`, the MCP `get_diff`
 * tool, and the editor's Diff/Review panel.
 */
import type { ProjectSnapshot } from '../project/store.js';
import type { Entity } from '../schema/scene.js';

export interface PropertyChange {
  /** Dot path within the component, e.g. "position.x". */
  path: string;
  before: unknown;
  after: unknown;
}

export interface ComponentDiff {
  type: string;
  status: 'added' | 'removed' | 'modified';
  changes: PropertyChange[];
}

export interface EntityDiff {
  id: string;
  name: string;
  status: 'added' | 'removed' | 'modified';
  /** Entity-level field changes (name, parentId, enabled, tags). */
  fieldChanges: PropertyChange[];
  components: ComponentDiff[];
}

export interface SceneDiff {
  id: string;
  name: string;
  status: 'added' | 'removed' | 'modified';
  entities: EntityDiff[];
}

export interface AssetDiffEntry {
  id: string;
  name: string;
  type: string;
  path: string;
  status: 'added' | 'removed' | 'modified';
}

export interface ScriptDiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  linesBefore: number;
  linesAfter: number;
}

export interface ProjectDiff {
  hasChanges: boolean;
  summary: string;
  projectChanges: PropertyChange[];
  scenes: SceneDiff[];
  assets: AssetDiffEntry[];
  scripts: ScriptDiffEntry[];
  playtests: { id: string; name: string; status: 'added' | 'removed' | 'modified' }[];
  stats: {
    scenesAdded: number;
    scenesRemoved: number;
    scenesModified: number;
    entitiesAdded: number;
    entitiesRemoved: number;
    entitiesModified: number;
    assetsChanged: number;
    scriptsChanged: number;
  };
}

// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-compare two values, emitting dot-path changes. Arrays compare atomically. */
export function diffValues(before: unknown, after: unknown, prefix = ''): PropertyChange[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const changes: PropertyChange[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const path = prefix ? `${prefix}.${key}` : key;
      changes.push(...diffValues(before[key], after[key], path));
    }
    return changes;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return [{ path: prefix, before, after }];
  }
  return [];
}

function diffEntity(before: Entity, after: Entity): EntityDiff | null {
  const fieldChanges: PropertyChange[] = [];
  for (const field of ['name', 'parentId', 'enabled'] as const) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      fieldChanges.push({ path: field, before: before[field], after: after[field] });
    }
  }
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) {
    fieldChanges.push({ path: 'tags', before: before.tags, after: after.tags });
  }

  const components: ComponentDiff[] = [];
  const beforeComponents = before.components as Record<string, unknown>;
  const afterComponents = after.components as Record<string, unknown>;
  for (const type of new Set([...Object.keys(beforeComponents), ...Object.keys(afterComponents)])) {
    const b = beforeComponents[type];
    const a = afterComponents[type];
    if (b === undefined && a !== undefined) {
      components.push({ type, status: 'added', changes: diffValues({}, a) });
    } else if (b !== undefined && a === undefined) {
      components.push({ type, status: 'removed', changes: [] });
    } else {
      const changes = diffValues(b, a);
      if (changes.length > 0) components.push({ type, status: 'modified', changes });
    }
  }

  if (fieldChanges.length === 0 && components.length === 0) return null;
  return { id: after.id, name: after.name, status: 'modified', fieldChanges, components };
}

export function diffSnapshots(before: ProjectSnapshot, after: ProjectSnapshot): ProjectDiff {
  const projectChanges = diffValues(
    { ...before.project, scenes: undefined },
    { ...after.project, scenes: undefined },
  );

  // --- scenes ---
  const scenes: SceneDiff[] = [];
  const sceneIds = new Set([...Object.keys(before.scenes), ...Object.keys(after.scenes)]);
  const stats = {
    scenesAdded: 0,
    scenesRemoved: 0,
    scenesModified: 0,
    entitiesAdded: 0,
    entitiesRemoved: 0,
    entitiesModified: 0,
    assetsChanged: 0,
    scriptsChanged: 0,
  };

  for (const id of sceneIds) {
    const b = before.scenes[id];
    const a = after.scenes[id];
    if (!b && a) {
      stats.scenesAdded++;
      stats.entitiesAdded += a.entities.length;
      scenes.push({
        id,
        name: a.name,
        status: 'added',
        entities: a.entities.map((e) => ({
          id: e.id,
          name: e.name,
          status: 'added' as const,
          fieldChanges: [],
          components: [],
        })),
      });
    } else if (b && !a) {
      stats.scenesRemoved++;
      stats.entitiesRemoved += b.entities.length;
      scenes.push({ id, name: b.name, status: 'removed', entities: [] });
    } else if (b && a) {
      const entityDiffs: EntityDiff[] = [];
      const bEntities = new Map(b.entities.map((e) => [e.id, e]));
      const aEntities = new Map(a.entities.map((e) => [e.id, e]));
      for (const [eid, entity] of aEntities) {
        if (!bEntities.has(eid)) {
          stats.entitiesAdded++;
          entityDiffs.push({
            id: eid,
            name: entity.name,
            status: 'added',
            fieldChanges: [],
            components: Object.keys(entity.components).map((type) => ({
              type,
              status: 'added' as const,
              changes: [],
            })),
          });
        }
      }
      for (const [eid, entity] of bEntities) {
        if (!aEntities.has(eid)) {
          stats.entitiesRemoved++;
          entityDiffs.push({ id: eid, name: entity.name, status: 'removed', fieldChanges: [], components: [] });
        } else {
          const d = diffEntity(entity, aEntities.get(eid)!);
          if (d) {
            stats.entitiesModified++;
            entityDiffs.push(d);
          }
        }
      }
      const nameChanged = b.name !== a.name;
      if (entityDiffs.length > 0 || nameChanged) {
        stats.scenesModified++;
        scenes.push({ id, name: a.name, status: 'modified', entities: entityDiffs });
      }
    }
  }

  // --- assets ---
  // A prefab's payload lives in a file, not the index, so an in-place
  // updatePrefab (same id/path, same entityCount metadata) leaves the index
  // entry byte-identical. Track which prefab payload files changed so such a
  // rewrite still surfaces as a modified asset.
  // `?? {}` guards: a snapshot written before v0.9 has no prefabs section.
  const beforePrefabs = before.prefabs ?? {};
  const afterPrefabs = after.prefabs ?? {};
  const changedPrefabPaths = new Set<string>();
  for (const path of new Set([...Object.keys(beforePrefabs), ...Object.keys(afterPrefabs)])) {
    if (beforePrefabs[path] !== afterPrefabs[path]) changedPrefabPaths.add(path);
  }

  const assets: AssetDiffEntry[] = [];
  const bAssets = new Map(before.assets.assets.map((a) => [a.id, a]));
  const aAssets = new Map(after.assets.assets.map((a) => [a.id, a]));
  for (const [id, asset] of aAssets) {
    if (!bAssets.has(id)) {
      assets.push({ id, name: asset.name, type: asset.type, path: asset.path, status: 'added' });
    } else {
      const indexChanged = JSON.stringify(bAssets.get(id)) !== JSON.stringify(asset);
      const payloadChanged = asset.type === 'prefab' && changedPrefabPaths.has(asset.path);
      if (indexChanged || payloadChanged) {
        assets.push({ id, name: asset.name, type: asset.type, path: asset.path, status: 'modified' });
      }
    }
  }
  for (const [id, asset] of bAssets) {
    if (!aAssets.has(id)) {
      assets.push({ id, name: asset.name, type: asset.type, path: asset.path, status: 'removed' });
    }
  }
  stats.assetsChanged = assets.length;

  // --- scripts ---
  const scripts: ScriptDiffEntry[] = [];
  const scriptPaths = new Set([...Object.keys(before.scripts), ...Object.keys(after.scripts)]);
  for (const path of scriptPaths) {
    const b = before.scripts[path];
    const a = after.scripts[path];
    if (b === undefined && a !== undefined) {
      scripts.push({ path, status: 'added', linesBefore: 0, linesAfter: a.split('\n').length });
    } else if (b !== undefined && a === undefined) {
      scripts.push({ path, status: 'removed', linesBefore: b.split('\n').length, linesAfter: 0 });
    } else if (b !== a) {
      scripts.push({
        path,
        status: 'modified',
        linesBefore: b!.split('\n').length,
        linesAfter: a!.split('\n').length,
      });
    }
  }
  stats.scriptsChanged = scripts.length;

  // --- playtests ---
  const playtests: ProjectDiff['playtests'] = [];
  const ptIds = new Set([...Object.keys(before.playtests), ...Object.keys(after.playtests)]);
  for (const id of ptIds) {
    const b = before.playtests[id];
    const a = after.playtests[id];
    if (!b && a) playtests.push({ id, name: a.name, status: 'added' });
    else if (b && !a) playtests.push({ id, name: b.name, status: 'removed' });
    else if (b && a && JSON.stringify(b) !== JSON.stringify(a)) {
      playtests.push({ id, name: a.name, status: 'modified' });
    }
  }

  const hasChanges =
    projectChanges.length > 0 ||
    scenes.length > 0 ||
    assets.length > 0 ||
    scripts.length > 0 ||
    playtests.length > 0;

  const parts: string[] = [];
  if (stats.scenesAdded) parts.push(`${stats.scenesAdded} scene(s) added`);
  if (stats.scenesRemoved) parts.push(`${stats.scenesRemoved} scene(s) removed`);
  if (stats.entitiesAdded) parts.push(`${stats.entitiesAdded} entity(ies) added`);
  if (stats.entitiesRemoved) parts.push(`${stats.entitiesRemoved} entity(ies) removed`);
  if (stats.entitiesModified) parts.push(`${stats.entitiesModified} entity(ies) modified`);
  if (stats.assetsChanged) parts.push(`${stats.assetsChanged} asset(s) changed`);
  if (stats.scriptsChanged) parts.push(`${stats.scriptsChanged} script(s) changed`);
  if (playtests.length) parts.push(`${playtests.length} playtest(s) changed`);
  if (projectChanges.length) parts.push(`${projectChanges.length} project setting(s) changed`);

  return {
    hasChanges,
    summary: hasChanges ? parts.join(', ') : 'No changes since baseline',
    projectChanges,
    scenes,
    assets,
    scripts,
    playtests,
    stats,
  };
}
