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
  /** Name of a sliced sheet frame on `assetId` to draw; null draws the whole image. */
  frame: z.string().nullable().default(null),
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
  shape: z.enum(['box', 'circle', 'polygon']).default('box'),
  width: z.number().positive().default(32),
  height: z.number().positive().default(32),
  radius: z.number().positive().default(16),
  /**
   * Local-space vertices, used when shape === 'polygon'. Must be convex
   * with at least 3 points (validateProject enforces this); split concave
   * shapes across multiple entities.
   */
  points: z
    .array(Vec2Schema)
    .default([
      { x: 0, y: -16 },
      { x: 16, y: 16 },
      { x: -16, y: 16 },
    ]),
  offset: Vec2Schema.default({ x: 0, y: 0 }),
  /** Triggers report overlaps but do not block movement. */
  isTrigger: z.boolean().default(false),
  /** Named collision layer this collider belongs to. */
  layer: z.string().min(1).default('default'),
  /** Layers this collider interacts with; '*' matches every layer. Both sides must match. */
  collidesWith: z.array(z.string()).default(['*']),
  /** One-way platform: only blocks movers landing from above. */
  oneWay: z.boolean().default(false),
});

export const PhysicsBodySchema = z.object({
  bodyType: z.enum(['dynamic', 'static', 'kinematic']).default('dynamic'),
  velocity: Vec2Schema.default({ x: 0, y: 0 }),
  gravityScale: z.number().default(1),
  /** Horizontal velocity damping per second (0 = none). */
  drag: z.number().min(0).default(0),
  /** Relative mass for mover-vs-mover push splits (heavier moves less). */
  mass: z.number().positive().default(1),
  /** Bounciness on contact, 0 (stop) to 1 (full reflect). Pair uses the max. */
  restitution: z.number().min(0).max(1).default(0),
  /** Tangential velocity damping on contact, 0 (slick) to 1 (grippy). Pair uses the max. */
  friction: z.number().min(0).max(1).default(0),
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
  /** Scene brightness with no lights: 1 = fully lit (lighting disabled), 0 = black. */
  ambientLight: z.number().min(0).max(1).default(1),
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
  /** Autoplay onto the single shared music channel (ctx.audio.playMusic) instead of a regular playback. */
  music: z.boolean().default(false),
});

export const UI_ANCHORS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;

export const UIElementSchema = z.object({
  /** Screen corner/edge this element is positioned from. */
  anchor: z.enum(UI_ANCHORS).default('top-left'),
  /** Pixel offset from the anchor point. */
  offset: Vec2Schema.default({ x: 0, y: 0 }),
  /**
   * When true, the element receives pointer events and its Script's
   * onUiEvent(ctx, event) hook fires with
   * { type: 'click'|'press'|'release'|'enter'|'exit' }.
   */
  interactive: z.boolean().default(false),
  /** When true, the element participates in keyboard/gamepad focus navigation. */
  focusable: z.boolean().default(false),
});

export const UILayoutSchema = z.object({
  direction: z.enum(['vertical', 'horizontal']).default('vertical'),
  gap: z.number().default(8),
  padding: z.number().default(0),
  align: z.enum(['start', 'center', 'end']).default('start'),
});

export const UISliderSchema = z.object({
  min: z.number().default(0),
  max: z.number().default(1),
  value: z.number().default(0.5),
  step: z.number().min(0).default(0),
  width: z.number().default(160),
  trackColor: z.string().default('#3a3a3a'),
  fillColor: z.string().default('#f76b15'),
  handleColor: z.string().default('#ececec'),
});

