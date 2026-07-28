/**
 * black-screen — the game is rendering nothing.
 *
 * A frame that is both very dark AND very flat is a blank canvas: a fade that
 * never lifted, an asset load that failed, a render loop that died. Darkness
 * alone is not enough (a night level is dark but full of structure), so the
 * variance test is what keeps this from crying wolf — a real scene has spread.
 *
 * Sustained over a window, because a one-frame black flash between scenes is
 * normal. Screenshots are sampled every N steps, so the window is measured in
 * run steps, not in samples.
 */
import type { Finding, ProbeInstant } from '../contract.js';
import { luminanceStats } from '../imageHash.js';
import { BaseDetector, type CapabilityKey, type ProbeSample } from './types.js';

export class BlackScreenDetector extends BaseDetector {
  readonly kind = 'black-screen';
  readonly requires: readonly CapabilityKey[] = ['screenshot'];
  private darkSince: ProbeInstant | null = null;
  private flagged: { at: ProbeInstant; since: ProbeInstant; mean: number; shot?: string } | null = null;

  observe(sample: ProbeSample): void {
    if (!sample.image || this.flagged) return;
    const { mean, variance } = luminanceStats(sample.image);
    const dark = mean < this.config.blackScreenLuma && variance < this.config.blackScreenVariance;
    if (!dark) {
      this.darkSince = null;
      return;
    }
    if (this.darkSince === null) {
      this.darkSince = sample.instant;
      return;
    }
    if (sample.instant.frame - this.darkSince.frame >= this.config.blackScreenSteps) {
      this.flagged = {
        at: sample.instant,
        since: this.darkSince,
        mean,
        ...(sample.shot ? { shot: sample.shot } : {}),
      };
    }
  }

  finish(): Finding[] {
    if (!this.flagged) return [];
    const span = this.flagged.at.frame - this.flagged.since.frame;
    return [
      {
        kind: 'black-screen',
        severity: 'blocker',
        summary: `the screen was blank for ${span} steps from step ${this.flagged.since.frame}`,
        detail:
          `mean luminance ${this.flagged.mean.toFixed(3)} with near-zero variance: ` +
          `nothing is being drawn (a fade that never lifted, a failed load, or a dead render loop)`,
        at: this.flagged.at,
        ...(this.flagged.shot ? { shot: this.flagged.shot } : {}),
        evidence: { meanLuminance: Number(this.flagged.mean.toFixed(4)), steps: span },
      },
    ];
  }
}
