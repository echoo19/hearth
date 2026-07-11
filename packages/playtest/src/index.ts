/**
 * @hearth/playtest — headless playtest execution.
 *
 * Runs playtest definitions (waits, scripted input presses, pointer clicks,
 * assertions) against a GameSession, and provides scene smoke runs. Frames
 * advance via stepAsync so ctx.scenes.load switches complete
 * deterministically between frames. The exported signatures are frozen —
 * CLI and MCP server are built against them.
 */
import type { PlaytestStep, ProjectStore, RuntimeHooks } from '@hearth/core';
import {
  GameSession,
  type CameraEffectRecord,
  type RuntimeEntity,
  type SceneRuntime,
} from '@hearth/runtime';

export interface PlaytestStepResult {
  index: number;
  type: string;
  passed: boolean;
  message?: string;
}

export interface RuntimeErrorEntry {
  frame: number;
  message: string;
  entity?: string;
  script?: string;
  phase?: string;
}

export interface RuntimeLogEntry {
  frame: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** One audio play/stop recorded by the headless runtime. */
export interface AudioEventEntry {
  frame: number;
  assetId: string;
  action: 'play' | 'stop';
}

/** One completed scene switch (session-monotonic frame numbers). */
export interface SceneEventEntry {
  frame: number;
  from: string | null;
  to: string;
}

export interface PlaytestResult {
  passed: boolean;
  playtestId: string;
  name: string;
  scene: string;
  framesRun: number;
  steps: PlaytestStepResult[];
  errors: RuntimeErrorEntry[];
  logs: RuntimeLogEntry[];
  audioEvents: AudioEventEntry[];
  sceneEvents: SceneEventEntry[];
  /** Scene id the session ended in (after any ctx.scenes.load switches). */
  finalScene: string;
  /** Live particle count at end of run, by entity name; only ParticleEmitter entities appear. */
  particleCounts: Record<string, number>;
  /** Emitted events recorded during the run. */
  events: { frame: number; name: string; data?: unknown }[];
  /** Total count of emitted events by name. */
  eventCounts: Record<string, number>;
  /** ctx.camera.shake/flash/fade/zoomPunch calls recorded during the run. */
  cameraEffects: CameraEffectRecord[];
  /** Final combined camera overlay alpha (flash pulse over persistent fade level) at end of run. */
  cameraOverlayAlpha: number;
  /** ctx.ui focus at end of run: entity name if resolvable, else id, else null when nothing is focused. */
  focusedEntity: string | null;
  /** Active post-effect types (Camera.postEffects) on the main camera at end of run. */
  postEffects: string[];
}

export interface SmokeResult {
  scene: string;
  sceneName: string;
  framesRun: number;
  entityCount: number;
  errors: RuntimeErrorEntry[];
  logs: RuntimeLogEntry[];
  audioEvents: AudioEventEntry[];
  sceneEvents: SceneEventEntry[];
  /** Scene id the session ended in (after any ctx.scenes.load switches). */
  finalScene: string;
  /** True when the scene ran the requested frames with zero runtime errors. */
  passed: boolean;
  /** Live particle count at end of run, by entity name; only ParticleEmitter entities appear. */
  particleCounts: Record<string, number>;
  /** Emitted events recorded during the run. */
  events: { frame: number; name: string; data?: unknown }[];
  /** Total count of emitted events by name. */
  eventCounts: Record<string, number>;
  /** ctx.camera.shake/flash/fade/zoomPunch calls recorded during the run. */
  cameraEffects: CameraEffectRecord[];
  /** Final combined camera overlay alpha (flash pulse over persistent fade level) at end of run. */
  cameraOverlayAlpha: number;
  /** Active post-effect types (Camera.postEffects) on the main camera at end of run. */
  postEffects: string[];
}

const ASSERT_TYPES = new Set([
  'assertEntityExists',
  'assertProperty',
  'assertPositionNear',
  'assertNoErrors',
  'assertScene',
  'assertParticleCount',
  'assertEventCount',
  'assertAudioCount',
  'assertCameraEffect',
  'assertFocus',
  'assertPostEffect',
]);

export async function runPlaytest(
  store: ProjectStore,
  playtestIdOrName: string,
): Promise<PlaytestResult> {
  const failEarly = (message: string): PlaytestResult => ({
    passed: false,
    playtestId: playtestIdOrName,
    name: playtestIdOrName,
    scene: '',
    framesRun: 0,
    steps: [{ index: 0, type: 'load', passed: false, message }],
    errors: [],
    logs: [],
    audioEvents: [],
    sceneEvents: [],
    finalScene: '',
    particleCounts: {},
    events: [],
    eventCounts: {},
    cameraEffects: [],
    cameraOverlayAlpha: 0,
    focusedEntity: null,
    postEffects: [],
  });

  const playtest = store.getPlaytest(playtestIdOrName);
  if (!playtest) {
    return failEarly(`Playtest not found: ${playtestIdOrName}`);
  }

  let session: GameSession;
  try {
    session = await GameSession.create(store, { scene: playtest.scene, seed: playtest.seed });
  } catch (err) {
    return {
      ...failEarly(`Failed to start scene "${playtest.scene}": ${(err as Error).message}`),
      playtestId: playtest.id,
      name: playtest.name,
      scene: playtest.scene,
    };
  }

  /** Run up to `n` frames within the maxFrames cap; returns frames actually run. */
  const runFrames = async (n: number): Promise<number> => {
    const remaining = Math.max(0, playtest.maxFrames - session.frame);
    const toRun = Math.min(n, remaining);
    for (let i = 0; i < toRun; i++) await session.stepAsync();
    return toRun;
  };
  const atCap = () => session.frame >= playtest.maxFrames;

  const steps: PlaytestStepResult[] = [];
  for (let index = 0; index < playtest.steps.length; index++) {
    const step = playtest.steps[index];
    let result: PlaytestStepResult;
    try {
      result = await executeStep(session, store, step, index, runFrames, atCap());
    } catch (err) {
      result = {
        index,
        type: step.type,
        passed: false,
        message: `step threw: ${(err as Error).message}`,
      };
    }
    steps.push(result);
  }

  // Non-assert steps only fail when they throw, so this is exactly
  // "all asserts passed and no step errored".
  const passed = steps.every((s) => s.passed);
  const result: PlaytestResult = {
    passed,
    playtestId: playtest.id,
    name: playtest.name,
    scene: playtest.scene,
    framesRun: session.frame,
    steps,
    errors: [...session.errors],
    logs: [...session.logs],
    audioEvents: [...session.audioEvents],
    sceneEvents: [...session.sceneEvents],
    finalScene: session.currentSceneId,
    particleCounts: collectParticleCounts(session.runtime),
    events: [...session.events],
    eventCounts: Object.fromEntries(session.eventCounts),
    cameraEffects: [...session.cameraEffects],
    cameraOverlayAlpha: session.runtime.cameraEffects.overlay.alpha,
    focusedEntity: resolveFocusedEntity(session.runtime),
    postEffects: session.runtime.camera.postEffects.map((e) => e.type),
  };
  session.destroy();
  return result;
}

async function executeStep(
  session: GameSession,
  store: ProjectStore,
  step: PlaytestStep,
  index: number,
  runFrames: (n: number) => Promise<number>,
  wasAtCap: boolean,
): Promise<PlaytestStepResult> {
  const capNote = wasAtCap && ASSERT_TYPES.has(step.type) ? ' (evaluated at maxFrames cap)' : '';
  const runtime = session.runtime;

  switch (step.type) {
    case 'wait': {
      const ran = await runFrames(step.frames);
      return {
        index,
        type: step.type,
        passed: true,
        message:
          ran < step.frames
            ? `ran ${ran}/${step.frames} frames (maxFrames cap reached)`
            : `waited ${ran} frames`,
      };
    }
    case 'press': {
      session.runtime.input.setActionDown(step.action);
      const ran = await runFrames(step.frames);
      session.runtime.input.setActionUp(step.action);
      return {
        index,
        type: step.type,
        passed: true,
        message:
          ran < step.frames
            ? `pressed "${step.action}" for ${ran}/${step.frames} frames (maxFrames cap reached)`
            : `pressed "${step.action}" for ${ran} frames`,
      };
    }
    case 'release': {
      session.runtime.input.setActionUp(step.action);
      return { index, type: step.type, passed: true, message: `released "${step.action}"` };
    }
    case 'setAxis': {
      session.runtime.input.setAxis(step.axis, step.value);
      const frames = step.frames ?? 1;
      const ran = await runFrames(frames);
      return {
        index,
        type: step.type,
        passed: true,
        message:
          ran < frames
            ? `set axis "${step.axis}" to ${step.value} for ${ran}/${frames} frames (maxFrames cap reached)`
            : `set axis "${step.axis}" to ${step.value} for ${ran} frames`,
      };
    }
    case 'click': {
      const target = session.runtime;
      target.sendPointer(step.x, step.y, 'move');
      target.sendPointer(step.x, step.y, 'down');
      target.sendPointer(step.x, step.y, 'up');
      const ran = await runFrames(1);
      return {
        index,
        type: step.type,
        passed: true,
        message:
          ran < 1
            ? `clicked (${step.x}, ${step.y}) (maxFrames cap reached before follow-up frame)`
            : `clicked (${step.x}, ${step.y})`,
      };
    }
    case 'drag': {
      const target = session.runtime;
      const frames = step.frames ?? 5;
      const totalRequested = frames + 2; // down + interpolated moves + up
      let ranTotal = 0;

      target.sendPointer(step.from.x, step.from.y, 'down');
      ranTotal += await runFrames(1);

      for (let i = 1; i <= frames; i++) {
        const t = i / frames;
        const x = step.from.x + (step.to.x - step.from.x) * t;
        const y = step.from.y + (step.to.y - step.from.y) * t;
        target.sendPointer(x, y, 'move');
        ranTotal += await runFrames(1);
      }

      target.sendPointer(step.to.x, step.to.y, 'up');
      ranTotal += await runFrames(1);

      const desc = `dragged (${step.from.x}, ${step.from.y}) -> (${step.to.x}, ${step.to.y})`;
      return {
        index,
        type: step.type,
        passed: true,
        message:
          ranTotal < totalRequested
            ? `${desc} for ${ranTotal}/${totalRequested} frames (maxFrames cap reached)`
            : desc,
      };
    }
    case 'assertEntityExists': {
      const found = runtime.find(step.entity) !== undefined;
      const passed = found === step.exists;
      return {
        index,
        type: step.type,
        passed,
        message: passed
          ? `entity "${step.entity}" ${found ? 'exists' : 'does not exist'} as expected${capNote}`
          : `expected entity "${step.entity}" to ${step.exists ? 'exist' : 'not exist'}, but it ${found ? 'exists' : 'does not'}${capNote}`,
      };
    }
    case 'assertProperty': {
      const entity = runtime.find(step.entity);
      if (!entity) {
        return {
          index,
          type: step.type,
          passed: false,
          message: `entity not found: ${step.entity}${capNote}`,
        };
      }
      const resolved = resolvePropertyPath(entity, step.property);
      if (!resolved.found) {
        return {
          index,
          type: step.type,
          passed: false,
          message: `property not found on "${step.entity}": ${step.property}${capNote}`,
        };
      }
      const value = resolved.value;
      const failures: string[] = [];
      let checked = false;
      if (step.equals !== undefined) {
        checked = true;
        if (!looseEquals(value, step.equals)) {
          failures.push(`expected ${stringify(step.equals)}, got ${stringify(value)}`);
        }
      }
      if (step.greaterThan !== undefined) {
        checked = true;
        if (typeof value !== 'number' || !(value > step.greaterThan)) {
          failures.push(`expected > ${step.greaterThan}, got ${stringify(value)}`);
        }
      }
      if (step.lessThan !== undefined) {
        checked = true;
        if (typeof value !== 'number' || !(value < step.lessThan)) {
          failures.push(`expected < ${step.lessThan}, got ${stringify(value)}`);
        }
      }
      if (!checked) {
        return {
          index,
          type: step.type,
          passed: false,
          message: `assertProperty needs equals, greaterThan, or lessThan${capNote}`,
        };
      }
      const passed = failures.length === 0;
      return {
        index,
        type: step.type,
        passed,
        message: passed
          ? `${step.entity}.${step.property} = ${stringify(value)}${capNote}`
          : `${step.entity}.${step.property}: ${failures.join('; ')}${capNote}`,
      };
    }
    case 'assertPositionNear': {
      const entity = runtime.find(step.entity);
      if (!entity) {
        return {
          index,
          type: step.type,
          passed: false,
          message: `entity not found: ${step.entity}${capNote}`,
        };
      }
      const pos = entity.transform.position;
      const distance = Math.hypot(pos.x - step.x, pos.y - step.y);
      const passed = distance <= step.tolerance;
      return {
        index,
        type: step.type,
        passed,
        message: `${step.entity} at (${round(pos.x)}, ${round(pos.y)}), ${passed ? 'within' : 'outside'} ${step.tolerance}px of (${step.x}, ${step.y})${capNote}`,
      };
    }
    case 'assertNoErrors': {
      const passed = session.errors.length === 0;
      return {
        index,
        type: step.type,
        passed,
        message: passed
          ? `no runtime errors${capNote}`
          : `${session.errors.length} runtime error(s); first: ${session.errors[0].message}${capNote}`,
      };
    }
    case 'assertScene': {
      const currentId = session.currentSceneId;
      const currentName = store.getScene(currentId)?.name;
      const passed = currentId === step.scene || currentName === step.scene;
      return {
        index,
        type: step.type,
        passed,
        message: passed
          ? `current scene is "${step.scene}"${capNote}`
          : `expected scene "${step.scene}", but current scene is "${currentName ?? currentId}" (${currentId})${capNote}`,
      };
    }
    case 'assertParticleCount': {
      const entity = runtime.find(step.entity);
      if (!entity) {
        return {
          index,
          type: step.type,
          passed: false,
          message: `entity not found: ${step.entity}${capNote}`,
        };
      }
      if (!entity.components.ParticleEmitter) {
        // Without this, an entity with no ParticleEmitter always reads
        // getParticleCount() === 0, so e.g. `max: 5` (or any bound that 0
        // satisfies) would pass vacuously — a typo'd entity name silently
        // proving nothing instead of failing loudly.
        return {
          index,
          type: step.type,
          passed: false,
          message: `${step.entity} has no ParticleEmitter component${capNote}`,
        };
      }
      const count = runtime.getParticleCount(entity.id);
      const failures: string[] = [];
      if (step.equals !== undefined && count !== step.equals) {
        failures.push(`expected ${step.equals}, got ${count}`);
      }
      if (step.min !== undefined && count < step.min) {
        failures.push(`expected >= ${step.min}, got ${count}`);
      }
      if (step.max !== undefined && count > step.max) {
        failures.push(`expected <= ${step.max}, got ${count}`);
      }
      const passed = failures.length === 0;
      return {
        index,
        type: step.type,
        passed,
        message: passed
          ? `${step.entity} particle count = ${count}${capNote}`
          : `${step.entity} particle count: ${failures.join('; ')}${capNote}`,
      };
    }
    case 'assertEventCount': {
      const count = session.eventCounts.get(step.event) ?? 0;
      const failures: string[] = [];
      if (step.equals !== undefined && count !== step.equals) failures.push(`expected exactly ${step.equals}`);
      if (step.min !== undefined && count < step.min) failures.push(`expected at least ${step.min}`);
      if (step.max !== undefined && count > step.max) failures.push(`expected at most ${step.max}`);
      const passed = failures.length === 0;
      return {
        index, type: step.type, passed,
        message: passed
          ? `event "${step.event}" count ${count} OK${capNote}`
          : `event "${step.event}" count ${count}: ${failures.join(', ')}${capNote}`,
      };
    }
    case 'assertAudioCount': {
      // Resolve asset if provided.
      let resolvedAssetId: string | undefined;
      if (step.asset !== undefined) {
        const asset = store.getAsset(step.asset);
        if (!asset) {
          return {
            index,
            type: step.type,
            passed: false,
            message: `assertAudioCount: asset not found: ${step.asset}${capNote}`,
          };
        }
        resolvedAssetId = asset.id;
      }

      // Count matching audioEvents.
      const count = session.audioEvents.filter((ev) => {
        if (resolvedAssetId !== undefined && ev.assetId !== resolvedAssetId) return false;
        if (step.action !== undefined && ev.action !== step.action) return false;
        if (step.music !== undefined && Boolean(ev.music) !== step.music) return false;
        return true;
      }).length;

      const failures: string[] = [];
      if (step.equals !== undefined && count !== step.equals) failures.push(`expected exactly ${step.equals}`);
      if (step.min !== undefined && count < step.min) failures.push(`expected at least ${step.min}`);
      if (step.max !== undefined && count > step.max) failures.push(`expected at most ${step.max}`);
      const passed = failures.length === 0;

      // Build the filter descriptor for the message.
      const filters: string[] = [];
      if (step.asset !== undefined) filters.push(`asset "${step.asset}"`);
      if (step.action !== undefined) filters.push(`action "${step.action}"`);
      if (step.music !== undefined) filters.push(`music ${step.music}`);
      const filterDesc = filters.length > 0 ? filters.join(', ') : 'audio';

      return {
        index, type: step.type, passed,
        message: passed
          ? `${filterDesc} count ${count} OK${capNote}`
          : `${filterDesc} count ${count}: ${failures.join(', ')}${capNote}`,
      };
    }
    case 'assertCameraEffect': {
      const count = session.cameraEffects.filter((rec) => rec.effect === step.effect).length;
      const failures: string[] = [];
      if (step.equals !== undefined && count !== step.equals) failures.push(`expected exactly ${step.equals}`);
      if (step.min !== undefined && count < step.min) failures.push(`expected at least ${step.min}`);
      if (step.max !== undefined && count > step.max) failures.push(`expected at most ${step.max}`);
      const passed = failures.length === 0;
      return {
        index, type: step.type, passed,
        message: passed
          ? `camera effect "${step.effect}" count ${count} OK${capNote}`
          : `camera effect "${step.effect}" count ${count}: ${failures.join(', ')}${capNote}`,
      };
    }
    case 'assertFocus': {
      const focusedId = runtime.getUiFocused();
      const focusedName = focusedId
        ? runtime.getEntities().find((e) => e.id === focusedId)?.name
        : undefined;
      const passed =
        step.entity === null
          ? focusedId === null
          : focusedId !== null && (focusedId === step.entity || focusedName === step.entity);
      const actualDesc = focusedId === null ? 'nothing' : `"${focusedName ?? focusedId}"`;
      return {
        index,
        type: step.type,
        passed,
        message: passed
          ? `${step.entity === null ? 'nothing' : `"${step.entity}"`} is focused${capNote}`
          : `expected ${step.entity === null ? 'nothing' : `"${step.entity}"`} focused, but ${actualDesc} is${capNote}`,
      };
    }
    case 'assertPostEffect': {
      const activeTypes = runtime.camera.postEffects.map((e) => e.type);
      const isActive = activeTypes.includes(step.effect);
      const wantActive = step.active ?? true;
      const passed = isActive === wantActive;
      const stackDesc = activeTypes.length > 0 ? `[${activeTypes.join(', ')}]` : '[]';
      return {
        index,
        type: step.type,
        passed,
        message: passed
          ? `postEffect "${step.effect}" ${wantActive ? 'active' : 'absent'} OK${capNote}`
          : `expected postEffect "${step.effect}" ${wantActive ? 'active' : 'absent'}, but stack is ${stackDesc}${capNote}`,
      };
    }
    default: {
      const unknown = step as { type: string };
      return {
        index,
        type: unknown.type,
        passed: false,
        message: `unknown step type: ${unknown.type}`,
      };
    }
  }
}

export async function runSceneSmoke(
  store: ProjectStore,
  sceneIdOrName: string,
  frames: number,
): Promise<SmokeResult> {
  const scene = store.getScene(sceneIdOrName);
  if (!scene) {
    return {
      scene: sceneIdOrName,
      sceneName: sceneIdOrName,
      framesRun: 0,
      entityCount: 0,
      errors: [{ frame: 0, message: `Scene not found: ${sceneIdOrName}` }],
      logs: [],
      audioEvents: [],
      sceneEvents: [],
      finalScene: '',
      passed: false,
      particleCounts: {},
      events: [],
      eventCounts: {},
      cameraEffects: [],
      cameraOverlayAlpha: 0,
      postEffects: [],
    };
  }
  const session = await GameSession.create(store, { scene: scene.id });
  for (let i = 0; i < frames; i++) await session.stepAsync();
  const result: SmokeResult = {
    scene: scene.id,
    sceneName: scene.name,
    framesRun: session.frame,
    entityCount: session.runtime.getEntities().length,
    errors: [...session.errors],
    logs: [...session.logs],
    audioEvents: [...session.audioEvents],
    sceneEvents: [...session.sceneEvents],
    finalScene: session.currentSceneId,
    passed: session.errors.length === 0,
    particleCounts: collectParticleCounts(session.runtime),
    events: [...session.events],
    eventCounts: Object.fromEntries(session.eventCounts),
    cameraEffects: [...session.cameraEffects],
    cameraOverlayAlpha: session.runtime.cameraEffects.overlay.alpha,
    postEffects: session.runtime.camera.postEffects.map((e) => e.type),
  };
  session.destroy();
  return result;
}

/** Runtime hooks to inject into HearthSession so core commands can run playtests. */
export function createRuntimeHooks(): RuntimeHooks {
  return {
    runPlaytest: (store, id) => runPlaytest(store, id),
    runSceneSmoke: (store, scene, frames) => runSceneSmoke(store, scene, frames),
  };
}

export {
  captureScreenshot,
  canLaunchChromium,
  injectBootScript,
  CHROMIUM_MISSING_ERROR,
  type ScreenshotOptions,
  type ScreenshotResult,
} from './screenshot.js';

// ---------------------------------------------------------------------------

/** Live particle count by entity name, for every live entity with a ParticleEmitter. */
function collectParticleCounts(runtime: SceneRuntime): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entity of runtime.getEntities()) {
    if (entity.components.ParticleEmitter) {
      counts[entity.name] = runtime.getParticleCount(entity.id);
    }
  }
  return counts;
}

/** ctx.ui focus at the end of a run: entity name if resolvable, else id, else null. */
function resolveFocusedEntity(runtime: SceneRuntime): string | null {
  const id = runtime.getUiFocused();
  if (!id) return null;
  const entity = runtime.getEntities().find((e) => e.id === id);
  return entity ? entity.name : id;
}

/** Resolve dot paths like "Transform.position.x" against entity.components. */
function resolvePropertyPath(
  entity: RuntimeEntity,
  path: string,
): { found: boolean; value?: unknown } {
  let current: unknown = entity.components;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
