import { describe, it, expect } from 'vitest';
import {
  collectSubtree,
  serializePrefab,
  instantiatePrefabData,
  validatePrefabLocalIds,
  PrefabDataSchema,
  EntitySchema,
  createComponent,
  COMPONENT_SCHEMAS,
  ProjectError,
  type Entity,
  type PrefabData,
} from '@hearth/core';

function makeEntity(id: string, parentId: string | null, extra: Partial<Entity> = {}): Entity {
  return {
    id,
    name: extra.name ?? id,
    parentId,
    enabled: extra.enabled ?? true,
    tags: extra.tags ?? [],
    components: extra.components ?? { Transform: createComponent('Transform') },
    ...(extra.prefab ? { prefab: extra.prefab } : {}),
  };
}

/**
 * root
 * ├─ child1
 * │   └─ grandchild
 * └─ child2
 * ent_other is unrelated (own root, no parent).
 */
function makeTree() {
  const root = makeEntity('ent_root', null, {
    name: 'Root',
    components: { Transform: createComponent('Transform', { position: { x: 10, y: 20 } }) },
  });
  const child1 = makeEntity('ent_child1', 'ent_root', { name: 'Child1' });
  const child2 = makeEntity('ent_child2', 'ent_root', { name: 'Child2' });
  const grandchild = makeEntity('ent_grandchild', 'ent_child1', { name: 'Grandchild' });
  const unrelated = makeEntity('ent_other', null, { name: 'Other' });
  return { root, child1, child2, grandchild, unrelated, all: [root, child1, child2, grandchild, unrelated] };
}

describe('collectSubtree', () => {
  it('returns root + descendants in BFS order, root first', () => {
    const { all } = makeTree();
    const subtree = collectSubtree(all, 'ent_root');
    expect(subtree.map((e) => e.id)).toEqual(['ent_root', 'ent_child1', 'ent_child2', 'ent_grandchild']);
  });

  it('ignores unrelated entities', () => {
    const { all } = makeTree();
    const subtree = collectSubtree(all, 'ent_root');
    expect(subtree.some((e) => e.id === 'ent_other')).toBe(false);
  });

  it('throws NOT_FOUND when the root id does not exist', () => {
    const { all } = makeTree();
    expect(() => collectSubtree(all, 'ent_missing')).toThrow(ProjectError);
    try {
      collectSubtree(all, 'ent_missing');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectError);
      expect((err as ProjectError).code).toBe('NOT_FOUND');
    }
  });
});

describe('serializePrefab', () => {
  it('normalizes ids to pfe_1.. in BFS order and remaps parentId', () => {
    const { all } = makeTree();
    const data = serializePrefab('MyPrefab', all, 'ent_root');
    expect(data.name).toBe('MyPrefab');
    expect(data.entities.map((e) => e.id)).toEqual(['pfe_1', 'pfe_2', 'pfe_3', 'pfe_4']);
    expect(data.entities.map((e) => e.name)).toEqual(['Root', 'Child1', 'Child2', 'Grandchild']);

    const [root, child1, child2, grandchild] = data.entities;
    expect(root.parentId).toBeNull();
    expect(child1.parentId).toBe('pfe_1');
    expect(child2.parentId).toBe('pfe_1');
    // grandchild's original parent was ent_child1, now remapped to pfe_2
    expect(grandchild.parentId).toBe('pfe_2');
  });

  it('strips prefab markers from the root and from children', () => {
    const root = makeEntity('ent_root', null, { name: 'Root', prefab: { asset: 'ast_source' } });
    const child = makeEntity('ent_child', 'ent_root', { name: 'Child', prefab: { asset: 'ast_nested' } });
    const data = serializePrefab('Nested', [root, child], 'ent_root');
    for (const e of data.entities) {
      expect((e as unknown as { prefab?: unknown }).prefab).toBeUndefined();
    }
  });

  it('produces data that satisfies PrefabDataSchema', () => {
    const { all } = makeTree();
    const data = serializePrefab('MyPrefab', all, 'ent_root');
    expect(() => PrefabDataSchema.parse(data)).not.toThrow();
  });
});

