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
} from './runtime.js';
export {
  compileScript,
  type ScriptHooks,
  type ScriptContext,
  type ScriptCollision,
  type EntityHandle,
  type SpawnDef,
} from './scripts.js';
export { GRAVITY, colliderBox, tilemapBoxes, computePush, type Box, type Push } from './physics.js';
