/**
 * crash — the first unhandled error the game reports ends the run.
 *
 * Highest precedence of anything the probe can observe: a game that threw is not
 * "a bit stuck", it is broken, and everything measured after the throw is
 * measuring a corpse. The detector records the first error only; later errors
 * are usually cascade noise from the same root cause.
 */
import type { Finding, ProbeError, Verdict } from '../contract.js';
import { BaseDetector, type CapabilityKey, type ProbeSample } from './types.js';

export class CrashDetector extends BaseDetector {
  readonly kind = 'crash';
  readonly requires: readonly CapabilityKey[] = ['errors'];
  private first: ProbeError | null = null;
  private shot: string | undefined;

  /** The error that ended the run, for the RunResult. */
  get firstError(): ProbeError | null {
    return this.first;
  }

  observe(sample: ProbeSample): void {
    if (this.first !== null || sample.obs.newErrors.length === 0) return;
    this.first = sample.obs.newErrors[0];
    this.shot = sample.shot;
  }

  verdict(): Verdict | null {
    return this.first === null ? null : 'error';
  }

  finish(): Finding[] {
    if (this.first === null) return [];
    const where = this.first.where ? ` (${this.first.where})` : '';
    return [
      {
        kind: 'crash',
        severity: 'blocker',
        summary: `game threw: ${this.first.message}${where}`,
        detail: `first unhandled error at step ${this.first.at.frame}; the run stopped there`,
        at: this.first.at,
        ...(this.shot ? { shot: this.shot } : {}),
        evidence: { message: this.first.message, ...(this.first.where ? { where: this.first.where } : {}) },
      },
    ];
  }
}
