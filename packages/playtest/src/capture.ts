/**
 * `captureSequence`: capture a frame *sequence* of a scene and lay it out as a
 * single contact-sheet PNG (a near-square grid of frame tiles across time) so
 * an agent can judge motion, juice, and timing from ONE image read instead of
 * an expensive screenshot-step-screenshot loop.
 *
 * Modelled directly on ./screenshot.ts's `captureScreenshot`: it runs the same
 * ephemeral `exportWeb` into a scratch dir, injects the same manual-stepping
 * boot override, boots the single-file build in headless Chromium, and drives
 * the `window.__hearth.step(n)` / `window.__hearth.render()` seam. The
 * difference is that it BOOTS ONCE and then steps forward to each requested
 * frame, capturing the canvas at each — and, by default, composes the montage
 * *in the page* (an offscreen 2D canvas) so no image-decoding dependency is
 * needed on the Node side.
 *
 * `playwright-core` is imported lazily (inside `launchChromium`) and declared
 * as an `optionalDependency`, for exactly the same reason screenshot.ts does
 * it: @hearth/cli and @hearth/mcp-server both pull in @hearth/playtest
 * unconditionally, so this module must load fine even when Chromium tooling
 * isn't installed.
 *
 * Permissions: like `captureScreenshot`, this runs an ephemeral `exportWeb`
 * and so needs "build" mode. It does NOT check permissions itself — its
 * internal session is granted "build" unconditionally; callers (the future
 * CLI command / MCP tool) must check the *caller's* grant first.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HearthSession, isSafeOut, joinPath, type ProjectStore } from '@hearth/core';
import { loadPlayerBundle } from '@hearth/core/node';
import { CHROMIUM_MISSING_ERROR, injectBootScript, waitForBootReady } from './screenshot.js';

/** Hard cap on captured frames; above this, callers must raise `step`. */
export const MAX_SEQUENCE_FRAMES = 64;

export interface CaptureSequenceOptions {
  /** Scene id or name; default: the project's initial scene. */
  scene?: string;
  /** Session seed; default 0. Determinism inherits from the step seam. */
  seed?: number;
  /** Per-frame (tile) size; default: buildSettings.width/height, else 960x540. */
  size?: { width: number; height: number };
  /** First frame index to capture; default 0. */
  from?: number;
  /** Last frame index to capture (inclusive). Required. */
  to: number;
  /**
   * Frames between captures. Default: chosen so the total stays <= 32.
   * An explicit step is honoured, but the total still can't exceed the
   * MAX_SEQUENCE_FRAMES hard cap.
   */
  step?: number;
  /**
   * true (default): compose one contact-sheet PNG. false: write one PNG per
   * frame as `<outPath minus .png>-f<frame>.png`.
   */
  sheet?: boolean;
  /**
   * Output PNG path, project-relative — absolute paths and `..` traversal are
   * rejected (same sandbox rule as screenshot's `out`). Default:
   * 'capture.png'.
   */
  outPath?: string;
}

export interface CaptureSequenceResult {
  /** Written PNG paths (absolute). One element in sheet mode; N in per-frame mode. */
  outPaths: string[];
  /** The frame indices actually captured, ascending. */
  frames: number[];
  /** Per-frame tile size. */
  size: { width: number; height: number };
  /** Contact-sheet grid geometry. */
  sheet: { cols: number; rows: number };
}

/**
 * Near-square grid geometry for `n` tiles: `cols = ceil(sqrt(n))`, then just
 * enough rows to hold every tile. Pure and unit-tested without Chromium.
 */
export function gridDimensions(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { cols, rows };
}

/**
 * The ascending list of frame indices to capture over `[from, to]` inclusive.
 * With no explicit `step`, picks the smallest step that keeps the count at or
 * under 32 (the agent-facing sweet spot). Pure and unit-tested without
 * Chromium; the MAX_SEQUENCE_FRAMES hard cap is enforced by the caller so the
 * error can name the option to raise.
 */
