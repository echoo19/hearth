/**
 * @hearth/playtest — headless playtest execution.
 *
 * NOTE: This is the API contract stub; the real implementation lands with
 * the runtime package. Signatures here are frozen — CLI and MCP server are
 * built against them.
 */
import type { ProjectStore, RuntimeHooks } from '@hearth/core';

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

export interface PlaytestResult {
  passed: boolean;
  playtestId: string;
  name: string;
  scene: string;
  framesRun: number;
  steps: PlaytestStepResult[];
  errors: RuntimeErrorEntry[];
  logs: RuntimeLogEntry[];
}

export interface SmokeResult {
  scene: string;
  sceneName: string;
  framesRun: number;
  entityCount: number;
  errors: RuntimeErrorEntry[];
  logs: RuntimeLogEntry[];
  /** True when the scene ran the requested frames with zero runtime errors. */
  passed: boolean;
}

export async function runPlaytest(
  store: ProjectStore,
  playtestIdOrName: string,
): Promise<PlaytestResult> {
  throw new Error('playtest runtime not implemented yet');
}

export async function runSceneSmoke(
  store: ProjectStore,
  sceneIdOrName: string,
  frames: number,
): Promise<SmokeResult> {
  throw new Error('scene smoke runtime not implemented yet');
}

/** Runtime hooks to inject into HearthSession so core commands can run playtests. */
export function createRuntimeHooks(): RuntimeHooks {
  return {
    runPlaytest: (store, id) => runPlaytest(store, id),
    runSceneSmoke: (store, scene, frames) => runSceneSmoke(store, scene, frames),
  };
}
