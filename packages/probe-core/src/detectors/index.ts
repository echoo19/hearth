/**
 * The detector set, and the gate every detector passes through.
 *
 * `buildDetectors` is the single place where "this game cannot be checked for X"
 * turns into a SkippedDetector instead of silence. Nothing else in the sweep is
 * allowed to decide a detector does not apply.
 */
import type { ProbeCapabilities, SkippedDetector } from '../contract.js';
import { BlackScreenDetector } from './blackScreen.js';
import { CrashDetector } from './crash.js';
import { SealedRegionDetector } from './sealedRegion.js';
import { StuckDetector } from './stuck.js';
import { WallBumpDetector } from './wallBump.js';
import { SENSE_LABEL, type Detector, type DetectorInit } from './types.js';

export * from './types.js';
export { BlackScreenDetector } from './blackScreen.js';
export { CrashDetector } from './crash.js';
export { SealedRegionDetector } from './sealedRegion.js';
export { StuckDetector, NO_INPUT_POLICIES } from './stuck.js';
export { WallBumpDetector } from './wallBump.js';
export {
  probeInputResponse,
  inputProbeUnavailable,
  type InputProbeOptions,
  type InputProbeResult,
} from './unresponsive.js';

/** Every per-step detector, in report order. */
export function allDetectors(): Detector[] {
  return [
    new CrashDetector(),
    new StuckDetector(),
    new BlackScreenDetector(),
    new WallBumpDetector(),
    new SealedRegionDetector(),
  ];
}

/** The reason a detector cannot run against these capabilities, or null. */
export function detectorUnavailable(
  detector: Detector,
  capabilities: ProbeCapabilities,
  policy: string,
): string | null {
  const missing = detector.requires.filter((key) => !capabilities.senses[key]);
  if (missing.length > 0) {
    return `needs ${missing.map((k) => SENSE_LABEL[k]).join(' + ')}, which this game does not declare`;
  }
  return detector.unavailable?.(capabilities, policy) ?? null;
}

/**
 * Start the detectors this game can support and record why the rest were not
 * run. Detectors are started here so a detector can precompute from the nav grid.
 */
export function buildDetectors(init: DetectorInit): {
  detectors: Detector[];
  skipped: SkippedDetector[];
} {
  const detectors: Detector[] = [];
  const skipped: SkippedDetector[] = [];
  for (const detector of allDetectors()) {
    const reason = detectorUnavailable(detector, init.capabilities, init.policy);
    if (reason !== null) {
      skipped.push({ kind: detector.kind, reason });
      continue;
    }
    detector.start(init);
    detectors.push(detector);
  }
  return { detectors, skipped };
}