export function computeFrames(from: number, to: number, step?: number): number[] {
  if (to < from) {
    throw new Error(`captureSequence: "to" (${to}) must be >= "from" (${from})`);
  }
  const range = to - from;
  const chosen = step ?? Math.max(1, Math.ceil(range / 31));
  if (!Number.isFinite(chosen) || chosen < 1) {
    throw new Error(`captureSequence: step must be a positive integer (got: ${step})`);
  }
  const frames: number[] = [];
  for (let f = from; f <= to; f += chosen) frames.push(f);
  return frames;
}

// Minimal structural mirrors of the Playwright surface this module uses — kept
// local (not imported from screenshot.ts, which doesn't export them) so this
// file typechecks under the package's Node-only, no-DOM-lib tsconfig.
type PlaywrightBrowser = { newPage(opts?: unknown): Promise<PlaywrightPage>; close(): Promise<void> };
type PlaywrightPage = {
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: () => unknown): Promise<unknown>;
  evaluate<T>(fn: (arg: T) => unknown, arg?: T): Promise<unknown>;
  locator(selector: string): { screenshot(opts: { path: string }): Promise<unknown> };
  on(event: 'pageerror', handler: (error: Error) => void): unknown;
  on(event: 'console', handler: (message: { type(): string; text(): string }) => void): unknown;
};
type Chromium = { launch(opts: Record<string, unknown>): Promise<PlaywrightBrowser> };

/**
 * Launch some flavour of Chromium — a local re-implementation of
 * screenshot.ts's private `launchChromium` (it isn't exported, and this task
 * may not edit screenshot.ts). Same strategy order and same missing-browser
 * error contract.
 */
async function launchChromium(): Promise<PlaywrightBrowser> {
  let chromium: Chromium;
  try {
    ({ chromium } = (await import('playwright-core')) as unknown as { chromium: Chromium });
  } catch {
    throw new Error(CHROMIUM_MISSING_ERROR);
  }

  const attempts: Array<() => Promise<PlaywrightBrowser>> = [
    () => chromium.launch({ channel: 'chrome', headless: true }),
    () => chromium.launch({ channel: 'msedge', headless: true }),
  ];
  if (process.env.CHROMIUM_PATH) {
    attempts.push(() => chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true }));
  }
  attempts.push(() => chromium.launch({ headless: true }));

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch {
      // try the next strategy
    }
  }
  throw new Error(CHROMIUM_MISSING_ERROR);
}

