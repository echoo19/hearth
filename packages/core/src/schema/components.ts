/**
 * Component schemas.
 *
 * Every component type has a Zod schema with defaults, so a bare `{}` is a
 * valid starting point for any component. Components are stored on entities
 * as a map keyed by component type (one component of each type per entity in
 * format v1 — the extension path to multi-instance components is an array
 * form behind a bumped formatVersion).
 */
import { z } from 'zod';

export const Vec2Schema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
});
export type Vec2 = z.infer<typeof Vec2Schema>;

const ColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected hex color like #ff8800');

export const TransformSchema = z.object({
  position: Vec2Schema.default({ x: 0, y: 0 }),
  rotation: z.number().default(0), // degrees
  scale: Vec2Schema.default({ x: 1, y: 1 }),
});

export const SpriteRendererSchema = z.object({
  assetId: z.string().nullable().default(null),
  /** Fallback when no asset is set: draw a primitive of this shape/color. */
  shape: z.enum(['rectangle', 'circle', 'triangle', 'none']).default('rectangle'),
  color: ColorSchema.default('#ffffff'),
  width: z.number().positive().default(32),
  height: z.number().positive().default(32),
  opacity: z.number().min(0).max(1).default(1),
  flipX: z.boolean().default(false),
  flipY: z.boolean().default(false),
  /** Higher layers render on top. */
  layer: z.number().int().default(0),
  visible: z.boolean().default(true),
});

export const ColliderSchema = z.object({
  shape: z.enum(['box', 'circle']).default('box'),
  width: z.number().positive().default(32),
  height: z.number().positive().default(32),
  radius: z.number().positive().default(16),
  offset: Vec2Schema.default({ x: 0, y: 0 }),
  /** Triggers report overlaps but do not block movement. */
  isTrigger: z.boolean().default(false),
});

export const PhysicsBodySchema = z.object({
  bodyType: z.enum(['dynamic', 'static', 'kinematic']).default('dynamic'),
  velocity: Vec2Schema.default({ x: 0, y: 0 }),
  gravityScale: z.number().default(1),
  /** Horizontal velocity damping per second (0 = none). */
  drag: z.number().min(0).default(0),
});

export const ScriptSchema = z.object({
  /** Project-relative path, e.g. "scripts/player.js". */
  scriptPath: z.string().default(''),
  /** Arbitrary parameters exposed to the script via ctx.params. */
  params: z.record(z.string(), z.unknown()).default({}),
});

export const CameraSchema = z.object({
  zoom: z.number().positive().default(1),
  isMain: z.boolean().default(true),
  backgroundColor: ColorSchema.default('#1a1a2e'),
});

export const TextSchema = z.object({
  content: z.string().default('Text'),
  fontSize: z.number().positive().default(16),
  color: ColorSchema.default('#ffffff'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  fontFamily: z.string().default('monospace'),
  layer: z.number().int().default(10),
  visible: z.boolean().default(true),
});

export const AudioSourceSchema = z.object({
  assetId: z.string().nullable().default(null),
  autoplay: z.boolean().default(false),
  loop: z.boolean().default(false),
  volume: z.number().min(0).max(1).default(1),
});

export const TilemapSchema = z.object({
  tileSize: z.number().positive().default(32),
  /**
   * Maps single characters used in `grid` rows to asset IDs.
   * '.' and ' ' always mean empty.
   */
  tileAssets: z.record(z.string(), z.string()).default({}),
  /** Rows of characters, top row first, e.g. ["........", "GGGGGGGG"]. */
  grid: z.array(z.string()).default([]),
  /** Whether tiles get box colliders automatically. */
  solid: z.boolean().default(true),
  layer: z.number().int().default(-10),
});

export const COMPONENT_SCHEMAS = {
  Transform: TransformSchema,
  SpriteRenderer: SpriteRendererSchema,
  Collider: ColliderSchema,
  PhysicsBody: PhysicsBodySchema,
  Script: ScriptSchema,
  Camera: CameraSchema,
  Text: TextSchema,
  AudioSource: AudioSourceSchema,
  Tilemap: TilemapSchema,
} as const;

export type ComponentType = keyof typeof COMPONENT_SCHEMAS;

export const COMPONENT_TYPES = Object.keys(COMPONENT_SCHEMAS) as ComponentType[];

export type TransformComponent = z.infer<typeof TransformSchema>;
export type SpriteRendererComponent = z.infer<typeof SpriteRendererSchema>;
export type ColliderComponent = z.infer<typeof ColliderSchema>;
export type PhysicsBodyComponent = z.infer<typeof PhysicsBodySchema>;
export type ScriptComponent = z.infer<typeof ScriptSchema>;
export type CameraComponent = z.infer<typeof CameraSchema>;
export type TextComponent = z.infer<typeof TextSchema>;
export type AudioSourceComponent = z.infer<typeof AudioSourceSchema>;
export type TilemapComponent = z.infer<typeof TilemapSchema>;

export interface ComponentMap {
  Transform?: TransformComponent;
  SpriteRenderer?: SpriteRendererComponent;
  Collider?: ColliderComponent;
  PhysicsBody?: PhysicsBodyComponent;
  Script?: ScriptComponent;
  Camera?: CameraComponent;
  Text?: TextComponent;
  AudioSource?: AudioSourceComponent;
  Tilemap?: TilemapComponent;
}

export function isComponentType(type: string): type is ComponentType {
  return type in COMPONENT_SCHEMAS;
}

/** Create a component of `type` with all defaults applied, then overrides. */
export function createComponent<T extends ComponentType>(
  type: T,
  overrides: Record<string, unknown> = {},
): z.infer<(typeof COMPONENT_SCHEMAS)[T]> {
  const schema = COMPONENT_SCHEMAS[type];
  return schema.parse(overrides) as z.infer<(typeof COMPONENT_SCHEMAS)[T]>;
}

/**
 * Human/agent-readable description of each component, used by
 * `hearth inspect components` and the MCP `get_component_docs` surface.
 */
export const COMPONENT_DOCS: Record<ComponentType, string> = {
  Transform: 'Position (pixels), rotation (degrees), and scale of an entity. Almost every entity needs one.',
  SpriteRenderer:
    'Renders a sprite asset (assetId) or a colored primitive (shape/color/width/height) when no asset is set.',
  Collider: 'Box or circle collision shape. isTrigger=true reports overlaps without blocking movement.',
  PhysicsBody:
    'Simple physics: dynamic bodies fall with gravity and collide; kinematic bodies move by velocity only; static bodies never move.',
  Script: 'Attaches a JavaScript behavior from scripts/ (scriptPath). params are passed to the script as ctx.params.',
  Camera: 'Viewpoint for the scene. One entity should have a Camera with isMain=true.',
  Text: 'Renders UI/world text (content, fontSize, color).',
  AudioSource: 'References an audio asset; autoplay/loop/volume. Playback support is experimental.',
  Tilemap: 'Character-grid tilemap: tileAssets maps grid characters to assets; solid=true auto-generates colliders.',
};
