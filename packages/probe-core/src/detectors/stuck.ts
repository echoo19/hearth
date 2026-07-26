/**
 * stuck — the novelty drought.
 *
 * The sweep's CoverageTracker answers "did anything new happen this step?" from
 * whatever senses exist (entity cells, de-noised frame hashes, scenes, first-of-
 * a-kind events). This detector only watches the clock on that answer: N steps
 * with nothing new and the run is stuck.
 *
 * Two honesty rules:
 * - `idle` is exempt. A policy that injects no input cannot be "stuck" — nothing
 *   was tried. Its job is catching games that break when the player does nothing,
 *   which shows up as errors and unmet objectives, not as a stall.
 * - With no sense that can ever produce novelty, the detector skips rather than
 *   declaring every run stuck.
 */
import type { ProbeCapabilities, ProbeInstant, Verdict } from '../contract.js';
import { BaseDetector, type CapabilityKey, type DetectorInit, type ProbeSample } from './types.js';

/** Policies that inject no input, and so can never be judged stuck. */
export const NO_INPUT_POLICIES = new Set(['idle']);

export class StuckDetector extends BaseDetector {
  readonly kind = 'stuck';
  readonly requires: readonly CapabilityKey[] = [];
  private stuckAt: ProbeInstant | null = null;
  private stuckAfter = 180;

  unavailable(capabilities: ProbeCapabilities, policy: string): string | null {
    if (NO_INPUT_POLICIES.has(policy)) {
      return `policy "${policy}" injects no input, so a stall means nothing was tried`;
    }
    const { entities, screenshot, scenes, events } = capabilities.senses;
    if (!entities && !screenshot && !scenes && !events) {
      return 'no sense that can show progress (needs entities, screenshots, scenes, or events)';
    }
    return null;
  }

  protected onStart(init: DetectorInit): void {
    this.stuckAfter = init.config.stuckAfter;
  }

  /** The instant the drought crossed the threshold, or null. */
  get stuckInstant(): ProbeInstant | null {
    return this.stuckAt;
  }

  observe(sample: ProbeSample): void {
    if (this.stuckAt !== null) return;
    if (sample.framesSinceNovelty >= this.stuckAfter) this.stuckAt = sample.instant;
  }

  verdict(): Verdict | null {
    return this.stuckAt === null ? null : 'stuck';
  }
}
