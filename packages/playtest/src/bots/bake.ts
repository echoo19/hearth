/**
 * bakeBotRun — freezes one bot run into scripted playtest steps.
 *
 * Re-runs the exact (policy, seed) deterministically, then compresses the
 * recorded input timeline into the minimal `setAction`/`setAxis`/`setPointer`/
 * `wait` sequence that replays it bit-for-bit, and appends assertions derived
 * from the run's objectives (always closing with `assertNoErrors`).
 *
 * Frame accounting is the delicate part. The recorder tags each event with the
 * frame it was applied on (before that frame's step). In the scripted executor
 * `frames: 0` applies an input without advancing, and `frames: n` applies then
 * advances n. So within a frame every event is applied with `frames: 0`, and
 * the last event before a gap absorbs the gap's first frame (`frames: 1`), with
 * any remainder emitted as a `wait`. A final `wait` pads out to endFrame.
 */
import { resolveAvatar } from './avatar.js';
import { runBotRun } from './run.js';
import type { BotRunConfig, InputEvent } from './types.js';
import type { BakeParams, Objective, ProjectStore } from '@hearth/core';
import { GameSession, type SceneRuntime } from '@hearth/runtime';

/** stuckAfter for bake re-runs — the sweepScene default, so a default sweep reproduces exactly. */
const DEFAULT_STUCK_AFTER = 180;

export async function bakeBotRun(
  store: ProjectStore,
  params: BakeParams,
): Promise<{ steps: unknown[]; seed: number }> {
  const config: BotRunConfig = {
    scene: params.scene,
    policy: params.policy,
    seed: params.seed,
    maxFrames: params.maxFrames,
    stuckAfter: DEFAULT_STUCK_AFTER,
    avatar: params.avatar,
    target: params.target,
    objectives: params.objectives,
  };

  const result = await runBotRun(store, config);

  // A fresh session for resolving the avatar name and any entity-ref targets
  // (read at the run's starting state — right for the common static target).
  const session = await GameSession.create(store, { scene: params.scene, seed: params.seed });
  const avatarId = await resolveAvatar(store, session, params.avatar);
  const avatarName = avatarId ? (session.runtime.find(avatarId)?.name ?? avatarId) : null;
  const assertions = deriveAssertions(params.objectives, session.runtime, avatarName);
  session.destroy();

  const steps = [...compressTimeline(result.timeline, result.endFrame), ...assertions];
  return { steps, seed: result.seed };
}

/**
 * Compress a recorded input timeline into scripted steps that replay it
 * bit-for-bit. See the frame-accounting note atop this file.
 */
export function compressTimeline(timeline: InputEvent[], endFrame: number): unknown[] {
  const steps: unknown[] = [];
  if (timeline.length === 0) {
    if (endFrame > 0) steps.push({ type: 'wait', frames: endFrame });
    return steps;
  }

  let cursor = 0; // replay frame position reached so far
  let i = 0;
  while (i < timeline.length) {
    const frame = timeline[i].frame;
    // Advance to this frame if a leading gap wasn't absorbed by a prior event.
    if (frame > cursor) {
      steps.push({ type: 'wait', frames: frame - cursor });
      cursor = frame;
    }
    // Gather every event applied on this frame, in recorded order.
    let j = i;
    while (j < timeline.length && timeline[j].frame === frame) j++;
    const group = timeline.slice(i, j);

    const nextFrame = j < timeline.length ? timeline[j].frame : endFrame;
    const gap = nextFrame - frame; // frames to advance after this group

    for (let k = 0; k < group.length; k++) {
      const isLast = k === group.length - 1;
      const absorb = isLast && gap > 0 ? 1 : 0;
      steps.push(eventToStep(group[k], absorb));
    }

    if (gap > 0) {
      cursor = frame + 1; // the last event absorbed one frame
      const remaining = gap - 1;
      if (remaining > 0) {
        steps.push({ type: 'wait', frames: remaining });
        cursor = nextFrame;
      }
    }
    i = j;
  }

  if (cursor < endFrame) steps.push({ type: 'wait', frames: endFrame - cursor });
  return steps;
}

/** One recorded input → its scripted step, advancing `frames` after applying. */
function eventToStep(event: InputEvent, frames: number): unknown {
  switch (event.kind) {
    case 'action':
      return { type: 'setAction', action: event.action, down: event.down, frames };
    case 'axis':
      return { type: 'setAxis', axis: event.axis, value: event.value, frames };
    case 'pointer': {
      const step: { type: 'setPointer'; x: number; y: number; frames: number; down?: boolean } = {
        type: 'setPointer',
        x: event.x,
        y: event.y,
        frames,
      };
      if (event.button === 'down') step.down = true;
      else if (event.button === 'up') step.down = false;
      return step;
    }
  }
}

/**
 * Turn declared objectives into closing assertions: reach→assertPositionNear,
 * survive→assertEntityExists, event→assertEventCount, property→assertProperty,
 * always assertNoErrors last. Entity-less objectives target the avatar; an
 * objective that can't be resolved to a concrete assertion is skipped.
 */
function deriveAssertions(
  objectives: Objective[],
  runtime: SceneRuntime,
  avatarName: string | null,
): unknown[] {
  const steps: unknown[] = [];
  for (const objective of objectives) {
    switch (objective.type) {
      case 'reach': {
        const entity = objective.entity ?? avatarName;
        if (!entity) break;
        const point = resolveTargetPoint(objective.target, runtime);
        if (!point) break;
        steps.push({
          type: 'assertPositionNear',
          entity,
          x: point.x,
          y: point.y,
          tolerance: objective.tolerance,
        });
        break;
      }
      case 'survive': {
        const entity = objective.entity ?? avatarName;
        if (!entity) break;
        steps.push({ type: 'assertEntityExists', entity, exists: true });
        break;
      }
      case 'event':
        steps.push({ type: 'assertEventCount', event: objective.event, min: objective.count });
        break;
      case 'property': {
        const step: {
          type: 'assertProperty';
          entity: string;
          property: string;
          equals?: unknown;
          greaterThan?: number;
          lessThan?: number;
        } = { type: 'assertProperty', entity: objective.entity, property: objective.property };
        if (objective.equals !== undefined) step.equals = objective.equals;
        if (objective.greaterThan !== undefined) step.greaterThan = objective.greaterThan;
        if (objective.lessThan !== undefined) step.lessThan = objective.lessThan;
        steps.push(step);
        break;
      }
    }
  }
  steps.push({ type: 'assertNoErrors' });
  return steps;
}

function resolveTargetPoint(
  target: string | { x: number; y: number },
  runtime: SceneRuntime,
): { x: number; y: number } | null {
  if (typeof target !== 'string') return target;
  const entity = runtime.find(target);
  if (!entity) return null;
  return runtime.getWorldPosition(entity);
}
