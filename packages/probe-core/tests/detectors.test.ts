/**
 * Detectors, and the rule that binds all of them: a sense the game does not
 * declare produces a SkippedDetector, never a finding and never silence.
 *
 * Each detector is also driven directly with a synthesized sample stream, so
 * the thresholds are pinned independently of whether any policy happens to
 * provoke them during a sweep.
 */
import { describe, expect, it } from 'vitest';
import {
  BlackScreenDetector,
  buildDetectors,
  blankImage,
  CoverageTracker,
  CrashDetector,
  DEFAULT_DETECTOR_CONFIG,
  detectorUnavailable,
  fillRect,
  SealedRegionDetector,
  StuckDetector,
  WallBumpDetector,
  type Detector,
  type DetectorInit,
  type NavGrid,
  type ProbeCapabilities,
  type ProbeEntity,
  type ProbeSample,
  type RgbaImage,
} from '@hearth/probe-core';

const FULL: ProbeCapabilities = {
  input: { actions: ['left', 'right'], axes: [], pointer: false },
  senses: {
    errors: true,
    scenes: true,
    events: true,
    entities: true,
    screenshot: true,
    nav: true,
    reset: true,
  },
  viewport: { width: 320, height: 240 },
};

function caps(senses: Partial<ProbeCapabilities['senses']>): ProbeCapabilities {
  return { ...FULL, senses: { ...FULL.senses, ...senses } };
}

const GRID: NavGrid = {
  originX: 0,
  originY: 0,
  cellSize: 10,
  cols: 5,
  rows: 4,
  // A solid column down the middle seals the right half from the left.
  solid: [
    false, false, true, false, false,
    false, false, true, false, false,
    false, false, true, false, false,
    false, false, true, false, false,
  ],
};

function init(over: Partial<DetectorInit> = {}): DetectorInit {
  return {
    capabilities: FULL,
    config: DEFAULT_DETECTOR_CONFIG,
    policy: 'mash',
    navGrid: null,
    spawn: null,
    ...over,
  };
}

function sample(over: Partial<ProbeSample> = {}): ProbeSample {
  return {
    instant: { frame: 1 },
    obs: { frame: 1, newErrors: [], sceneId: 'main', newEvents: [] },
    entities: [],
    avatar: null,
    image: null,
    intent: null,
    novel: false,
    framesSinceNovelty: 0,
    ...over,
  };
}

function entity(x: number, y: number): ProbeEntity {
  return { id: 'avatar', tags: ['player'], x, y, alive: true };
}

describe('capability honesty', () => {
  it('skips every detector whose sense is missing, naming the sense', () => {
    const blind = caps({ errors: false, screenshot: false, entities: false, nav: false });
    const { detectors, skipped } = buildDetectors(init({ capabilities: blind }));
    const kinds = skipped.map((s) => s.kind).sort();
    expect(kinds).toEqual(['black-screen', 'crash', 'sealed-region', 'wall-bump']);
    expect(skipped.find((s) => s.kind === 'crash')?.reason).toMatch(/error stream/);
    expect(skipped.find((s) => s.kind === 'black-screen')?.reason).toMatch(/screenshots/);
    expect(skipped.find((s) => s.kind === 'sealed-region')?.reason).toMatch(/nav grid/);
    // Scenes and events survive, so the novelty drought can still be judged.
    expect(detectors.map((d) => d.kind)).toEqual(['stuck']);
  });

  it('runs everything when every sense is declared', () => {
    const { detectors, skipped } = buildDetectors(init({ navGrid: GRID, spawn: { x: 5, y: 5 } }));
    expect(skipped).toEqual([]);
    expect(detectors.map((d) => d.kind).sort()).toEqual([
      'black-screen',
      'crash',
      'sealed-region',
      'stuck',
      'wall-bump',
    ]);
  });

  it('exempts a no-input policy from the stuck verdict', () => {
    const { detectors, skipped } = buildDetectors(init({ policy: 'idle' }));
    expect(detectors.find((d) => d.kind === 'stuck')).toBeUndefined();
    expect(skipped.find((s) => s.kind === 'stuck')?.reason).toMatch(/injects no input/);
  });

  it('skips stuck when no sense could ever show progress', () => {
    const nothing = caps({ entities: false, screenshot: false, scenes: false, events: false });
    const reason = detectorUnavailable(new StuckDetector() as Detector, nothing, 'mash');
    expect(reason).toMatch(/no sense that can show progress/);
  });
});

