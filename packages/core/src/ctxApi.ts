/**
 * CTX_API — the machine-readable reference for the script `ctx` surface.
 *
 * This is the single source of truth agents (and generated docs) use to
 * learn the scripting API. It mirrors the runtime's ScriptContext interface
 * (packages/runtime/src/scripts.ts) exactly — v1 plus the ctx v2 stdlib
 * (scenes, timers, tweens, random, save/load, camera). Keep the signatures
 * in sync with the runtime; this file is plain data and stays browser-safe
 * and runtime-free.
 *
 * The same `ctx` object is handed to both Lua and JS scripts. Lua scripts
 * call it with a dot, not a colon: `ctx.log("hi")`, never `ctx:log("hi")`.
 */

export interface CtxApiEntry {
  /** Dot path under ctx, e.g. "scenes.load" or "save". */
  path: string;
  kind: 'method' | 'property';
  /** TypeScript-style signature, matching the runtime interface. */
  signature: string;
  description: string;
  example?: { js: string; lua: string };
}

export const CTX_API: readonly CtxApiEntry[] = [
  // --- this entity -----------------------------------------------------
  {
    path: 'entity',
    kind: 'property',
    signature: 'entity: { id: string; name: string; tags: string[] }',
    description: "This entity's id, name, and tags.",
    example: { js: 'ctx.log(ctx.entity.name)', lua: 'ctx.log(ctx.entity.name)' },
  },
  {
    path: 'transform',
    kind: 'property',
    signature: 'transform: TransformComponent',
    description: 'Live Transform of this entity (mutable): position, rotation, scale.',
    example: {
      js: 'ctx.transform.position.x += 100 * dt',
      lua: 'ctx.transform.position.x = ctx.transform.position.x + 100 * dt',
    },
  },
  {
    path: 'getComponent',
    kind: 'method',
    signature: 'getComponent<T extends ComponentType>(type: T): ComponentMap[T]',
    description: 'Live component data for this entity (mutable).',
    example: {
      js: "const sprite = ctx.getComponent('SpriteRenderer')",
      lua: 'local sprite = ctx.getComponent("SpriteRenderer")',
    },
  },
  {
    path: 'params',
    kind: 'property',
    signature: 'params: Record<string, unknown>',
    description: 'Parameters from the Script component (set via attachScript).',
    example: { js: 'const speed = ctx.params.speed ?? 200', lua: 'local speed = ctx.params.speed or 200' },
  },
  // --- input -----------------------------------------------------------
  {
    path: 'input.isDown',
    kind: 'method',
    signature: 'isDown(action: string): boolean',
    description: 'Is an input action currently held?',
    example: { js: "if (ctx.input.isDown('right')) { /* ... */ }", lua: 'if ctx.input.isDown("right") then end' },
  },
  {
    path: 'input.justPressed',
    kind: 'method',
    signature: 'justPressed(action: string): boolean',
    description: 'Was the input action pressed this frame?',
    example: { js: "if (ctx.input.justPressed('jump')) { /* ... */ }", lua: 'if ctx.input.justPressed("jump") then end' },
  },
  // --- current scene entities -------------------------------------------
  {
    path: 'scene.find',
    kind: 'method',
    signature: 'find(idOrName: string): EntityHandle | null',
    description: 'Find an entity in the current scene by id or name.',
    example: { js: "const player = ctx.scene.find('Player')", lua: 'local player = ctx.scene.find("Player")' },
  },
  {
    path: 'scene.findByTag',
    kind: 'method',
    signature: 'findByTag(tag: string): EntityHandle[]',
    description: 'All entities in the current scene with the given tag.',
    example: { js: "const coins = ctx.scene.findByTag('coin')", lua: 'local coins = ctx.scene.findByTag("coin")' },
  },
  {
    path: 'scene.spawn',
    kind: 'method',
    signature: 'spawn(def: SpawnDef): EntityHandle',
    description: 'Create an entity at runtime ({ name, position?, tags?, components? }).',
    example: {
      js: "ctx.scene.spawn({ name: 'Coin', position: { x: 100, y: 50 } })",
      lua: 'ctx.scene.spawn({ name = "Coin", position = { x = 100, y = 50 } })',
    },
  },
  {
    path: 'scene.destroy',
    kind: 'method',
    signature: 'destroy(idOrHandle: string | EntityHandle): void',
    description: 'Remove an entity from the current scene at runtime.',
    example: { js: 'ctx.scene.destroy(other)', lua: 'ctx.scene.destroy(other)' },
  },
  // --- scene management (ctx v2) ----------------------------------------
  {
    path: 'scenes.current',
    kind: 'property',
    signature: 'current: { id: string; name: string }',
    description: 'Current scene {id, name}.',
    example: { js: 'ctx.log(ctx.scenes.current.name)', lua: 'ctx.log(ctx.scenes.current.name)' },
  },
  {
    path: 'scenes.list',
    kind: 'method',
    signature: 'list(): { id: string; name: string }[]',
    description: 'All scenes in the project as {id, name}.',
    example: { js: 'const all = ctx.scenes.list()', lua: 'local all = ctx.scenes.list()' },
  },
  {
    path: 'scenes.load',
    kind: 'method',
    signature: 'load(idOrName: string): boolean',
    description: 'Request a scene switch at end of frame. False if unknown.',
    example: { js: "ctx.scenes.load('Level')", lua: 'ctx.scenes.load("Level")' },
  },
  // --- timers (ctx v2) ---------------------------------------------------
  {
    path: 'timers.after',
    kind: 'method',
    signature: 'after(seconds: number, fn: () => void): string',
    description: 'Run fn once after `seconds`. Returns a cancel id.',
    example: {
      js: "ctx.timers.after(2, () => ctx.log('boom'))",
      lua: 'ctx.timers.after(2, function() ctx.log("boom") end)',
    },
  },
  {
    path: 'timers.every',
    kind: 'method',
    signature: 'every(seconds: number, fn: () => void): string',
    description: 'Run fn every `seconds`. Returns a cancel id.',
    example: {
      js: 'ctx.vars.spawner = ctx.timers.every(1, () => spawnEnemy(ctx))',
      lua: 'ctx.vars.spawner = ctx.timers.every(1, function() spawnEnemy(ctx) end)',
    },
  },
  {
    path: 'timers.cancel',
    kind: 'method',
    signature: 'cancel(id: string): void',
    description: 'Cancel a timer by the id returned from after/every.',
    example: { js: 'ctx.timers.cancel(ctx.vars.spawner)', lua: 'ctx.timers.cancel(ctx.vars.spawner)' },
  },
  // --- tweens (ctx v2) ----------------------------------------------------
  {
    path: 'tweens.to',
    kind: 'method',
    signature:
      "to(path: string, target: number, seconds: number, opts?: { easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'; onComplete?: () => void }): string",
    description:
      "Tween a numeric component property on this entity, e.g. to('Transform.position.x', 400, 0.5, { easing: 'easeOut' }). Returns a cancel id. Unknown/non-numeric path → warn log + '' id.",
    example: {
      js: "ctx.tweens.to('Transform.position.x', 400, 0.5, { easing: 'easeOut' })",
      lua: 'ctx.tweens.to("Transform.position.x", 400, 0.5, { easing = "easeOut" })',
    },
  },
  {
    path: 'tweens.cancel',
    kind: 'method',
    signature: 'cancel(id: string): void',
    description: 'Cancel a tween by the id returned from tweens.to.',
    example: { js: 'ctx.tweens.cancel(ctx.vars.slide)', lua: 'ctx.tweens.cancel(ctx.vars.slide)' },
  },
  // --- seeded RNG (ctx v2) -------------------------------------------------
  {
    path: 'random.next',
    kind: 'method',
    signature: 'next(): number',
    description: 'Seeded, deterministic [0, 1). Same seed → same sequence.',
    example: { js: 'const roll = ctx.random.next()', lua: 'local roll = ctx.random.next()' },
  },
  {
    path: 'random.range',
    kind: 'method',
    signature: 'range(min: number, max: number): number',
    description: 'Seeded float in [min, max).',
    example: { js: 'const x = ctx.random.range(0, 800)', lua: 'local x = ctx.random.range(0, 800)' },
  },
  {
    path: 'random.int',
    kind: 'method',
    signature: 'int(min: number, max: number): number',
    description: 'Seeded integer, min and max inclusive.',
    example: { js: 'const die = ctx.random.int(1, 6)', lua: 'local die = ctx.random.int(1, 6)' },
  },
  // --- particles & sprite animation (rendering v2) ------------------------
  {
    path: 'particles.burst',
    kind: 'method',
    signature: 'burst(count: number): void',
    description:
      "Spawn `count` particles immediately from this entity's ParticleEmitter (in addition to its normal rate/burst). Warns if the entity has no ParticleEmitter.",
    example: { js: 'ctx.particles.burst(20)', lua: 'ctx.particles.burst(20)' },
  },
  {
    path: 'particles.count',
    kind: 'method',
    signature: 'count(): number',
    description: "Live particle count for this entity's ParticleEmitter (0 if none).",
    example: { js: 'const n = ctx.particles.count()', lua: 'local n = ctx.particles.count()' },
  },
  {
    path: 'animate',
    kind: 'method',
    signature: 'animate(assetRef: string): void',
    description:
      "Switch this entity's SpriteAnimator to `assetRef` (animation asset id or name), set playing = true, and restart at frame 0. Warns if the entity has no SpriteAnimator or the asset is unknown.",
    example: { js: "ctx.animate('torch-flare')", lua: 'ctx.animate("torch-flare")' },
  },
  // --- math (wave B) --------------------------------------------------
  {
    path: 'math.vec2',
    kind: 'method',
    signature: 'vec2(x?: number, y?: number): Vec2',
    description: 'Create a vector {x, y}. Missing args default to 0.',
    example: { js: 'const pos = ctx.math.vec2(100, 50)', lua: 'local pos = ctx.math.vec2(100, 50)' },
  },
  {
    path: 'math.add',
    kind: 'method',
    signature: 'add(a: Vec2, b: Vec2): Vec2',
    description: 'Vector addition. Pure — returns a new value without mutating inputs.',
    example: { js: 'const sum = ctx.math.add(a, b)', lua: 'local sum = ctx.math.add(a, b)' },
  },
  {
    path: 'math.sub',
    kind: 'method',
    signature: 'sub(a: Vec2, b: Vec2): Vec2',
    description: 'Vector subtraction. Pure — returns a new value without mutating inputs.',
    example: { js: 'const diff = ctx.math.sub(target, me)', lua: 'local diff = ctx.math.sub(target, me)' },
  },
  {
    path: 'math.scale',
    kind: 'method',
    signature: 'scale(v: Vec2, s: number): Vec2',
    description: 'Scale a vector by a scalar. Pure — returns a new value.',
    example: { js: 'const big = ctx.math.scale(v, 2)', lua: 'local big = ctx.math.scale(v, 2)' },
  },
  {
    path: 'math.dot',
    kind: 'method',
    signature: 'dot(a: Vec2, b: Vec2): number',
    description: 'Dot product of two vectors.',
    example: { js: 'const similarity = ctx.math.dot(a, b)', lua: 'local similarity = ctx.math.dot(a, b)' },
  },
  {
    path: 'math.length',
    kind: 'method',
    signature: 'length(v: Vec2): number',
    description: 'Length (magnitude) of a vector.',
    example: { js: 'const dist = ctx.math.length(v)', lua: 'local dist = ctx.math.length(v)' },
  },
  {
    path: 'math.distance',
    kind: 'method',
    signature: 'distance(a: Vec2, b: Vec2): number',
    description: 'Distance between two points.',
    example: { js: 'const d = ctx.math.distance(me, target)', lua: 'local d = ctx.math.distance(me, target)' },
  },
  {
    path: 'math.normalize',
    kind: 'method',
    signature: 'normalize(v: Vec2): Vec2',
    description: 'Unit vector in the direction of v ({x:0,y:0} for the zero vector). Pure — returns a new value.',
    example: { js: 'const dir = ctx.math.normalize(ctx.math.sub(target, me))', lua: 'local dir = ctx.math.normalize(ctx.math.sub(target, me))' },
  },
  {
    path: 'math.angle',
    kind: 'method',
    signature: 'angle(v: Vec2): number',
    description: 'Angle of a vector in degrees (0 = +x, 90 = +y/down).',
    example: { js: 'const deg = ctx.math.angle(v)', lua: 'local deg = ctx.math.angle(v)' },
  },
  {
    path: 'math.fromAngle',
    kind: 'method',
    signature: 'fromAngle(degrees: number, length?: number): Vec2',
    description: 'Unit vector from an angle in degrees (default length 1). 0 = +x, 90 = +y/down.',
    example: { js: 'const dir = ctx.math.fromAngle(45, 10)', lua: 'local dir = ctx.math.fromAngle(45, 10)' },
  },
  {
    path: 'math.lerp',
    kind: 'method',
    signature: 'lerp(a: number, b: number, t: number): number',
    description: 'Linear interpolation between two scalars. Does not clamp t.',
    example: { js: 'const halfway = ctx.math.lerp(0, 100, 0.5)', lua: 'local halfway = ctx.math.lerp(0, 100, 0.5)' },
  },
  {
    path: 'math.lerpVec',
    kind: 'method',
    signature: 'lerpVec(a: Vec2, b: Vec2, t: number): Vec2',
    description: 'Linear interpolation between two vectors. Does not clamp t. Pure — returns a new value.',
    example: { js: 'const halfway = ctx.math.lerpVec(a, b, 0.5)', lua: 'local halfway = ctx.math.lerpVec(a, b, 0.5)' },
  },
  {
    path: 'math.clamp',
    kind: 'method',
    signature: 'clamp(x: number, min: number, max: number): number',
    description: 'Clamp a value to [min, max].',
    example: { js: 'const bounded = ctx.math.clamp(x, 0, 100)', lua: 'local bounded = ctx.math.clamp(x, 0, 100)' },
  },
  {
    path: 'math.hexToRgb',
    kind: 'method',
    signature: 'hexToRgb(hex: string): { r: number; g: number; b: number }',
    description: 'Parse a hex color string (#rgb, #rrggbb, or #rrggbbaa) to {r, g, b}. Returns white on invalid input (warns once per instance).',
    example: { js: 'const rgb = ctx.math.hexToRgb("#ff8800")', lua: 'local rgb = ctx.math.hexToRgb("#ff8800")' },
  },
  {
    path: 'math.rgbToHex',
    kind: 'method',
    signature: 'rgbToHex(r: number, g: number, b: number): string',
    description: 'Convert RGB channels (0–255) to a hex color string. Clamps and rounds channel values.',
    example: { js: 'const hex = ctx.math.rgbToHex(255, 136, 0)', lua: 'local hex = ctx.math.rgbToHex(255, 136, 0)' },
  },
  {
    path: 'math.colorLerp',
    kind: 'method',
    signature: 'colorLerp(hexA: string, hexB: string, t: number): string',
    description: 'Interpolate between two hex colors. Clamps t to [0, 1].',
    example: { js: 'const mid = ctx.math.colorLerp("#000000", "#ffffff", 0.5)', lua: 'local mid = ctx.math.colorLerp("#000000", "#ffffff", 0.5)' },
  },
  // --- persistence (ctx v2) --------------------------------------------------
  {
    path: 'save',
    kind: 'method',
    signature: 'save(key: string, value: unknown): void',
    description:
      'Persistent save data (JSON values), survives scene switches; in the browser it persists across sessions via localStorage.',
    example: { js: "ctx.save('bestScore', score)", lua: 'ctx.save("bestScore", score)' },
  },
  {
    path: 'load',
    kind: 'method',
    signature: 'load(key: string): unknown',
    description: 'Read saved data; null when absent.',
    example: { js: "const best = ctx.load('bestScore') ?? 0", lua: 'local best = ctx.load("bestScore") or 0' },
  },
  {
    path: 'clearSave',
    kind: 'method',
    signature: 'clearSave(key?: string): void',
    description: 'Clear one save key, or all save data when no key is given.',
    example: { js: 'ctx.clearSave()', lua: 'ctx.clearSave()' },
  },
  // --- camera (ctx v2) ----------------------------------------------------
  {
    path: 'camera.getPosition',
    kind: 'method',
    signature: 'getPosition(): Vec2',
    description: "The main camera's position {x, y}.",
    example: { js: 'const pos = ctx.camera.getPosition()', lua: 'local pos = ctx.camera.getPosition()' },
  },
  {
    path: 'camera.setPosition',
    kind: 'method',
    signature: 'setPosition(x: number, y: number): void',
    description: 'Move the main camera.',
    example: { js: 'ctx.camera.setPosition(0, 300)', lua: 'ctx.camera.setPosition(0, 300)' },
  },
  {
    path: 'camera.getZoom',
    kind: 'method',
    signature: 'getZoom(): number',
    description: "The main camera's zoom factor.",
    example: { js: 'const zoom = ctx.camera.getZoom()', lua: 'local zoom = ctx.camera.getZoom()' },
  },
  {
    path: 'camera.setZoom',
    kind: 'method',
    signature: 'setZoom(zoom: number): void',
    description: "Set the main camera's zoom factor.",
    example: { js: 'ctx.camera.setZoom(2)', lua: 'ctx.camera.setZoom(2)' },
  },
  {
    path: 'camera.follow',
    kind: 'method',
    signature: 'follow(idOrName: string | null): void',
    description: 'Follow an entity each frame (null stops). Warn log if not found.',
    example: { js: "ctx.camera.follow('Player')", lua: 'ctx.camera.follow("Player")' },
  },
  // --- audio -----------------------------------------------------------
  {
    path: 'audio.play',
    kind: 'method',
    signature: 'play(assetRef: string, opts?: { volume?: number; loop?: boolean }): string | null',
    description:
      'Play an audio asset (by asset id or name). Returns a handle id for ctx.audio.stop, or null when the asset does not exist.',
    example: {
      js: "ctx.audio.play('pickup', { volume: 0.5 })",
      lua: 'ctx.audio.play("pickup", { volume = 0.5 })',
    },
  },
  {
    path: 'audio.stop',
    kind: 'method',
    signature: 'stop(handleIdOrAssetRef: string): void',
    description: 'Stop a playback by handle id, or every playback of an asset id/name.',
    example: { js: "ctx.audio.stop('music')", lua: 'ctx.audio.stop("music")' },
  },
  // --- state / time / logging --------------------------------------------
  {
    path: 'vars',
    kind: 'property',
    signature: 'vars: Record<string, unknown>',
    description: 'Persistent per-entity state, survives across frames (not across scene switches — use ctx.save).',
    example: { js: 'ctx.vars.score = (ctx.vars.score ?? 0) + 1', lua: 'ctx.vars.score = (ctx.vars.score or 0) + 1' },
  },
  {
    path: 'time',
    kind: 'property',
    signature: 'time: { elapsed: number; delta: number; frame: number }',
    description: 'Elapsed seconds, delta seconds, and frame count.',
    example: { js: 'if (ctx.time.frame % 60 === 0) { /* ... */ }', lua: 'if ctx.time.frame % 60 == 0 then end' },
  },
  {
    path: 'log',
    kind: 'method',
    signature: 'log(...args: unknown[]): void',
    description: 'Log to the Hearth console (shows up in playtest and smoke-run reports).',
    example: { js: "ctx.log('hp', ctx.vars.hp)", lua: 'ctx.log("hp", ctx.vars.hp)' },
  },
  // --- collisions / lifecycle ----------------------------------------------
  {
    path: 'collisions',
    kind: 'property',
    signature: 'collisions: ScriptCollision[]',
    description: "This entity's current collisions (refreshed each frame): { other, normal, trigger }.",
    example: {
      js: 'for (const c of ctx.collisions) ctx.log(c.other.name)',
      lua: 'for _, c in ipairs(ctx.collisions) do ctx.log(c.other.name) end',
    },
  },
  {
    path: 'isGrounded',
    kind: 'method',
    signature: 'isGrounded(): boolean',
    description: 'Any non-trigger contact pushing this entity up (normal.y < -0.5).',
    example: {
      js: "if (ctx.isGrounded() && ctx.input.justPressed('jump')) { /* ... */ }",
      lua: 'if ctx.isGrounded() and ctx.input.justPressed("jump") then end',
    },
  },
  {
    path: 'destroySelf',
    kind: 'method',
    signature: 'destroySelf(): void',
    description: 'Remove this entity from the scene.',
    example: { js: 'ctx.destroySelf()', lua: 'ctx.destroySelf()' },
  },
];
