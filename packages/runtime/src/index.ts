/**
 * @hearth/runtime — the Hearth 2D runtime.
 *
 * Headless-safe entry point: scene instantiation, fixed-timestep loop,
 * input, physics/collision, and script execution. Works in Node and the
 * browser. Rendering (PixiJS) lives in the `@hearth/runtime/pixi` subpath
 * so importing this module never touches the DOM.
 */
export { InputState } from './input.js';
export {
  SceneRuntime,
  type RuntimeLog,
  type RuntimeError,
  type RuntimeOptions,
  type RuntimeEntity,
  type RuntimeCollision,
  type AudioEvent,
  type AudioPlaybackEvent,
  type PointerKind,
} from './runtime.js';
export {
  LuaScriptEngine,
  isLuaPath,
  setLuaWasmUri,
  type LuaEngineOptions,
} from './lua.js';
export {
  GameSession,
  MemorySessionStorage,
  type GameSessionOptions,
  type SceneEvent,
  type SessionStorage,
} from './session.js';
export {
  createRng,
  EASINGS,
  EntityScheduler,
  resolveNumericTarget,
  type EasingName,
} from './stdlib.js';
export {
  compileScript,
  type ScriptHooks,
  type ScriptContext,
  type ScriptCollision,
  type EntityHandle,
  type SpawnDef,
  type UiEvent,
} from './scripts.js';
export {
  GRAVITY,
  colliderBox,
  colliderShape,
  tilemapBoxes,
  computePush,
  computeShapePush,
  translateShape,
  type Box,
  type Push,
  type CollisionShape,
} from './physics.js';
export {
  anchorPoint,
  uiScreenPosition,
  uiElementRect,
  measureText,
  type UiRect,
} from './ui.js';