describe('crash', () => {
  it('reports the first error as a blocker and escalates to the error verdict', () => {
    const detector = new CrashDetector();
    detector.start(init());
    detector.observe(sample());
    expect(detector.verdict()).toBeNull();

    detector.observe(
      sample({
        instant: { frame: 100 },
        obs: {
          frame: 100,
          newErrors: [{ message: 'boom', where: 'player.js:31', at: { frame: 100 } }],
          sceneId: 'main',
          newEvents: [],
        },
        shot: 'sweeps/0001/shots/x.png',
      }),
    );
    expect(detector.verdict()).toBe('error');
    expect(detector.firstError?.message).toBe('boom');

    // A cascade of follow-up errors does not multiply the findings.
    detector.observe(
      sample({
        obs: { frame: 101, newErrors: [{ message: 'second', at: { frame: 101 } }], sceneId: 'main', newEvents: [] },
      }),
    );
    const findings = detector.finish();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'crash', severity: 'blocker', shot: 'sweeps/0001/shots/x.png' });
    expect(findings[0].summary).toContain('boom');
    expect(findings[0].at).toEqual({ frame: 100 });
  });
});

describe('stuck', () => {
  it('fires only after the configured drought', () => {
    const detector = new StuckDetector();
    detector.start(init({ config: { ...DEFAULT_DETECTOR_CONFIG, stuckAfter: 50 } }));
    for (let i = 1; i <= 49; i++) detector.observe(sample({ framesSinceNovelty: i, instant: { frame: i } }));
    expect(detector.verdict()).toBeNull();
    detector.observe(sample({ framesSinceNovelty: 50, instant: { frame: 50 } }));
    expect(detector.verdict()).toBe('stuck');
    expect(detector.stuckInstant).toEqual({ frame: 50 });
  });
});

describe('black-screen', () => {
  const dark = blankImage(16, 16, [2, 2, 2, 255]);
  const lively: RgbaImage = (() => {
    const img = blankImage(16, 16, [10, 10, 10, 255]);
    fillRect(img, 0, 0, 16, 8, [200, 200, 200, 255]);
    return img;
  })();

  it('needs sustained darkness, not one dark frame', () => {
    const detector = new BlackScreenDetector();
    detector.start(init());
    detector.observe(sample({ image: dark, instant: { frame: 30 } }));
    detector.observe(sample({ image: dark, instant: { frame: 60 } }));
    expect(detector.finish()).toEqual([]);
  });

  it('reports a blocker once the screen stays blank past the window', () => {
    const detector = new BlackScreenDetector();
    detector.start(init());
    for (const frame of [30, 60, 90, 120]) {
      detector.observe(sample({ image: dark, instant: { frame }, shot: 'sweeps/0001/shots/dark.png' }));
    }
    const findings = detector.finish();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'black-screen', severity: 'blocker' });
    expect(findings[0].summary).toContain('blank');
  });

  it('stays silent on a dark but detailed frame', () => {
    const detector = new BlackScreenDetector();
    detector.start(init());
    for (const frame of [30, 60, 90, 120, 150]) detector.observe(sample({ image: lively, instant: { frame } }));
    expect(detector.finish()).toEqual([]);
  });

  it('resets the clock when the picture comes back', () => {
    const detector = new BlackScreenDetector();
    detector.start(init());
    detector.observe(sample({ image: dark, instant: { frame: 30 } }));
    detector.observe(sample({ image: lively, instant: { frame: 60 } }));
    detector.observe(sample({ image: dark, instant: { frame: 90 } }));
    detector.observe(sample({ image: dark, instant: { frame: 120 } }));
    expect(detector.finish()).toEqual([]);
  });
});

describe('wall-bump', () => {
  function push(detector: WallBumpDetector, steps: number, dx: number, stalling: boolean): void {
    let x = 0;
    for (let i = 0; i < steps; i++) {
      x += dx;
      detector.observe(
        sample({
          instant: { frame: i + 1 },
          avatar: entity(x, 0),
          intent: { dx: 1, dy: 0 },
          framesSinceNovelty: stalling ? i + 1 : 0,
        }),
      );
    }
  }

  it('fires when a held direction wins no ground during a stall', () => {
    const detector = new WallBumpDetector();
    detector.start(init());
    push(detector, 60, 0, true);
    const findings = detector.finish();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'wall-bump', severity: 'note' });
  });

  it('stays silent while the avatar is actually moving', () => {
    const detector = new WallBumpDetector();
    detector.start(init());
    push(detector, 60, 3, true);
    expect(detector.finish()).toEqual([]);
  });

  it('stays silent when the run is making progress anyway', () => {
    const detector = new WallBumpDetector();
    detector.start(init());
    push(detector, 60, 0, false);
    expect(detector.finish()).toEqual([]);
  });

  it('stays silent when the policy has no steering intent', () => {
    const detector = new WallBumpDetector();
    detector.start(init());
    for (let i = 0; i < 60; i++) {
      detector.observe(sample({ instant: { frame: i + 1 }, avatar: entity(0, 0), framesSinceNovelty: i + 1 }));
    }
    expect(detector.finish()).toEqual([]);
  });
});

