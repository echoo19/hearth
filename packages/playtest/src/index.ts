/**
 * @hearth/playtest — headless playtest execution.
 *
 * Runs playtest definitions (waits, scripted input presses, assertions)
 * against a SceneRuntime, and provides scene smoke runs. The exported
 * signatures are frozen — CLI and MCP server are built against them.
 */
import type { PlaytestStep, ProjectStore, RuntimeHooks } from '@hearth/core';
import { SceneRuntime, type RuntimeEntity } from '@hearth/runtime';

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
}

export interface SmokeResult {
  scene: string;
  sceneName: string;
  framesRun: number;
  entityCount: number;
  errors: RuntimeErrorEntry[];
  logs: RuntimeLogEntry[];
  audioEvents: AudioEventEntry[];
  /** True when the scene ran the requested frames with zero runtime errors. */
  passed: boolean;
}

const ASSERT_TYPES = new Set([
  'assertEntityExists',
  'assertProperty',
  'assertPositionNear',
  'assertNoErrors',
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
  });

  const playtest = store.getPlaytest(playtestIdOrName);
  if (!playtest) {
    return failEarly(`Playtest not found: ${playtestIdOrName}`);
  }

  let runtime: SceneRuntime;
  try {
    runtime = await SceneRuntime.create(store, playtest.scene);
  } catch (err) {
    return {
      ...failEarly(`Failed to start scene "${playtest.scene}": ${(err as Error).message}`),
      playtestId: playtest.id,
      name: playtest.name,
      scene: playtest.scene,
    };
  }

  /** Run up to `n` frames within the maxFrames cap; returns frames actually run. */
  const runFrames = (n: number): number => {
    const remaining = Math.max(0, playtest.maxFrames - runtime.frame);
    const toRun = Math.min(n, remaining);
    runtime.run(toRun);
    return toRun;
  };
  const atCap = () => runtime.frame >= playtest.maxFrames;

  const steps: PlaytestStepResult[] = [];
  for (let index = 0; index < playtest.steps.length; index++) {
    const step = playtest.steps[index];
    let result: PlaytestStepResult;
    try {
      result = executeStep(runtime, step, index, runFrames, atCap());
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
  return {
    passed,
    playtestId: playtest.id,
    name: playtest.name,
    scene: playtest.scene,
    framesRun: runtime.frame,
    steps,
    errors: [...runtime.errors],
    logs: [...runtime.logs],
    audioEvents: [...runtime.audioEvents],
  };
}

function executeStep(
  runtime: SceneRuntime,
  step: PlaytestStep,
  index: number,
  runFrames: (n: number) => number,
  wasAtCap: boolean,
): PlaytestStepResult {
  const capNote = wasAtCap && ASSERT_TYPES.has(step.type) ? ' (evaluated at maxFrames cap)' : '';

  switch (step.type) {
    case 'wait': {
      const ran = runFrames(step.frames);
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
      runtime.input.setActionDown(step.action);
      const ran = runFrames(step.frames);
      runtime.input.setActionUp(step.action);
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
      runtime.input.setActionUp(step.action);
      return { index, type: step.type, passed: true, message: `released "${step.action}"` };
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
      const passed = runtime.errors.length === 0;
      return {
        index,
        type: step.type,
        passed,
        message: passed
          ? `no runtime errors${capNote}`
          : `${runtime.errors.length} runtime error(s); first: ${runtime.errors[0].message}${capNote}`,
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
      passed: false,
    };
  }
  const runtime = await SceneRuntime.create(store, scene.id);
  runtime.run(frames);
  return {
    scene: scene.id,
    sceneName: scene.name,
    framesRun: runtime.frame,
    entityCount: runtime.getEntities().length,
    errors: [...runtime.errors],
    logs: [...runtime.logs],
    audioEvents: [...runtime.audioEvents],
    passed: runtime.errors.length === 0,
  };
}

/** Runtime hooks to inject into HearthSession so core commands can run playtests. */
export function createRuntimeHooks(): RuntimeHooks {
  return {
    runPlaytest: (store, id) => runPlaytest(store, id),
    runSceneSmoke: (store, scene, frames) => runSceneSmoke(store, scene, frames),
  };
}

// ---------------------------------------------------------------------------

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
