/**
 * Tests for `hearth screenshot`'s capture logic: pure HTML-injection tests
 * run unconditionally; the real Chromium capture is gated behind
 * canLaunchChromium() so this suite still passes in environments with no
 * Chrome/Chromium available (see the brief's it.skipIf pattern).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { HearthSession, MemoryFileSystem, createProject, type ProjectStore } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import {
  captureScreenshot,
  canLaunchChromium,
  injectBootScript,
  waitForBootReady,
  CHROMIUM_MISSING_ERROR,
} from '../src/screenshot.js';

const SAMPLE_EXPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Game</title></head>
<body>
  <div id="hearth-mount"></div>
  <script>
    function hearthBoot(load) {
      var mount = document.getElementById('hearth-mount');
    }
  </script>
  <script>window.HearthPlayer={boot(){}};</script>
  <script>
    var bundle = {"project":{}};
    hearthBoot(function (ready) { ready(bundle); });
  </script>
</body>
</html>
`;

describe('injectBootScript', () => {
  it('inserts window.__HEARTH_BOOT__ right before the player script tag, not the bundle script tag', () => {
    const injected = injectBootScript(SAMPLE_EXPORT_HTML, { manual: true, seed: 5, debug: true });
    const bootIdx = injected.indexOf('window.__HEARTH_BOOT__');
    const playerIdx = injected.indexOf('window.HearthPlayer={boot(){}}');
    const bundleIdx = injected.indexOf('var bundle');
    expect(bootIdx).toBeGreaterThan(-1);
    expect(bootIdx).toBeLessThan(playerIdx);
    expect(bootIdx).toBeLessThan(bundleIdx);
  });

  it('serializes the overrides object as valid JSON', () => {
    const injected = injectBootScript(SAMPLE_EXPORT_HTML, {
      manual: true,
      seed: 7,
      debug: false,
      width: 800,
      height: 600,
      scene: 'scn_abc123',
    });
    const match = /window\.__HEARTH_BOOT__ = (\{.*?\});/.exec(injected);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    expect(parsed).toEqual({ manual: true, seed: 7, debug: false, width: 800, height: 600, scene: 'scn_abc123' });
  });

  it('omits undefined keys from the injected payload', () => {
    const injected = injectBootScript(SAMPLE_EXPORT_HTML, { manual: true, seed: 0, debug: false });
    const match = /window\.__HEARTH_BOOT__ = (\{.*?\});/.exec(injected);
    const parsed = JSON.parse(match![1]);
    expect(parsed).toEqual({ manual: true, seed: 0, debug: false });
    expect('width' in parsed).toBe(false);
  });

  it('does not touch the original html string (pure)', () => {
    const before = SAMPLE_EXPORT_HTML;
    injectBootScript(SAMPLE_EXPORT_HTML, { manual: true });
    expect(SAMPLE_EXPORT_HTML).toBe(before);
  });

  it('throws a clear error when the hearthBoot helper is not found', () => {
    expect(() => injectBootScript('<html><body>no boot here</body></html>', { manual: true })).toThrow(
      /hearthBoot/,
    );
  });

  it('escapes a </script> sequence inside the overrides so it cannot break out of the injected tag', () => {
    // scene is always an id/name string in real usage, never attacker HTML,
    // but JSON.stringify's default escaping does NOT escape "</script" —
    // this locks in that captureScreenshot must not regress that safety net
    // if it ever passes a less-trusted string through.
    const injected = injectBootScript(SAMPLE_EXPORT_HTML, { manual: true, scene: '</script><script>evil()' });
    expect(injected).not.toContain('</script><script>evil()');
  });
});

/**
 * waitForBootReady's fail-fast path is exercised here against a fake
 * Playwright page, not a real broken game project: the runtime is
 * defensive by design (script compile errors, hook errors, and texture load
 * failures are all caught and routed to onLog/onError rather than thrown),
 * so getting a real project to produce a genuine uncaught page exception
 * during boot — without directly sabotaging the runtime — isn't really
 * feasible. A fake page lets these tests assert the exact fail-fast
 * behavior (reject immediately with the real message, don't wait for
 * waitForFunction) deterministically and without a 30s real timeout.
 */
