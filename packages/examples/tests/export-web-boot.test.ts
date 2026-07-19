/**
 * The script-modules export proof (spec: "a web export of a project with
 * scripts/lib/* boots and plays — proves recursion reaches the bundler").
 *
 * exportCommands bundles scripts by enumerating store.listScripts(), which
 * was flat until this wave made it recursive. If that chain regresses,
 * scripts/lib/noise.lua silently does not ship, every unit test still
 * passes, and exported games break where they actually run. So this suite
 * checks the exported artifact itself, then boots it in real Chromium:
 *
 * 1. (always) The single-file export's inline bundle contains the
 *    scripts/lib/noise.lua module and both behaviors that require it.
 * 2. (Chromium-gated, same it.skipIf pattern as playtest's
 *    screenshot.test.ts) The export boots headlessly with zero page/console
 *    errors, and the rendered map is causally seed-driven: two boots at the
 *    same seed render byte-identical canvases while a different seed renders
 *    a different map. crystal-warrens authors its Tilemap fully solid and
 *    only the carver (through require("lib/noise") + seeded ctx.random)
 *    opens it, so a dead require would render the same wall slab at every
 *    seed — the cross-seed pixel difference is the proof the module chain
 *    runs inside the exported build. (Script errors never surface as page
 *    errors — the runtime records them defensively — which is why boot
 *    success alone would prove nothing.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HearthSession, ProjectStore } from '@hearth/core';
import { NodeFileSystem, loadPlayerBundle } from '@hearth/core/node';
import { canLaunchChromium, injectBootScript, CHROMIUM_MISSING_ERROR } from '@hearth/playtest';

const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Frames to step before capturing: covers the frame-0 carve/growth and the frame-1 connectivity re-proof. */
const STEP_FRAMES = 12;

let tmpRoot: string;
let exportedHtml: string;

// Export once for the whole suite: copy the committed example to an OS temp
// dir (so a crash can never dirty the committed tree), then run the real
// exportWeb command — the same operation `hearth export web --single-file`
// performs — with the "build" grant it requires.
beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'hearth-export-proof-'));
  await cp(path.join(examplesDir, 'crystal-warrens'), tmpRoot, { recursive: true });
  const store = await ProjectStore.load(new NodeFileSystem(), tmpRoot);
  const session = HearthSession.fromStore(store, {
    granted: ['build'],
    resources: { getPlayerBundle: () => loadPlayerBundle() },
  });
  const result = await session.execute('exportWeb', { outDir: 'export/web', singleFile: true });
  if (!result.success) {
    throw new Error('exportWeb failed: ' + result.errors.map((e) => e.message).join('; '));
  }
  exportedHtml = await readFile(path.join(tmpRoot, 'export/web/index.html'), 'utf8');
}, 60_000);

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