export const UIToggleSchema = z.object({
  value: z.boolean().default(false),
  size: z.number().default(20),
  color: z.string().default('#3a3a3a'),
  checkColor: z.string().default('#f76b15'),
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

export const Light2DSchema = z.object({
  /** Light falloff radius in world pixels. */
  radius: z.number().positive().default(200),
  color: ColorSchema.default('#ffffff'),
  /** Brightness multiplier at the light's center. */
  intensity: z.number().min(0).default(1),
  enabled: z.boolean().default(true),
});

export const LineRendererSchema = z.object({
  /** Polyline vertices in local space (entity transform applies). */
  points: z.array(Vec2Schema).default([]),
  width: z.number().positive().default(2),
  color: ColorSchema.default('#ffffff'),
  /** Connect the last point back to the first. */
  closed: z.boolean().default(false),
  opacity: z.number().min(0).max(1).default(1),
  layer: z.number().int().default(0),
  visible: z.boolean().default(true),
});

export const ParticleEmitterSchema = z.object({
  emitting: z.boolean().default(true),
  /** Particles spawned per second while emitting. */
  rate: z.number().min(0).default(10),
  /** Particles spawned once on scene start (in addition to rate). */
  burst: z.number().int().min(0).default(0),
  /** Particle lifetime in seconds. */
  lifetime: z.number().positive().default(1),
  /** Initial speed in pixels/second. */
  speed: z.number().min(0).default(100),
  /** Emission cone half-angle in degrees around direction. */
  spread: z.number().min(0).max(180).default(30),
  /** Emission direction in degrees (0 = +x, 90 = +y/down). */
  direction: z.number().default(0),
  /** Constant acceleration in pixels/second². */
  gravity: Vec2Schema.default({ x: 0, y: 0 }),
  startColor: ColorSchema.default('#ffffff'),
  endColor: ColorSchema.default('#ffffff'),
  startSize: z.number().min(0).default(8),
  endSize: z.number().min(0).default(0),
  /** Hard cap; oldest particles die first when exceeded. */
  maxParticles: z.number().int().positive().max(2048).default(256),
  layer: z.number().int().default(0),
  /** Per-emitter RNG seed — same seed, same particles, every run. */
  seed: z.number().int().default(0),
});

export const SpriteAnimatorSchema = z.object({
  /** Animation asset id (assets/animations/*.anim.json). */
  assetId: z.string().default(''),
  /** Frames per second; 0 = use the asset's frameDuration. */
  fps: z.number().min(0).default(0),
  playing: z.boolean().default(true),
  loop: z.boolean().default(true),
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
  Light2D: Light2DSchema,
  LineRenderer: LineRendererSchema,
  ParticleEmitter: ParticleEmitterSchema,
  SpriteAnimator: SpriteAnimatorSchema,
  UIElement: UIElementSchema,
  UILayout: UILayoutSchema,
  UISlider: UISliderSchema,
  UIToggle: UIToggleSchema,
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
export type Light2DComponent = z.infer<typeof Light2DSchema>;
export type LineRendererComponent = z.infer<typeof LineRendererSchema>;
export type ParticleEmitterComponent = z.infer<typeof ParticleEmitterSchema>;
export type SpriteAnimatorComponent = z.infer<typeof SpriteAnimatorSchema>;
export type UIElementComponent = z.infer<typeof UIElementSchema>;
export type UILayoutComponent = z.infer<typeof UILayoutSchema>;
export type UISliderComponent = z.infer<typeof UISliderSchema>;
export type UIToggleComponent = z.infer<typeof UIToggleSchema>;
export type UIAnchor = (typeof UI_ANCHORS)[number];

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
  Light2D?: Light2DComponent;
  LineRenderer?: LineRendererComponent;
  ParticleEmitter?: ParticleEmitterComponent;
  SpriteAnimator?: SpriteAnimatorComponent;
  UIElement?: UIElementComponent;
  UILayout?: UILayoutComponent;
  UISlider?: UISliderComponent;
  UIToggle?: UIToggleComponent;
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
    'Renders a sprite asset (assetId) or a colored primitive (shape/color/width/height) when no asset is set. frame: name of a sliced sheet frame to draw (null = whole image).',
  Collider:
    'Box, circle, or convex polygon collision shape (polygon uses points, local space, min 3 convex vertices). isTrigger=true reports overlaps without blocking movement. layer/collidesWith control which layers interact. oneWay=true makes one-way platforms.',
  PhysicsBody:
    'Simple physics: dynamic bodies fall with gravity and collide; kinematic bodies move by velocity only; static bodies never move. mass/restitution/friction fine-tune interactions.',
  Script: 'Attaches a behavior script from scripts/ (scriptPath; Lua by default, JavaScript also supported). params are passed to the script as ctx.params.',
  Camera: 'Viewpoint for the scene. One entity should have a Camera with isMain=true.',
  Text: 'Renders UI/world text (content, fontSize, color).',
  AudioSource:
    'References an audio asset; autoplay plays on scene start with loop/volume. music=true autoplays onto the single shared music channel instead (survives scene switches) rather than a regular playback. Scripts can also play any audio asset via ctx.audio.play(assetRef, { volume, loop }), or drive the music channel via ctx.audio.playMusic/stopMusic/setMusicVolume.',
  Tilemap: 'Character-grid tilemap: tileAssets maps grid characters to assets; solid=true auto-generates colliders.',
  Light2D: 'Emits dynamic 2D light (radius, color, intensity) in the forward rendering pipeline.',
  LineRenderer: 'Renders a polyline in local space; use for debug geometry or simple line effects.',
  ParticleEmitter: 'Spawns and simulates particles deterministically; seed controls reproducibility.',
  SpriteAnimator: 'Plays sprite animations; requires a sibling SpriteRenderer and animation asset.',
  UIElement:
    'Makes the entity screen-space UI: positioned by anchor+offset, unaffected by the camera. Visuals come from Text/SpriteRenderer. interactive=true sends pointer events to the Script hook onUiEvent(ctx, event). focusable=true lets it participate in keyboard/gamepad focus navigation.',
  UILayout:
    "Stacks child entities' UI elements vertically or horizontally; children's offsets become relative nudges",
  UISlider: "Draggable value widget rendered by the runtime; fires onUiEvent {type:'change', value}",
  UIToggle: "Boolean checkbox widget; click flips value and fires onUiEvent {type:'change', value}",
};
