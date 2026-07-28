/**
 * wall-bump — the bot is pushing, the geometry is not giving.
 *
 * A generic "stuck" says nothing about why. This says something specific: while
 * the steering policy held a direction, the avatar's displacement ALONG that
 * direction stayed at zero, and it happened inside a stretch where nothing new
 * was happening. That is the player pressed against an invisible wall, a ledge
 * they cannot climb, or a collider that should not be there.
 *
 * Only steering policies (wander, seek) expose an intent, so this stays quiet
 * for mash and idle rather than guessing what they meant to do. Severity is a
 * note: level geometry that blocks a bot is often correct.
 */
import type { Finding, ProbeInstant } from '../contract.js';
import { BaseDetector, type CapabilityKey, type ProbeSample } from './types.js';

export class WallBumpDetector extends BaseDetector {
  readonly kind = 'wall-bump';
  readonly requires: readonly CapabilityKey[] = ['entities'];
  private last: { x: number; y: number } | null = null;
  private blocked = 0;
  private flagged: {
    at: ProbeInstant;
    steps: number;
    intent: { dx: number; dy: number };
    where: { x: number; y: number };
  } | null = null;

  observe(sample: ProbeSample): void {
    const avatar = sample.avatar;
    if (!avatar) {
      this.last = null;
      return;
    }
    const previous = this.last;
    this.last = { x: avatar.x, y: avatar.y };
    if (this.flagged || !previous || !sample.intent) {
      if (!sample.intent) this.blocked = 0;
      return;
    }
    // Progress is only measured along the direction the bot asked for: sliding
    // sideways along a wall is not arriving anywhere it wanted to go.
    const along = (avatar.x - previous.x) * sample.intent.dx + (avatar.y - previous.y) * sample.intent.dy;
    const stalling = sample.framesSinceNovelty > 0;
    if (!stalling || along > this.config.wallBumpEpsilon) {
      this.blocked = 0;
      return;
    }
    this.blocked++;
    if (this.blocked >= this.config.wallBumpWindow) {
      this.flagged = {
        at: sample.instant,
        steps: this.blocked,
        intent: sample.intent,
        where: { x: Math.round(avatar.x), y: Math.round(avatar.y) },
      };
    }
  }

  finish(): Finding[] {
    if (!this.flagged) return [];
    const { intent, where, steps, at } = this.flagged;
    const heading = `(${intent.dx.toFixed(2)}, ${intent.dy.toFixed(2)})`;
    return [
      {
        kind: 'wall-bump',
        severity: 'note',
        summary: `the avatar pushed ${heading} for ${steps} steps at (${where.x}, ${where.y}) and went nowhere`,
        detail:
          `held a steering direction through a stretch with no progress and gained no ground along it: ` +
          `an unintended barrier, or a spot the walking bot cannot get past`,
        at,
        evidence: { steps, intent, position: where },
      },
    ];
  }
}
