/**
 * Scene and entity schemas.
 *
 * A scene file (`scenes/<slug>.scene.json`) contains a flat entity list;
 * hierarchy is expressed via `parentId`. Flat lists diff and patch better
 * than nested trees and are easier for agents to address by ID.
 */
import { z } from 'zod';
import { COMPONENT_SCHEMAS, type ComponentMap } from './components.js';

const componentsShape: Record<string, z.ZodTypeAny> = {};
for (const [name, schema] of Object.entries(COMPONENT_SCHEMAS)) {
  componentsShape[name] = schema.optional();
}

export const ComponentMapSchema = z.object(componentsShape).strict();

export const EntitySchema = z.object({
  id: z.string().regex(/^ent_[a-z0-9]+$/, 'entity ids look like ent_abc123'),
  name: z.string().min(1),
  parentId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  /** Free-form tags for queries like scene.findByTag('enemy'). */
  tags: z.array(z.string()).default([]),
  components: ComponentMapSchema.default({}),
  /** Marks this entity as a live instance of a prefab asset (round-trip only for now; sync lands in a later wave-F task). */
  prefab: z.object({ asset: z.string() }).optional(),
});

export type Entity = Omit<z.infer<typeof EntitySchema>, 'components'> & {
  components: ComponentMap;
};

export const SceneSchema = z.object({
  formatVersion: z.literal(1).default(1),
  id: z.string().regex(/^scn_[a-z0-9]+$/),
  name: z.string().min(1),
  entities: z.array(EntitySchema).default([]),
});

export type Scene = Omit<z.infer<typeof SceneSchema>, 'entities'> & {
  entities: Entity[];
};

/** Find an entity by ID or (exact) name. IDs win on collision. */
export function findEntity(scene: Scene, idOrName: string): Entity | undefined {
  return (
    scene.entities.find((e) => e.id === idOrName) ??
    scene.entities.find((e) => e.name === idOrName)
  );
}

export function childrenOf(scene: Scene, entityId: string): Entity[] {
  return scene.entities.filter((e) => e.parentId === entityId);
}

/** Returns entity ids that would create a cycle if `childId` re-parented to `newParentId`. */
export function wouldCreateCycle(scene: Scene, childId: string, newParentId: string | null): boolean {
  let current: string | null = newParentId;
  const seen = new Set<string>();
  while (current) {
    if (current === childId) return true;
    if (seen.has(current)) return true; // pre-existing cycle; treat as unsafe
    seen.add(current);
    const parent = scene.entities.find((e) => e.id === current);
    current = parent?.parentId ?? null;
  }
  return false;
}