describe('waitForBootReady', () => {
  type FakeHandler = (arg: unknown) => void;

  function makeFakePage(waitForFunction: () => Promise<unknown>) {
    const handlers: Record<string, FakeHandler[]> = { pageerror: [], console: [] };
    return {
      on(event: string, handler: FakeHandler) {
        handlers[event].push(handler);
      },
      waitForFunction,
      emit(event: 'pageerror' | 'console', arg: unknown) {
        for (const h of handlers[event]) h(arg);
      },
    };
  }

  it('resolves normally when the ready check resolves with no error', async () => {
    const page = makeFakePage(() => Promise.resolve(true));
    await expect(waitForBootReady(page as never, async () => {})).resolves.toBeUndefined();
  });

  it('ignores non-error console messages and still resolves via the ready check', async () => {
    const page = makeFakePage(() => Promise.resolve(true));
    const navigate = async () => {
      page.emit('console', { type: () => 'log', text: () => 'starting up' });
    };
    await expect(waitForBootReady(page as never, navigate)).resolves.toBeUndefined();
  });

  it('fails fast with the real page error instead of waiting out the ready-check timeout', async () => {
    // A ready check that never resolves stands in for the real hang this
    // bug produced: without the fix, waitForBootReady would sit on this
    // forever (in production, until waitForFunction's own ~30s timeout).
    const page = makeFakePage(() => new Promise(() => {}));
    const navigate = async () => {
      page.emit('pageerror', new Error('HearthPlayer.boot: project has no scenes'));
    };
    await expect(waitForBootReady(page as never, navigate)).rejects.toThrow(
      /page threw during boot: HearthPlayer\.boot: project has no scenes/,
    );
  });

  it('fails fast on a console.error logged before ready, not just a thrown error', async () => {
    const page = makeFakePage(() => new Promise(() => {}));
    const navigate = async () => {
      page.emit('console', { type: () => 'error', text: () => 'Uncaught TypeError: boom' });
    };
    await expect(waitForBootReady(page as never, navigate)).rejects.toThrow(
      /console error during boot: Uncaught TypeError: boom/,
    );
  });
});

async function makeStore(): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Screenshot Test Game' });
  return store;
}

/**
 * A NodeFileSystem-backed store rooted in a real, writable OS temp
 * directory. captureScreenshot resolves `opts.out` against `store.root`
 * (project-relative, matching every other CLI --out flag), so real capture
 * tests need a real filesystem root — a MemoryFileSystem-backed `/proj`
 * can't receive a real PNG write.
 */
