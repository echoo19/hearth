/**
 * sealed-region — walkable floor the player can never stand on.
 *
 * Flood-fill from the avatar's spawn cell over the nav grid and compare against
 * every non-solid cell. A large difference means the level has a pocket that is
 * walkable but disconnected: a door that was never cut, a room whose only
 * entrance is a wall, a platform with no route to it.
 *
 * Static geometry only, and the finding says so — a region a door, teleport, or
 * moving platform opens at runtime is a legitimate false positive, which is why
 * this is an issue rather than a blocker.
 */
import type { Finding } from '../contract.js';
import { analyzeReachability, type ReachabilityReport } from '../reachability.js';
import { BaseDetector, type CapabilityKey, type DetectorInit, type ProbeSample } from './types.js';

export class SealedRegionDetector extends BaseDetector {
  readonly kind = 'sealed-region';
  readonly requires: readonly CapabilityKey[] = ['nav', 'entities'];
  private report: ReachabilityReport | null = null;

  protected onStart(init: DetectorInit): void {
    if (!init.navGrid) return;
    this.report = analyzeReachability(init.navGrid, init.spawn, { cellSize: init.config.cellSize });
  }

  observe(_sample: ProbeSample): void {
    // Static geometry: measured once at run start, nothing to accumulate.
  }

  finish(): Finding[] {
    const report = this.report;
    if (!report || report.walkable === 0) return [];
    const sealed = report.walkable - report.reachable;
    const ratio = sealed / report.walkable;
    if (sealed <= 0 || ratio <= this.config.sealedRatio) return [];
    const at = report.sealedSamples.map((s) => `(${s.x},${s.y})`).join(', ');
    return [
      {
        kind: 'sealed-region',
        severity: 'issue',
        summary: `${sealed} walkable cells (${Math.round(ratio * 100)}%) are sealed off from the avatar's spawn`,
        detail:
          `static geometry only — legitimate if a door, teleport, or moving platform opens the ` +
          `region at runtime. Sample sealed points: ${at}`,
        evidence: {
          sealedCells: sealed,
          walkable: report.walkable,
          reachable: report.reachable,
          samples: report.sealedSamples,
        },
      },
    ];
  }
}
