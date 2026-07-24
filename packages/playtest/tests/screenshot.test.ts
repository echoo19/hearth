/**
 * Tests for `hearth screenshot`'s capture logic: pure HTML-injection tests
 * run unconditionally; the real Chromium capture is gated behind
 * canLaunchChromium() so this suite still passes in environments with no
 * Chrome/Chromium available (see the brief's it.skipIf pattern).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { mkdtemp, readFile, rm, stat, writeFile as writeFileNode } from 'node:fs/promises';
import { HearthSession, MemoryFileSystem, createProject, type ProjectStore } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import {
  captureScreenshot,
  canLaunchChromium,
  injectBootScript,
  waitForBootReady,
  CHROMIUM_MISSING_ERROR,
} from '../src/screenshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Committed real TTF fixture (see packages/examples/fixtures/fonts/OFL.txt
// for license) — font-loading tests need bytes a real FontFace can
// actually parse, not the header-only stand-ins used elsewhere in this file.
const FONT_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../examples/fixtures/fonts/press-start-2p.ttf',
);

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

// ---------------------------------------------------------------------------
// Real, browser-decodable PNG fixture builder.
//
// The header-only "PNG" bytes used elsewhere in this repo's tests (e.g.
// packages/core/tests/spritesheet.test.ts, packages/runtime/tests/
// spriteFrame.test.ts) only carry a valid IHDR chunk — no IDAT/IEND — so
// they satisfy `probeImage`'s byte-level dimension sniffing but are not
// images a real decoder can render. `singleFile` export inlines assets as
// data URIs that Chromium decodes natively, so the frame/tint tests below
// need a genuinely valid PNG with real, visibly distinct per-frame pixel
// colors. Built with node:zlib (deflateSync) + a small CRC32 — no extra
// dependency.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, crcInput, crc]);
}

/** Build a real 8-bit RGB (no alpha) PNG from a per-pixel color function. */
function buildPng(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const stride = width * 3 + 1; // leading filter-type byte + 3 bytes/pixel
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      const o = rowStart + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(
    Buffer.concat([
      signature,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/**
 * 64x32 sheet: solid orange left half, solid blue right half — two 32x32
 * frames. Orange (not a pure primary) is deliberate: the tint test below
 * multiplies frame 0 by '#ff0000', and a pure-red source would be a
 * degenerate fixture for that (red × red == red × white for every body
 * pixel, leaving only GPU/browser-dependent bilinear edge bleed at the
 * frame seam to differ). Orange × red = (255, 0, 0) — a full-body change —
 * while staying visibly distinct from blue for the frame-difference
 * assertions.
 */
function makeTwoFrameSheetPng(): Uint8Array {
  return buildPng(64, 32, (x) => (x < 32 ? [255, 128, 64] : [0, 0, 255]));
}

/**
 * A real, disk-backed project with a sliced two-frame sheet asset and the
 * default Player disabled (mirrors the existing SpriteAnimator regression
 * test below: Player has a dynamic PhysicsBody and falls every fixed step,
 * which would otherwise confound byte-for-byte capture comparisons).
 * Frame names come back from sliceSpritesheet itself rather than assumed,
 * since they depend on the asset's slugified name.
 */
async function makeSheetStore(): Promise<{
  store: ProjectStore;
  cleanup: () => Promise<void>;
  sheetId: string;
  frames: [string, string];
}> {
  const { store, cleanup } = await makeRealStore();
  const session = HearthSession.fromStore(store, { granted: ['asset-edit', 'safe-edit'] });

  const pngPath = path.join(os.tmpdir(), `hearth-sheet-${Math.random().toString(36).slice(2)}.png`);
  await writeFileNode(pngPath, makeTwoFrameSheetPng());

  const imported = await session.execute<{ asset: { id: string } }>('importAsset', {
    sourcePath: pngPath,
    name: 'TwoFrameSheet',
    type: 'sprite',
  });
  if (!imported.success) throw new Error(`importAsset failed: ${imported.errors.map((e) => e.message).join('; ')}`);
  const sheetId = imported.data!.asset.id;

  const sliced = await session.execute<{ frames: string[] }>('sliceSpritesheet', {
    asset: sheetId,
    frameWidth: 32,
    frameHeight: 32,
  });
  if (!sliced.success) throw new Error(`sliceSpritesheet failed: ${sliced.errors.map((e) => e.message).join('; ')}`);
  const [frameA, frameB] = sliced.data!.frames;

  const disabledPlayer = await session.execute('setEntityEnabled', {
    scene: 'Main',
    entity: 'Player',
    enabled: false,
  });
  if (!disabledPlayer.success) throw new Error('could not disable Player');

  return { store, cleanup, sheetId, frames: [frameA, frameB] };
}

/**
 * A real, disk-backed project set up for post-processing pixel tests: Player
 * disabled (its dynamic PhysicsBody falls each step and would confound
 * byte-for-byte capture comparisons), plus a spread of opaque rectangle
 * sprites — one bright white block at center (so bloom has content above its
 * luminance threshold) and four saturated blocks pushed into the corners (so
 * vignette/chromatic-aberration/pixelate, which are strongest away from
 * center and at color edges, all have something to act on). The camera entity
 * is 'Main Camera'; set Camera.postEffects on it to exercise each effect.
 */
async function makePostFxStore(): Promise<{ store: ProjectStore; cleanup: () => Promise<void> }> {
  const { store, cleanup } = await makeRealStore();
  const session = HearthSession.fromStore(store, { granted: ['asset-edit', 'safe-edit'] });

  const disabledPlayer = await session.execute('setEntityEnabled', {
    scene: 'Main',
    entity: 'Player',
    enabled: false,
  });
  if (!disabledPlayer.success) throw new Error('could not disable Player');

  const blocks: Array<{ name: string; x: number; y: number; w: number; h: number; color: string }> = [
    { name: 'FxWhite', x: 400, y: 300, w: 260, h: 260, color: '#ffffff' },
    { name: 'FxRed', x: 110, y: 110, w: 180, h: 180, color: '#ff0000' },
    { name: 'FxGreen', x: 690, y: 110, w: 180, h: 180, color: '#00ff00' },
    { name: 'FxBlue', x: 110, y: 490, w: 180, h: 180, color: '#0000ff' },
    { name: 'FxYellow', x: 690, y: 490, w: 180, h: 180, color: '#ffff00' },
  ];
  for (const b of blocks) {
    const created = await session.execute('createEntity', {
      scene: 'Main',
      name: b.name,
      position: { x: b.x, y: b.y },
      components: {
        SpriteRenderer: { shape: 'rectangle', color: b.color, width: b.w, height: b.h },
      },
    });
    if (!created.success) throw new Error(`could not create ${b.name}`);
  }
  return { store, cleanup };
}

/**
 * A real, disk-backed project with the Player disabled and a single opaque
 * rectangle sprite ('FxSprite') centered on screen, for SpriteEffects
 * (outline/flash/dissolve) pixel tests. The sprite is the only thing that can
 * change frame-to-frame, so any pixel difference between captures is the
 * SpriteEffects filter.
 */
async function makeSpriteFxStore(): Promise<{ store: ProjectStore; cleanup: () => Promise<void> }> {
  const { store, cleanup } = await makeRealStore();
  const session = HearthSession.fromStore(store, { granted: ['asset-edit', 'safe-edit'] });

  const disabledPlayer = await session.execute('setEntityEnabled', {
    scene: 'Main',
    entity: 'Player',
    enabled: false,
  });
  if (!disabledPlayer.success) throw new Error('could not disable Player');

  const created = await session.execute('createEntity', {
    scene: 'Main',
    name: 'FxSprite',
    position: { x: 400, y: 300 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#3366cc', width: 140, height: 140 },
    },
  });
  if (!created.success) throw new Error('could not create FxSprite');
  return { store, cleanup };
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
    120_000,
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

  // Renderer draws sliced-sheet sub-rects and applies SpriteRenderer.tint.
  // Two entities at the SAME two screen positions, but with which frame is
  // assigned to which position swapped between the two captures below. If
  // the renderer actually crops to each entity's named frame, swapping the
  // assignment must change what's on screen at those positions; if `frame`
  // were silently ignored (drawing the whole sheet for both, as before this
  // feature), the two captures would come back byte-identical regardless of
  // the swap.
  it.skipIf(!hasChromium)(
    'draws different sub-rects for two entities showing different frames of the same sheet',
    async () => {
      const { store, cleanup, sheetId, frames } = await makeSheetStore();
      try {
        const [frameA, frameB] = frames;
        const session = HearthSession.fromStore(store, { granted: ['asset-edit', 'safe-edit'] });

        await session.execute('createEntity', {
          scene: 'Main',
          name: 'Left',
          position: { x: 300, y: 300 },
          components: { SpriteRenderer: { assetId: sheetId, frame: frameA, width: 64, height: 64 } },
        });
        await session.execute('createEntity', {
          scene: 'Main',
          name: 'Right',
          position: { x: 700, y: 300 },
          components: { SpriteRenderer: { assetId: sheetId, frame: frameB, width: 64, height: 64 } },
        });

        const original = await captureScreenshot(store, { out: 'shots/frames-original.png' });

        const swapLeft = await session.execute('setComponentProperty', {
          scene: 'Main',
          entity: 'Left',
          property: 'SpriteRenderer.frame',
          value: frameB,
        });
        const swapRight = await session.execute('setComponentProperty', {
          scene: 'Main',
          entity: 'Right',
          property: 'SpriteRenderer.frame',
          value: frameA,
        });
        expect(swapLeft.success).toBe(true);
        expect(swapRight.success).toBe(true);

        const swapped = await captureScreenshot(store, { out: 'shots/frames-swapped.png' });

        const [bytesOriginal, bytesSwapped] = await Promise.all([
          readFile(original.path),
          readFile(swapped.path),
        ]);
        expect(Buffer.compare(bytesOriginal, bytesSwapped)).not.toBe(0);
      } finally {
        await cleanup();
      }
    },
    30000,
  );

  it.skipIf(!hasChromium)(
    'changing SpriteRenderer.frame between renders changes the captured pixels',
    async () => {
      const { store, cleanup, sheetId, frames } = await makeSheetStore();
      try {
        const [frameA, frameB] = frames;
        const session = HearthSession.fromStore(store, { granted: ['asset-edit', 'safe-edit'] });

        await session.execute('createEntity', {
          scene: 'Main',
          name: 'FrameTest',
          position: { x: 480, y: 270 },
          components: { SpriteRenderer: { assetId: sheetId, frame: frameA, width: 64, height: 64 } },
        });

        const before = await captureScreenshot(store, { out: 'shots/frame-before.png' });

        const changed = await session.execute('setComponentProperty', {
          scene: 'Main',
          entity: 'FrameTest',
          property: 'SpriteRenderer.frame',
          value: frameB,
        });
        expect(changed.success).toBe(true);

        const after = await captureScreenshot(store, { out: 'shots/frame-after.png' });

        const [bytesBefore, bytesAfter] = await Promise.all([readFile(before.path), readFile(after.path)]);
        expect(Buffer.compare(bytesBefore, bytesAfter)).not.toBe(0);
      } finally {
        await cleanup();
      }
    },
    30000,
  );

  it.skipIf(!hasChromium)(
    'tints a textured sprite from SpriteRenderer.color, and the default #ffffff renders identically to omitting color',
    async () => {
      const { store, cleanup, sheetId, frames } = await makeSheetStore();
      try {
        const [frameA] = frames;
        const session = HearthSession.fromStore(store, { granted: ['asset-edit', 'safe-edit'] });

        await session.execute('createEntity', {
          scene: 'Main',
          name: 'TintTest',
          position: { x: 480, y: 270 },
          components: { SpriteRenderer: { assetId: sheetId, frame: frameA, width: 64, height: 64 } },
        });

        // Default color (schema default '#ffffff', not specified above).
        const defaultCapture = await captureScreenshot(store, { out: 'shots/tint-default.png' });

        const setWhite = await session.execute('setComponentProperty', {
          scene: 'Main',
          entity: 'TintTest',
          property: 'SpriteRenderer.color',
          value: '#ffffff',
        });
        expect(setWhite.success).toBe(true);
        const explicitWhiteCapture = await captureScreenshot(store, { out: 'shots/tint-white.png' });

        const setRed = await session.execute('setComponentProperty', {
          scene: 'Main',
          entity: 'TintTest',
          property: 'SpriteRenderer.color',
          value: '#ff0000',
        });
        expect(setRed.success).toBe(true);
        const redCapture = await captureScreenshot(store, { out: 'shots/tint-red.png' });

        const [defaultBytes, whiteBytes, redBytes] = await Promise.all([
          readFile(defaultCapture.path),
          readFile(explicitWhiteCapture.path),
          readFile(redCapture.path),
        ]);
        // Default color must render pixel-identical to the pre-tint-support
        // baseline: explicitly setting the default value must be indistinguishable
        // from never having touched color at all.
        expect(Buffer.compare(defaultBytes, whiteBytes)).toBe(0);
        // A non-default tint must actually change the rendered pixels.
        expect(Buffer.compare(whiteBytes, redBytes)).not.toBe(0);
      } finally {
        await cleanup();
      }
    },
    30000,
  );

  // Font-type assets are loaded via FontFace at mount so
  // Text.fontFamily can reference one by asset name. captureScreenshot
  // doesn't expose the underlying Playwright page to callers (see notes
  // above), so `document.fonts.check(...)` isn't reachable from here.
  //
  // A naive "custom font name vs. literal 'monospace'" pixel diff would be a
  // false positive: Chromium falls back to some default font for ANY
  // unrecognized font-family name, so those two captures would differ even
  // if loadFonts were never wired up at all (the fontFamily string simply
  // wouldn't resolve to anything real either way). To isolate the actual
  // causal effect of the font asset being loaded, both captures below use
  // the EXACT SAME fontFamily string ('PressStart2P') — the only thing that
  // changes between them is whether that name is backed by a registered
  // FontFace (the asset present vs. removed via `removeAsset`). If loadFonts
  // is working, removing the asset must change what "PressStart2P" renders
  // as; if it's a no-op (or never wired up), both captures render the same
  // unresolved-name fallback and would be byte-identical.
  // Genuinely heavier than its sibling captures here: a real font file import
  // + FontFace load through actual Chromium, plus two full captures. Fast
  // locally but has timed out on slower shared macos-latest CI runners well
  // under 30s of margin; give it the same 120s budget the other at-scale
  // real-browser/determinism tests use (goldenDeterminism colliders-1500,
  // broadphase, sustained-horde-scale). Load-time headroom, not a
  // correctness change.
  it.skipIf(!hasChromium)(
    'renders a Text entity differently once its named font asset is loaded vs. removed from the project',
    async () => {
      const { store, cleanup } = await makeRealStore();
      try {
        const session = HearthSession.fromStore(store, { granted: ['asset-edit', 'safe-edit'] });

        const imported = await session.execute<{ asset: { id: string } }>('importAsset', {
          sourcePath: FONT_FIXTURE_PATH,
          name: 'PressStart2P',
          type: 'font',
        });
        expect(imported.success).toBe(true);
        const fontAssetId = imported.data!.asset.id;

        // Player's dynamic PhysicsBody falls a little every fixed step —
        // disable it so it can't confound the pixel comparison below (same
        // rationale as the SpriteAnimator/sheet-frame tests above).
        const disabledPlayer = await session.execute('setEntityEnabled', {
          scene: 'Main',
          entity: 'Player',
          enabled: false,
        });
        expect(disabledPlayer.success).toBe(true);

        const entity = await session.execute('createEntity', {
          scene: 'Main',
          name: 'FontTest',
          position: { x: 480, y: 270 },
          components: {
            Text: { content: 'Hearth', fontSize: 64, fontFamily: 'PressStart2P', color: '#ffffff' },
          },
        });
        expect(entity.success).toBe(true);

        const withFontCapture = await captureScreenshot(store, { out: 'shots/font-loaded.png' });

        // Text.fontFamily is left untouched ('PressStart2P') — only the
        // backing asset goes away, so any pixel change can only come from
        // the name no longer resolving to a loaded FontFace.
        const removed = await session.execute('removeAsset', {
          asset: fontAssetId,
          deleteFile: true,
        });
        expect(removed.success).toBe(true);
        const withoutFontCapture = await captureScreenshot(store, { out: 'shots/font-removed.png' });

        const [withFontBytes, withoutFontBytes] = await Promise.all([
          readFile(withFontCapture.path),
          readFile(withoutFontCapture.path),
        ]);
        expect(Buffer.compare(withFontBytes, withoutFontBytes)).not.toBe(0);
      } finally {
        await cleanup();
      }
    },
    120_000,
  );

  // A font asset whose file isn't real font data (bogus/corrupt, as opposed
  // to a MISSING file — importAsset always copies real bytes in, so "the
  // referenced file is gone" isn't reachable through the public asset
  // commands) must not take mount/render down with it: FontFace.load()
  // rejects, loadFonts's per-font try/catch reports it via onLog and moves
  // on. The exact onLog message and the "one bad font doesn't block the
  // rest" behavior are unit-tested directly against loadFontFaces in
  // packages/runtime/tests/fonts.test.ts; onLog isn't wired to the browser
  // console anywhere in the exported player today (same pre-existing gap as
  // every other onLog call site in pixi/index.ts, e.g. texture-load
  // failures), so there's nothing for a Playwright console listener to
  // observe here — this test's job is just "does not throw".
  it.skipIf(!hasChromium)(
    'mounts without throwing when a font asset points at invalid (non-font) file data',
    async () => {
      const { store, cleanup } = await makeRealStore();
      try {
        const session = HearthSession.fromStore(store, { granted: ['asset-edit', 'safe-edit'] });

        const badFontPath = path.join(os.tmpdir(), `hearth-bad-font-${Math.random().toString(36).slice(2)}.ttf`);
        await writeFileNode(badFontPath, 'this is definitely not TrueType/OpenType font data');
        const imported = await session.execute<{ asset: { id: string } }>('importAsset', {
          sourcePath: badFontPath,
          name: 'BadFont',
          type: 'font',
        });
        expect(imported.success).toBe(true);

        await expect(captureScreenshot(store, { out: 'shots/bad-font.png' })).resolves.toMatchObject({
          frame: 0,
        });
      } finally {
        await cleanup();
      }
    },
    30000,
  );

  // Camera.postEffects render as hand-written Pixi filters on the game
  // view. Each of the six effect types, applied to a scene with real content,
  // must change the captured pixels versus no effect. One shared OFF baseline
  // is compared against each effect ON (each setComponentProperty overwrites
  // the whole postEffects array, so no reset between effects is needed).
  it.skipIf(!hasChromium)(
    'each of the six post effects changes the rendered frame vs. no effect',
    async () => {
      const { store, cleanup } = await makePostFxStore();
      try {
        const session = HearthSession.fromStore(store, { granted: ['safe-edit'] });
        const off = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/post-off.png' });
        const offBytes = await readFile(off.path);

        const effects: Array<{ label: string; stack: unknown[] }> = [
          { label: 'bloom', stack: [{ type: 'bloom', strength: 2.5, threshold: 0.3 }] },
          { label: 'crt', stack: [{ type: 'crt', curvature: 0.5, scanlineIntensity: 0.6, noise: 0.3 }] },
          { label: 'vignette', stack: [{ type: 'vignette', intensity: 1, color: '#000000' }] },
          { label: 'chromaticAberration', stack: [{ type: 'chromaticAberration', offset: 12 }] },
          { label: 'pixelate', stack: [{ type: 'pixelate', size: 16 }] },
          {
            label: 'colorGrade',
            stack: [{ type: 'colorGrade', brightness: 1.6, contrast: 1.4, saturation: 0.2, tint: '#ff8800' }],
          },
        ];

        for (const { label, stack } of effects) {
          const set = await session.execute('setComponentProperty', {
            scene: 'Main',
            entity: 'Main Camera',
            property: 'Camera.postEffects',
            value: stack,
          });
          expect(set.success, `set ${label}`).toBe(true);
          const on = await captureScreenshot(store, { frame: 0, seed: 1, out: `shots/post-${label}.png` });
          const onBytes = await readFile(on.path);
          expect(Buffer.compare(offBytes, onBytes), `${label} must change pixels`).not.toBe(0);
        }
      } finally {
        await cleanup();
      }
    },
    120_000,
  );

  // Full-screen coverage: post effects must reach the BACKGROUND, not just
  // drawn sprite texels. Both starter renderables (Player, Ground) are
  // disabled so nothing renders except the camera background — if the
  // renderer's clear color were still the only background (outside the
  // filter input), or if the filter host's bounds collapsed to an empty/
  // content bbox, vignette ON would be byte-identical to OFF. Any pixel
  // difference here can only be background pixels changing (corners
  // darkening toward the vignette color), which is exactly the guarantee
  // this locks in.
  it.skipIf(!hasChromium)(
    'vignette darkens the camera background itself, not just sprite content',
    async () => {
      const { store, cleanup } = await makeRealStore();
      try {
        const session = HearthSession.fromStore(store, { granted: ['safe-edit'] });
        for (const entity of ['Player', 'Ground']) {
          const disabled = await session.execute('setEntityEnabled', {
            scene: 'Main',
            entity,
            enabled: false,
          });
          expect(disabled.success, `disable ${entity}`).toBe(true);
        }
        const setBg = await session.execute('setComponentProperty', {
          scene: 'Main',
          entity: 'Main Camera',
          property: 'Camera.backgroundColor',
          value: '#008080',
        });
        expect(setBg.success).toBe(true);

        const off = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/bg-off.png' });

        const setVignette = await session.execute('setComponentProperty', {
          scene: 'Main',
          entity: 'Main Camera',
          property: 'Camera.postEffects',
          value: [{ type: 'vignette', intensity: 1, color: '#000000' }],
        });
        expect(setVignette.success).toBe(true);
        const on = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/bg-on.png' });

        const [offBytes, onBytes] = await Promise.all([readFile(off.path), readFile(on.path)]);
        expect(Buffer.compare(offBytes, onBytes)).not.toBe(0);
      } finally {
        await cleanup();
      }
    },
    30000,
  );

  // Neutral guard: an explicitly-empty postEffects stack must render
  // byte-identical to never having set one (gameView restructure is
  // render-neutral, filters = null). Mirrors the white-tint no-op regression.
  it.skipIf(!hasChromium)(
    'an empty postEffects stack is byte-identical to no post effects',
    async () => {
      const { store, cleanup } = await makePostFxStore();
      try {
        const session = HearthSession.fromStore(store, { granted: ['safe-edit'] });
        const baseline = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/post-baseline.png' });
        const setEmpty = await session.execute('setComponentProperty', {
          scene: 'Main',
          entity: 'Main Camera',
          property: 'Camera.postEffects',
          value: [],
        });
        expect(setEmpty.success).toBe(true);
        const empty = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/post-empty.png' });

        const [baselineBytes, emptyBytes] = await Promise.all([
          readFile(baseline.path),
          readFile(empty.path),
        ]);
        expect(Buffer.compare(baselineBytes, emptyBytes)).toBe(0);
      } finally {
        await cleanup();
      }
    },
    60_000,
  );

  // SpriteEffects (outline/flash/dissolve) render as one combined
  // per-sprite filter. Each non-neutral field must change the pixels, while a
  // default (all no-op) SpriteEffects component must be byte-identical to
  // having no component at all — the load-bearing no-op invariant.
  it.skipIf(!hasChromium)(
    'sprite outline, dissolve, and flash change pixels; a default SpriteEffects component is a no-op',
    async () => {
      const { store, cleanup } = await makeSpriteFxStore();
      try {
        const session = HearthSession.fromStore(store, { granted: ['safe-edit'] });
        const baseline = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/fx-baseline.png' });
        const baselineBytes = await readFile(baseline.path);

        // Default SpriteEffects component: attaches no filter → no-op.
        const added = await session.execute('addComponent', {
          scene: 'Main',
          entity: 'FxSprite',
          type: 'SpriteEffects',
        });
        expect(added.success).toBe(true);
        const neutral = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/fx-neutral.png' });
        expect(Buffer.compare(baselineBytes, await readFile(neutral.path))).toBe(0);

        // Outline on.
        const outline = await session.execute('setProperties', {
          scene: 'Main',
          entity: 'FxSprite',
          properties: {
            'SpriteEffects.outlineEnabled': true,
            'SpriteEffects.outlineColor': '#ff0000',
            'SpriteEffects.outlineWidth': 5,
          },
        });
        expect(outline.success).toBe(true);
        const outlineCap = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/fx-outline.png' });
        expect(Buffer.compare(baselineBytes, await readFile(outlineCap.path)), 'outline').not.toBe(0);

        // Dissolve 0.5 (reset outline first so it's the only change).
        const dissolve = await session.execute('setProperties', {
          scene: 'Main',
          entity: 'FxSprite',
          properties: {
            'SpriteEffects.outlineEnabled': false,
            'SpriteEffects.dissolveAmount': 0.5,
          },
        });
        expect(dissolve.success).toBe(true);
        const dissolveCap = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/fx-dissolve.png' });
        expect(Buffer.compare(baselineBytes, await readFile(dissolveCap.path)), 'dissolve').not.toBe(0);

        // Flash mid-decay (~0.9167, the first-frame value the decay
        // produces). Reset dissolve so flash is the only active field.
        const flash = await session.execute('setProperties', {
          scene: 'Main',
          entity: 'FxSprite',
          properties: {
            'SpriteEffects.dissolveAmount': 0,
            'SpriteEffects.flashColor': '#ffffff',
            'SpriteEffects.flashStrength': 0.9167,
          },
        });
        expect(flash.success).toBe(true);
        const flashCap = await captureScreenshot(store, { frame: 0, seed: 1, out: 'shots/fx-flash.png' });
        expect(Buffer.compare(baselineBytes, await readFile(flashCap.path)), 'flash').not.toBe(0);
      } finally {
        await cleanup();
      }
    },
    120_000,
  );
});