describe('sealed-region', () => {
  it('reports the walled-off half with sample coordinates', () => {
    const detector = new SealedRegionDetector();
    detector.start(init({ navGrid: GRID, spawn: { x: 5, y: 5 }, config: { ...DEFAULT_DETECTOR_CONFIG, cellSize: 10 } }));
    const findings = detector.finish();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'sealed-region', severity: 'issue' });
    expect(findings[0].summary).toContain('50%');
    expect(findings[0].detail).toMatch(/door, teleport/);
  });

  it('says nothing when the spawn is unknown', () => {
    const detector = new SealedRegionDetector();
    detector.start(init({ navGrid: GRID, spawn: null }));
    expect(detector.finish()).toEqual([]);
  });

  it('says nothing when everything is reachable', () => {
    const open: NavGrid = { ...GRID, solid: new Array(20).fill(false) };
    const detector = new SealedRegionDetector();
    detector.start(init({ navGrid: open, spawn: { x: 5, y: 5 } }));
    expect(detector.finish()).toEqual([]);
  });
});

describe('CoverageTracker', () => {
  it('never counts the opening state as progress', () => {
    const tracker = new CoverageTracker({ cellSize: 32 });
    expect(
      tracker.observe({ entities: [entity(0, 0)], avatar: entity(0, 0), image: null, sceneId: 'main', newEvents: [] }),
    ).toBe(false);
    expect(tracker.keys.has('c:0,0')).toBe(true);
    expect(tracker.keys.has('s:main')).toBe(true);
  });

  it('counts a new cell, a new scene, and a first-of-its-name event', () => {
    const tracker = new CoverageTracker({ cellSize: 32 });
    const avatar = entity(0, 0);
    tracker.observe({ entities: [avatar], avatar, image: null, sceneId: 'main', newEvents: [] });

    const moved = entity(100, 0);
    expect(
      tracker.observe({ entities: [moved], avatar: moved, image: null, sceneId: 'main', newEvents: [] }),
    ).toBe(true);
    expect(
      tracker.observe({ entities: [moved], avatar: moved, image: null, sceneId: 'level-2', newEvents: [] }),
    ).toBe(true);
    expect(
      tracker.observe({ entities: [moved], avatar: moved, image: null, sceneId: 'level-2', newEvents: ['coin'] }),
    ).toBe(true);
    // The same event name firing forever cannot manufacture progress.
    expect(
      tracker.observe({ entities: [moved], avatar: moved, image: null, sceneId: 'level-2', newEvents: ['coin'] }),
    ).toBe(false);
  });

  it('de-noises pixel novelty: a jittering frame is not a new place', () => {
    const tracker = new CoverageTracker({ hashDistance: 4 });
    const base = blankImage(32, 32, [30, 30, 30, 255]);
    fillRect(base, 0, 0, 16, 32, [220, 220, 220, 255]);
    const jitter = blankImage(32, 32, [33, 27, 30, 255]);
    fillRect(jitter, 0, 0, 16, 32, [217, 223, 220, 255]);
    const elsewhere = blankImage(32, 32, [30, 30, 30, 255]);
    fillRect(elsewhere, 0, 16, 32, 16, [220, 220, 220, 255]);

    tracker.observe({ entities: null, avatar: null, image: base, sceneId: null, newEvents: [] });
    expect(tracker.observe({ entities: null, avatar: null, image: jitter, sceneId: null, newEvents: [] })).toBe(
      false,
    );
    expect(
      tracker.observe({ entities: null, avatar: null, image: elsewhere, sceneId: null, newEvents: [] }),
    ).toBe(true);
  });

  it('prefers entity cells over pixels when both are available', () => {
    const tracker = new CoverageTracker({ cellSize: 32 });
    const avatar = entity(0, 0);
    const image = blankImage(8, 8, [10, 10, 10, 255]);
    tracker.observe({ entities: [avatar], avatar, image, sceneId: null, newEvents: [] });
    expect([...tracker.keys].some((k) => k.startsWith('h:'))).toBe(false);
  });

  it('tracks a few entities when there is no avatar to follow', () => {
    const tracker = new CoverageTracker({ cellSize: 32, entityCap: 2 });
    const entities = [entity(0, 0), { ...entity(100, 0), id: 'b' }, { ...entity(200, 0), id: 'c' }];
    tracker.observe({ entities, avatar: null, image: null, sceneId: null, newEvents: [] });
    expect([...tracker.keys].filter((k) => k.startsWith('c:'))).toHaveLength(2);
  });
});