async function makeRealStore(): Promise<{ store: ProjectStore; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearth-screenshot-test-'));
  const fs = new NodeFileSystem();
  const { store } = await createProject(fs, root, { name: 'Screenshot Test Game' });
  return { store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** True when a real path exists on disk. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('captureScreenshot option validation', () => {
  it('rejects an unknown scene before ever touching Chromium', async () => {
    const store = await makeStore();
    await expect(captureScreenshot(store, { scene: 'NoSuchScene' })).rejects.toThrow(/scene not found/i);
  });

  // `out` is agent-facing (CLI --out, MCP tool field): it must stay inside
  // the project root, same sandbox rule as buildProject/exportWeb's outDir.
  // Enforced at the captureScreenshot level so the CLI and the MCP tool
  // both inherit the guarantee. Nested relative paths staying allowed is
  // covered by the real-capture test below (out: 'shots/frame5.png').
  it('rejects an absolute out path', async () => {
    const store = await makeStore();
    await expect(captureScreenshot(store, { out: '/tmp/evil.png' })).rejects.toThrow(
      /out must be a project-relative path/,
    );
  });

  it('rejects an out path with .. traversal', async () => {
    const store = await makeStore();
    await expect(captureScreenshot(store, { out: '../escape.png' })).rejects.toThrow(
      /out must be a project-relative path/,
    );
    await expect(captureScreenshot(store, { out: 'shots/../../escape.png' })).rejects.toThrow(
      /out must be a project-relative path/,
    );
  });

  it('cleans up the .hearth-tmp scratch dir even when the export itself fails', async () => {
    const { store, cleanup } = await makeRealStore();
    try {
      // A syntactically-broken JS script makes validateProject fail, which
      // makes exportWeb fail — the failure path that used to escape the
      // cleanup try/finally because the export ran before it.
      await store.fs.writeFile(path.join(store.root, 'scripts', 'broken.js'), 'this is not js(((');
      await expect(captureScreenshot(store, { out: 'shot.png' })).rejects.toThrow(
        /could not export a build/,
      );
      await expect(pathExists(path.join(store.root, '.hearth-tmp'))).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('CHROMIUM_MISSING_ERROR', () => {
  it('matches the exact error copy required by the brief', () => {
    expect(CHROMIUM_MISSING_ERROR).toBe(
      'hearth screenshot needs Chrome or Chromium installed (or CHROMIUM_PATH set). ' +
        'Install Google Chrome, or: npx playwright install chromium',
    );
  });
});

// ---------------------------------------------------------------------------
// Real Chromium capture: gated so this suite passes with no browser present.
// ---------------------------------------------------------------------------
const hasChromium = await canLaunchChromium();

describe('captureScreenshot (real Chromium)', () => {
  it.skipIf(!hasChromium)(
    'captures a deterministic PNG frame from the starter scene',
    async () => {
      const { store, cleanup } = await makeRealStore();
      try {
        const meta = await captureScreenshot(store, { frame: 5, seed: 1, out: 'shots/frame5.png' });
        expect(meta.frame).toBe(5);
        expect(meta.width).toBeGreaterThan(0);
        expect(meta.height).toBeGreaterThan(0);
        expect(meta.path.endsWith(path.join('shots', 'frame5.png'))).toBe(true);

        const info = await stat(meta.path);
        expect(info.size).toBeGreaterThan(500); // a real PNG, not an empty/near-empty file

        // The in-project export scratch dir is fully cleaned up after success.
        await expect(pathExists(path.join(store.root, '.hearth-tmp'))).resolves.toBe(false);
      } finally {
        await cleanup();
      }
    },
    30000,
  );

  it.skipIf(!hasChromium)(
    'is deterministic: two captures at the same seed+frame produce identical PNG bytes',
    async () => {
      const { store, cleanup } = await makeRealStore();
      try {
        const a = await captureScreenshot(store, { frame: 10, seed: 3, out: 'shots/a.png' });
        const b = await captureScreenshot(store, { frame: 10, seed: 3, out: 'shots/b.png' });
        const [bytesA, bytesB] = await Promise.all([readFile(a.path), readFile(b.path)]);
        expect(Buffer.compare(bytesA, bytesB)).toBe(0);
      } finally {
        await cleanup();
      }
    },
    30000,
  );

  // Regression for the "SpriteAnimator never renders" bug: buildNode built
  // the sprite child's texture exactly once, so a SpriteAnimator swapping
  // SpriteRenderer.assetId after entity creation never changed what was on
  // screen. Two maximally-different frames (a red rectangle vs. a green
  // circle) leave nothing to eyeball about — if the fix regresses, this
  // asserts the two captured PNGs come back byte-identical instead of
  // differing.
  it.skipIf(!hasChromium)(
    'redraws the sprite texture when a SpriteAnimator advances to a different frame',
    async () => {
      const { store, cleanup } = await makeRealStore();
      try {
        const session = HearthSession.fromStore(store, { granted: ['asset-edit', 'safe-edit'] });

        const frameA = await session.execute<{ asset: { id: string } }>('createSpriteAsset', {
          name: 'frameA',
          shape: 'rectangle',
          color: '#ff0000',
          width: 64,
          height: 64,
        });
        const frameB = await session.execute<{ asset: { id: string } }>('createSpriteAsset', {
          name: 'frameB',
          shape: 'circle',
          color: '#00ff00',
          width: 64,
          height: 64,
        });
        expect(frameA.success).toBe(true);
        expect(frameB.success).toBe(true);

        const anim = await session.execute<{ asset: { id: string } }>('createAnimationAsset', {
          name: 'blink',
          frames: [frameA.data!.asset.id, frameB.data!.asset.id],
          frameDuration: 0.1,
          loop: true,
        });
        expect(anim.success).toBe(true);

        // The starter scene's Player has a dynamic PhysicsBody (default
        // gravityScale), so it falls a little every fixed step — disable it
        // so it can't confound the comparison below. With Player out of the
        // way, a fresh AnimTest entity with no PhysicsBody/Collider is the
        // only thing on screen that can change frame to frame, so any pixel
        // difference between the two captures below can only come from the
        // sprite redraw.
        const disabledPlayer = await session.execute('setEntityEnabled', {
          scene: 'Main',
          entity: 'Player',
          enabled: false,
        });
        expect(disabledPlayer.success).toBe(true);

        const entity = await session.execute<{ entityId: string }>('createEntity', {
          scene: 'Main',
          name: 'AnimTest',
          position: { x: 400, y: 300 },
          components: {
            SpriteRenderer: { assetId: frameA.data!.asset.id, shape: 'rectangle', width: 64, height: 64 },
            SpriteAnimator: { assetId: anim.data!.asset.id, fps: 0, playing: true, loop: true },
          },
        });
        expect(entity.success).toBe(true);

        // fixedTimestep defaults to 60 (dt = 1/60s); frameDuration 0.1s is
        // exactly 6 steps, so frame 0 captures animator frame index 0 and
        // frame 6 captures index 1 — the moment the fix must pick up.
        const before = await captureScreenshot(store, { frame: 0, out: 'shots/anim-frame0.png' });
        const after = await captureScreenshot(store, { frame: 6, out: 'shots/anim-frame6.png' });
        const [bytesBefore, bytesAfter] = await Promise.all([
          readFile(before.path),
          readFile(after.path),
        ]);
        expect(Buffer.compare(bytesBefore, bytesAfter)).not.toBe(0);
      } finally {
        await cleanup();
      }
    },
    30000,
  );
});