describe('instantiatePrefabData', () => {
  function makePrefab(): PrefabData {
    const { all } = makeTree();
    return serializePrefab('MyPrefab', all, 'ent_root');
  }

  it('round-trips with fresh ent_* ids and an intact hierarchy', () => {
    const data = makePrefab();
    const instances = instantiatePrefabData(data);
    expect(instances).toHaveLength(4);
    for (const e of instances) {
      expect(e.id).toMatch(/^ent_[a-z0-9]+$/);
    }
    const ids = instances.map((e) => e.id);
    expect(new Set(ids).size).toBe(4); // all fresh, all unique

    const [root, child1, child2, grandchild] = instances;
    expect(root.parentId).toBeNull();
    expect(child1.parentId).toBe(root.id);
    expect(child2.parentId).toBe(root.id);
    expect(grandchild.parentId).toBe(child1.id);
  });

  it('applies opts.position to the root Transform.position', () => {
    const data = makePrefab();
    const instances = instantiatePrefabData(data, { position: { x: 100, y: 200 } });
    expect(instances[0].components.Transform?.position).toEqual({ x: 100, y: 200 });
  });

  it('creates a Transform on the root if absent when position is given', () => {
    const data: PrefabData = {
      name: 'NoTransform',
      entities: [{ id: 'pfe_1', name: 'Root', parentId: null, enabled: true, tags: [], components: {} }],
    };
    const instances = instantiatePrefabData(data, { position: { x: 5, y: 6 } });
    expect(instances[0].components.Transform?.position).toEqual({ x: 5, y: 6 });
  });

  it('defaults the root name to data.name, or uses opts.name when given', () => {
    const data = makePrefab();
    const defaultNamed = instantiatePrefabData(data);
    expect(defaultNamed[0].name).toBe('MyPrefab');

    const renamed = instantiatePrefabData(data, { name: 'Custom Name' });
    expect(renamed[0].name).toBe('Custom Name');
  });

  it('preserveRootId keeps the given root id and remaps children only', () => {
    const data = makePrefab();
    const instances = instantiatePrefabData(data, { preserveRootId: 'ent_fixed' });
    expect(instances[0].id).toBe('ent_fixed');
    expect(instances[1].parentId).toBe('ent_fixed');
    expect(instances[2].parentId).toBe('ent_fixed');
    // non-root ids are still freshly generated, not the preserved id
    expect(instances[1].id).not.toBe('ent_fixed');
    expect(instances[1].id).toMatch(/^ent_[a-z0-9]+$/);
  });

  it('does not mutate the source PrefabData', () => {
    const data = makePrefab();
    const before = JSON.parse(JSON.stringify(data));
    instantiatePrefabData(data, { position: { x: 999, y: 999 }, name: 'Mutated' });
    expect(data).toEqual(before);
  });
});

describe('validatePrefabLocalIds', () => {
  function basePrefab(): PrefabData {
    return {
      name: 'Valid',
      entities: [
        { id: 'pfe_1', name: 'Root', parentId: null, enabled: true, tags: [], components: {} },
        { id: 'pfe_2', name: 'Child', parentId: 'pfe_1', enabled: true, tags: [], components: {} },
      ],
    };
  }

  it('returns no problems for a well-formed prefab', () => {
    expect(validatePrefabLocalIds(basePrefab())).toEqual([]);
  });

  it('catches a root whose parentId is not null (non-root-first)', () => {
    const data = basePrefab();
    data.entities[0] = { ...data.entities[0], parentId: 'pfe_2' };
    const problems = validatePrefabLocalIds(data);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('catches a child ordered before its parent (non-root-first)', () => {
    const data = basePrefab();
    // Child (pfe_2) now claims a parent (pfe_3) that appears later in the array.
    data.entities.push({ id: 'pfe_3', name: 'Grandchild', parentId: 'pfe_2', enabled: true, tags: [], components: {} });
    const reordered: PrefabData = { name: data.name, entities: [data.entities[0], data.entities[2], data.entities[1]] };
    const problems = validatePrefabLocalIds(reordered);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('catches a dangling parentId', () => {
    const data = basePrefab();
    data.entities[1] = { ...data.entities[1], parentId: 'pfe_99' };
    const problems = validatePrefabLocalIds(data);
    expect(problems.some((p) => p.toLowerCase().includes('dangling'))).toBe(true);
  });

  it('catches duplicate local ids', () => {
    const data = basePrefab();
    data.entities[1] = { ...data.entities[1], id: 'pfe_1' };
    const problems = validatePrefabLocalIds(data);
    expect(problems.some((p) => p.toLowerCase().includes('duplicate'))).toBe(true);
  });

  it('catches a leftover prefab marker', () => {
    const data = basePrefab();
    (data.entities[1] as unknown as { prefab?: unknown }).prefab = { asset: 'ast_x' };
    const problems = validatePrefabLocalIds(data);
    expect(problems.some((p) => p.toLowerCase().includes('marker'))).toBe(true);
  });
});

describe('EntitySchema prefab marker', () => {
  it('accepts and round-trips an optional prefab marker', () => {
    const parsed = EntitySchema.parse({
      id: 'ent_abc123',
      name: 'Instance',
      parentId: null,
      components: {},
      prefab: { asset: 'ast_myprefab' },
    });
    expect(parsed.prefab).toEqual({ asset: 'ast_myprefab' });
  });

  it('still parses old scenes with no prefab marker', () => {
    const parsed = EntitySchema.parse({
      id: 'ent_abc123',
      name: 'Plain',
      parentId: null,
      components: {},
    });
    expect(parsed.prefab).toBeUndefined();
  });
});

describe('component schema drift guard', () => {
  it('has no component field that looks like it stores an entity id (remap-site guard)', () => {
    // prefabData's id remap only touches entity.id/entity.parentId — if any
    // component ever grows a field like entityId/targetEntity, component
    // data would silently keep pointing at pre-instantiation ids. This test
    // fails loudly the moment that happens so the remap site gets updated.
    const offenders: string[] = [];
    for (const [type, schema] of Object.entries(COMPONENT_SCHEMAS)) {
      const shape = (schema as { shape: Record<string, unknown> }).shape;
      for (const field of Object.keys(shape)) {
        if (/entity[_-]?id|target[_-]?entity/i.test(field)) {
          offenders.push(`${type}.${field}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