describe('crystal-warrens web export ships the scripts/lib module', () => {
  it('bundles the nested library path and its source', () => {
    // The bundle's script map is keyed by project-relative path — the
    // nested key only exists because listScripts() recurses.
    expect(exportedHtml).toContain('scripts/lib/noise.lua');
    // And the module's actual source shipped, not just a dangling key.
    expect(exportedHtml).toContain('function noise.caveOpen');
    expect(exportedHtml).toContain('function noise.value2');
  });

  it('bundles both behaviors that require the library', () => {
    expect(exportedHtml).toContain('scripts/cave-carver.lua');
    expect(exportedHtml).toContain('scripts/crystal-grower.lua');
    // require("lib/noise") appears JSON-escaped inside the inline bundle.
    const requires = exportedHtml.split('require(\\"lib/noise\\")').length - 1;
    expect(requires).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Real Chromium boot: gated so the suite passes with no browser present.
// ---------------------------------------------------------------------------
const hasChromium = await canLaunchChromium();

type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: () => unknown): Promise<unknown>;
  evaluate<T>(fn: (arg: T) => unknown, arg?: T): Promise<unknown>;
  locator(selector: string): { screenshot(): Promise<Buffer> };
  on(event: string, handler: (arg: never) => void): unknown;
  close(): Promise<void>;
};
type Browser = { newPage(opts?: unknown): Promise<Page>; close(): Promise<void> };

/** Same launch ladder as playtest's screenshot.ts (chrome → msedge → CHROMIUM_PATH → bundled). */
async function launchChromium(): Promise<Browser> {
  const { chromium } = (await import('playwright-core')) as unknown as {
    chromium: { launch(opts: Record<string, unknown>): Promise<Browser> };
  };
  // Force deterministic software rendering (ANGLE + SwiftShader). Hardware GPUs
  // produce sub-pixel jitter between two renders of the same scene, which made
  // the same-seed "byte-identical frame" assertion flake on CI (macOS). With
  // SwiftShader the render is reproducible, so same-seed stays byte-identical
  // while different-seed still differs.
  const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--force-color-profile=srgb'];
  const attempts: Array<() => Promise<Browser>> = [
    () => chromium.launch({ channel: 'chrome', headless: true, args: GL_ARGS }),
    () => chromium.launch({ channel: 'msedge', headless: true, args: GL_ARGS }),
  ];
  if (process.env.CHROMIUM_PATH) {
    attempts.push(() =>
      chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: GL_ARGS }),
    );
  }
  attempts.push(() => chromium.launch({ headless: true, args: GL_ARGS }));
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch {
      // try the next strategy
    }
  }
  throw new Error(CHROMIUM_MISSING_ERROR);
}

/**
 * Boot the exported build at `seed` in manual-stepping mode, step
 * STEP_FRAMES fixed frames, render, and screenshot the canvas. Any page
 * error or console error at any point fails the capture with its message.
 */
async function captureAtSeed(browser: Browser, seed: number): Promise<Buffer> {
  const injected = injectBootScript(exportedHtml, { manual: true, seed });
  const htmlFile = path.join(tmpRoot, `boot-seed-${seed}.html`);
  await writeFile(htmlFile, injected, 'utf8');

  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    const errors: string[] = [];
    page.on('pageerror', (err: Error) => errors.push(`pageerror: ${err.message || String(err)}`));
    page.on('console', (msg: { type(): string; text(): string }) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(pathToFileURL(htmlFile).href);
    await page.waitForFunction(() =>
      Boolean((globalThis as unknown as { __hearth?: { ready?: boolean } }).__hearth?.ready),
    );
    await page.evaluate(
      (n: number) =>
        (globalThis as unknown as { __hearth: { step(n: number): Promise<void> } }).__hearth.step(n),
      STEP_FRAMES,
    );
    await page.evaluate(
      () => (globalThis as unknown as { __hearth: { render(): void } }).__hearth.render(),
    );
    const bytes = await page.locator('canvas').screenshot();
    expect(errors, `seed ${seed} boot must be error-free`).toEqual([]);
    return bytes;
  } finally {
    await page.close();
  }
}

describe('crystal-warrens web export boots and generates (real Chromium)', () => {
  it.skipIf(!hasChromium)(
    'boots error-free and renders a seed-driven map (same seed identical, different seed different)',
    async () => {
      const browser = await launchChromium();
      try {
        const seed0a = await captureAtSeed(browser, 0);
        const seed0b = await captureAtSeed(browser, 0);
        const seed7 = await captureAtSeed(browser, 7);

        // Same seed → byte-identical frame: the exported build is as
        // deterministic as the headless runtime.
        expect(Buffer.compare(seed0a, seed0b)).toBe(0);
        // Different seed → different map. The only seed-dependent pixels in
        // this scene are the carved grid and the grown crystals, both of
        // which exist only if require("lib/noise") resolved inside the
        // export — a missing module leaves the authored wall slab, which
        // renders identically at every seed.
        expect(Buffer.compare(seed0a, seed7)).not.toBe(0);
      } finally {
        await browser.close();
      }
    },
    180_000,
  );
});