function randomSuffix(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Step the manual-mode player forward from `current` to absolute frame
 * `target`, then force a render. `window.__hearth.step(n)` advances n frames
 * from wherever it is (it never resets), so we only ever step the delta.
 */
async function stepAndRender(page: PlaywrightPage, current: number, target: number): Promise<void> {
  const delta = target - current;
  if (delta > 0) {
    await page.evaluate(
      (n: number) =>
        (globalThis as unknown as { __hearth: { step(n: number): Promise<void> } }).__hearth.step(n),
      delta,
    );
  }
  await page.evaluate(() => (globalThis as unknown as { __hearth: { render(): void } }).__hearth.render());
}

/**
 * Capture a frame sequence of a scene as a contact sheet (default) or as one
 * PNG per frame. Exports a single-file build, injects the manual-stepping boot
 * override, boots headless Chromium once, then steps to each requested frame.
 */
export async function captureSequence(
  store: ProjectStore,
  opts: CaptureSequenceOptions,
): Promise<CaptureSequenceResult> {
  const outPath = opts.outPath ?? 'capture.png';
  // Same sandbox rule as screenshot's `out`: agent-facing surface, must stay
  // inside the project root (no absolute paths, no ".." traversal).
  if (!isSafeOut(outPath)) {
    throw new Error(
      `captureSequence: outPath must be a project-relative path (no absolute paths or "..") (got: ${outPath})`,
    );
  }

  const resolvedScene = opts.scene
    ? store.getScene(opts.scene)
    : store.getScene(store.project.initialScene ?? store.project.scenes[0]?.id ?? '');
  if (!resolvedScene) {
    throw new Error(`captureSequence: scene not found: ${opts.scene ?? '(initial scene)'}`);
  }

  const buildSettings = store.project.buildSettings as { width?: number; height?: number };
  const width = opts.size?.width ?? buildSettings.width ?? 960;
  const height = opts.size?.height ?? buildSettings.height ?? 540;

  const from = opts.from ?? 0;
  const frames = computeFrames(from, opts.to, opts.step);
  if (frames.length > MAX_SEQUENCE_FRAMES) {
    throw new Error(
      `captureSequence: ${frames.length} frames requested, over the ${MAX_SEQUENCE_FRAMES}-frame cap — ` +
        'raise `step` (or narrow the from/to range) to capture fewer frames.',
    );
  }

  const useSheet = opts.sheet ?? true;
  const { cols, rows } = gridDimensions(frames.length);

  // Ephemeral session scoped to this call: only used to run exportWeb into a
  // scratch dir. Its "build" grant isn't a policy decision — the caller must
  // have already checked permission (see the module doc comment).
  const session = HearthSession.fromStore(store, {
    granted: ['build'],
    source: 'export',
    resources: { getPlayerBundle: () => loadPlayerBundle() },
  });

  const outDir = `.hearth-tmp/capture-${randomSuffix()}`;
  let osTmpDir: string | undefined;
  try {
    const exportResult = await session.execute<{ outDir: string }>('exportWeb', {
      outDir,
      singleFile: true,
    });
    if (!exportResult.success) {
      const message = exportResult.errors.map((e) => e.message).join('; ') || 'export failed';
      throw new Error(`captureSequence: could not export a build to capture: ${message}`);
    }

    const htmlPath = joinPath(store.root, outDir, 'index.html');
    const html = await store.fs.readFile(htmlPath);
    const injected = injectBootScript(html, {
      manual: true,
      seed: opts.seed ?? 0,
      width: opts.size?.width,
      height: opts.size?.height,
      scene: resolvedScene.id,
    });

    // Chromium navigates a real file:// path; the store's fs may be in-memory,
    // so materialize the injected HTML on the real OS filesystem.
    osTmpDir = await mkdtemp(path.join(tmpdir(), 'hearth-capture-'));
    const htmlFile = path.join(osTmpDir, 'index.html');
    await writeFile(htmlFile, injected, 'utf8');

    const browser = await launchChromium();
    try {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await waitForBootReady(page, () => page.goto(pathToFileURL(htmlFile).href));

      if (!useSheet) {
        // One PNG per frame: step to each frame, render, screenshot the canvas.
        const base = outPath.replace(/\.png$/i, '');
        const outPaths: string[] = [];
        let current = 0;
        for (const frame of frames) {
          await stepAndRender(page, current, frame);
          current = frame;
          const framePath = path.resolve(store.root, `${base}-f${frame}.png`);
          await mkdir(path.dirname(framePath), { recursive: true });
          await page.locator('canvas').screenshot({ path: framePath });
          outPaths.push(framePath);
        }
        return { outPaths, frames, size: { width, height }, sheet: { cols, rows } };
      }

      // Contact sheet: build an offscreen 2D canvas of cols x rows tiles in the
      // page, draw each captured game frame into its cell (rendering and
      // drawImage happen in the SAME task so the WebGL drawing buffer — not
      // preserved across frame boundaries — is still readable), then screenshot
      // that composite once.
      await page.evaluate(
        (arg: { cols: number; rows: number; tileW: number; tileH: number }) => {
          const g = globalThis as unknown as {
            document: {
              querySelector(s: string): unknown;
              createElement(t: string): unknown;
              body: { appendChild(n: unknown): void };
            };
            __hearthCap?: unknown;
          };
          const gameCanvas = g.document.querySelector('canvas');
          const sheet = g.document.createElement('canvas') as unknown as {
            id: string;
            width: number;
            height: number;
            getContext(t: string): unknown;
          };
          sheet.id = '__hearth_contact_sheet';
          sheet.width = arg.cols * arg.tileW;
          sheet.height = arg.rows * arg.tileH;
          const ctx = sheet.getContext('2d') as unknown as {
            fillStyle: string;
            font: string;
            textBaseline: string;
            fillRect(x: number, y: number, w: number, h: number): void;
            fillText(t: string, x: number, y: number): void;
            drawImage(img: unknown, x: number, y: number, w: number, h: number): void;
            measureText(t: string): { width: number };
          };
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, sheet.width, sheet.height);
          g.document.body.appendChild(sheet);
          (g as unknown as { __hearthCap: unknown }).__hearthCap = {
            gameCanvas,
            ctx,
            cols: arg.cols,
            tileW: arg.tileW,
            tileH: arg.tileH,
          };
        },
        { cols, rows, tileW: width, tileH: height },
      );

      let current = 0;
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const delta = frame - current;
        if (delta > 0) {
          await page.evaluate(
            (n: number) =>
              (globalThis as unknown as { __hearth: { step(n: number): Promise<void> } }).__hearth.step(n),
            delta,
          );
        }
        current = frame;
        // render() and drawImage in one evaluate: single JS task, so the WebGL
        // buffer is intact when we read it into the tile.
        await page.evaluate(
          (arg: { idx: number; frame: number }) => {
            const g = globalThis as unknown as {
              __hearth: { render(): void };
              __hearthCap: {
                gameCanvas: unknown;
                ctx: {
                  fillStyle: string;
                  font: string;
                  textBaseline: string;
                  fillRect(x: number, y: number, w: number, h: number): void;
                  fillText(t: string, x: number, y: number): void;
                  drawImage(img: unknown, x: number, y: number, w: number, h: number): void;
                  measureText(t: string): { width: number };
                };
                cols: number;
                tileW: number;
                tileH: number;
              };
            };
            g.__hearth.render();
            const cap = g.__hearthCap;
            const col = arg.idx % cap.cols;
            const row = Math.floor(arg.idx / cap.cols);
            const dx = col * cap.tileW;
            const dy = row * cap.tileH;
            cap.ctx.drawImage(cap.gameCanvas, dx, dy, cap.tileW, cap.tileH);
            // Frame number: monospace, on a translucent backing rect so it's
            // legible over any scene content.
            const label = String(arg.frame);
            cap.ctx.font = '12px monospace';
            cap.ctx.textBaseline = 'top';
            const tw = cap.ctx.measureText(label).width;
            cap.ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
            cap.ctx.fillRect(dx + 2, dy + 2, tw + 8, 16);
            cap.ctx.fillStyle = '#ffffff';
            cap.ctx.fillText(label, dx + 6, dy + 4);
          },
          { idx: i, frame },
        );
      }

      // Hide the live game canvas so the element screenshot below captures only
      // the composite (element screenshots clip to the element's box, but this
      // keeps overlapping paints out of the frame regardless of stacking).
      await page.evaluate(() => {
        const c = (globalThis as unknown as { document: { querySelector(s: string): unknown } }).document.querySelector(
          'canvas',
        ) as unknown as { style: { display: string } } | null;
        if (c) c.style.display = 'none';
      });

      const sheetPath = path.resolve(store.root, outPath);
      await mkdir(path.dirname(sheetPath), { recursive: true });
      await page.locator('#__hearth_contact_sheet').screenshot({ path: sheetPath });

      return { outPaths: [sheetPath], frames, size: { width, height }, sheet: { cols, rows } };
    } finally {
      await browser.close();
    }
  } finally {
    if (osTmpDir) await rm(osTmpDir, { recursive: true, force: true });
    // Best-effort scratch cleanup (mirrors captureScreenshot): remove this
    // call's export dir, then the shared .hearth-tmp/ parent iff now empty.
    await store.fs.remove(joinPath(store.root, outDir)).catch(() => {});
    const tmpParent = joinPath(store.root, '.hearth-tmp');
    try {
      if ((await store.fs.readdir(tmpParent)).length === 0) await store.fs.remove(tmpParent);
    } catch {
      // parent absent or non-empty-race — fine either way
    }
  }
}
