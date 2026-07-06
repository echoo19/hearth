/**
 * `hearth screenshot`: capture a deterministic PNG of a scene via headless
 * Chromium, driven through the manual-stepping seam Task 8 built into the
 * web player (`window.__HEARTH_BOOT__` / `window.__hearth`, see
 * `@hearth/runtime`'s `player/bootOverrides.ts` and `player/index.ts`).
 *
 * Lives in @hearth/playtest (not @hearth/cli or @hearth/mcp-server) so both
 * consumers — which already depend on this package for
 * `createRuntimeHooks()` — can call it symmetrically, without either one
 * depending on the other. See the Task 9 report for the fuller rationale.
 *
 * `playwright-core` is imported lazily (inside `launchChromium`) so this
 * module — and therefore @hearth/cli and @hearth/mcp-server, which both pull
 * in @hearth/playtest unconditionally — loads fine even when
 * `playwright-core` isn't installed. It's declared as an
 * `optionalDependency` of this package for the same reason.
 *
 * Permissions: capturing a screenshot always runs an ephemeral `exportWeb`
 * (the same operation `hearth export web` performs), so it requires the
 * same "build" permission mode. This function does NOT check permissions
 * itself — its internal export session is granted "build" unconditionally.
 * Callers (the CLI command, the MCP tool) are responsible for checking the
 * *caller's* session grants "build" before calling `captureScreenshot`, the
 * same way every other build-gated command is checked, and returning the
 * standard PERMISSION_DENIED shape if not.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HearthSession, isSafeOut, joinPath, type ProjectStore } from '@hearth/core';
import { loadPlayerBundle } from '@hearth/core/node';
import { type BootOverrides } from '@hearth/runtime';

export interface ScreenshotOptions {
  /** Scene id or name; default: the project's initial scene. */
  scene?: string;
  /** Fixed frames to step before capture; default 0. */
  frame?: number;
  /** Session seed; default 0. */
  seed?: number;
  /** Canvas width override (default: buildSettings.width). */
  width?: number;
  /** Canvas height override (default: buildSettings.height). */
  height?: number;
  /** Enable the debug overlay (collider/velocity/light outlines). */
  debug?: boolean;
  /**
   * Output PNG path, project-relative — absolute paths and `..` traversal
   * are rejected (same sandbox rule as buildProject/exportWeb's outDir).
   * Default: 'screenshot.png'.
   */
  out?: string;
}

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  frame: number;
  scene: string;
}

export const CHROMIUM_MISSING_ERROR =
  'hearth screenshot needs Chrome or Chromium installed (or CHROMIUM_PATH set). ' +
  'Install Google Chrome, or: npx playwright install chromium';

/**
 * `</script` is a valid escape inside a JS string literal — the only place
 * it can legally appear in JSON.stringify output — so this is safe and
 * mirrors exportCommands.ts's own `escapeScriptContent` (used there to keep
 * the inlined bundle JSON from prematurely closing its <script> tag).
 */
function escapeScriptContent(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/**
 * Insert `<script>window.__HEARTH_BOOT__ = {...}</script>` right before the
 * player's `<script>` tag in a single-file `exportWeb` HTML document — i.e.
 * right after the `hearthBoot` helper's closing `</script>`, per Task 8's
 * verified insertion point (see exportCommands.ts's `renderIndexHtml` and
 * the Task 8 report's "notes for Task 9"). Pure and independently testable.
 */
export function injectBootScript(html: string, overrides: BootOverrides): string {
  const anchor = 'function hearthBoot(load)';
  const anchorIdx = html.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(
      'injectBootScript: could not find the hearthBoot() helper in the exported HTML ' +
        '(exportCommands.ts\'s template may have changed).',
    );
  }
  const closeIdx = html.indexOf('</script>', anchorIdx);
  if (closeIdx === -1) {
    throw new Error('injectBootScript: found hearthBoot() but no closing </script> after it.');
  }
  const insertAt = closeIdx + '</script>'.length;
  const payload = escapeScriptContent(JSON.stringify(overrides));
  const scriptTag = `\n  <script>window.__HEARTH_BOOT__ = ${payload};</script>`;
  return html.slice(0, insertAt) + scriptTag + html.slice(insertAt);
}

type PlaywrightBrowser = { newPage(opts?: unknown): Promise<PlaywrightPage>; close(): Promise<void> };
type PlaywrightConsoleMessage = { type(): string; text(): string };
type PlaywrightPage = {
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: () => unknown): Promise<unknown>;
  evaluate<T>(fn: (arg: T) => unknown, arg?: T): Promise<unknown>;
  locator(selector: string): { screenshot(opts: { path: string }): Promise<unknown> };
  on(event: 'pageerror', handler: (error: Error) => void): unknown;
  on(event: 'console', handler: (message: PlaywrightConsoleMessage) => void): unknown;
};
type Chromium = { launch(opts: Record<string, unknown>): Promise<PlaywrightBrowser> };

/** Try each launch strategy in order; first success wins. */
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

/** Try/catch probe: can this environment launch some flavor of Chromium right now? */
export async function canLaunchChromium(): Promise<boolean> {
  try {
    const browser = await launchChromium();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

function randomSuffix(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Wait for the manual-mode player to report ready (`window.__hearth.ready`),
 * but fail fast — with the real in-page error — the moment the page throws
 * or logs a console error, instead of silently waiting out
 * `waitForFunction`'s own ~30s default timeout. Without this, a boot-time
 * crash (bad script, bad asset, a bug in the player bundle itself) used to
 * surface only as a generic timeout, with no hint of what actually broke.
 *
 * `navigate` is passed in (rather than this function calling page.goto
 * itself) so the pageerror/console listeners are always registered strictly
 * before navigation starts — nothing the page does on load can fire before
 * we're listening.
 */
export async function waitForBootReady(page: PlaywrightPage, navigate: () => Promise<unknown>): Promise<void> {
  let failBoot!: (err: Error) => void;
  const bootFailure = new Promise<never>((_, reject) => {
    failBoot = reject;
  });
  // If waitForFunction wins the race below, nothing ever awaits `bootFailure`
  // again — without this no-op handler, a later pageerror/console-error
  // would surface as an unhandled promise rejection.
  bootFailure.catch(() => {});
  page.on('pageerror', (err) => {
    failBoot(new Error(`hearth screenshot: page threw during boot: ${err.message || String(err)}`));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      failBoot(new Error(`hearth screenshot: console error during boot: ${msg.text()}`));
    }
  });

  await navigate();
  // These functions are serialized by Playwright and run inside the page's
  // browser context, not here in Node — `globalThis` (rather than `window`)
  // keeps this file typecheckable under a Node-only (no-DOM-lib) tsconfig
  // while still meaning "the page's window" once it actually runs in
  // Chromium.
  await Promise.race([
    page.waitForFunction(
      () => Boolean((globalThis as unknown as { __hearth?: { ready?: boolean } }).__hearth?.ready),
    ),
    bootFailure,
  ]);
}

/**
 * Capture a deterministic PNG screenshot of a scene: exports a single-file
 * build to a scratch directory, injects a manual-stepping boot override,
 * loads it in headless Chromium, steps `opts.frame` fixed frames, and
 * screenshots the canvas.
 */
export async function captureScreenshot(
  store: ProjectStore,
  opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const out = opts.out ?? 'screenshot.png';
  // Same sandbox rule as buildProject/exportWeb's outDir: the CLI and the
  // MCP tool are agent-facing surfaces, so an unchecked absolute or
  // traversing --out would let a caller overwrite arbitrary writable files.
  if (!isSafeOut(out)) {
    throw new Error(
      `hearth screenshot: out must be a project-relative path (no absolute paths or "..") (got: ${out})`,
    );
  }

  const resolvedScene = opts.scene
    ? store.getScene(opts.scene)
    : store.getScene(store.project.initialScene ?? store.project.scenes[0]?.id ?? '');
  if (!resolvedScene) {
    throw new Error(`hearth screenshot: scene not found: ${opts.scene ?? '(initial scene)'}`);
  }

  const buildSettings = store.project.buildSettings as { width?: number; height?: number };
  const width = opts.width ?? buildSettings.width ?? 960;
  const height = opts.height ?? buildSettings.height ?? 540;
  const frame = opts.frame ?? 0;

  // Ephemeral session, scoped to this call: only used to run exportWeb into
  // a scratch dir. Its "build" grant is not a policy decision — see the
  // module doc comment; the caller must have already checked permission.
  const session = HearthSession.fromStore(store, {
    granted: ['build'],
    source: 'export',
    resources: { getPlayerBundle: () => loadPlayerBundle() },
  });

  const outDir = `.hearth-tmp/screenshot-${randomSuffix()}`;
  let osTmpDir: string | undefined;
  // The scratch dir cleanup in the finally below must cover EVERY failure
  // path that could leave export output behind — including exportWeb itself
  // failing partway — so the export runs inside this try, not before it.
  try {
    const exportResult = await session.execute<{ outDir: string }>('exportWeb', {
      outDir,
      singleFile: true,
    });
    if (!exportResult.success) {
      const message = exportResult.errors.map((e) => e.message).join('; ') || 'export failed';
      throw new Error(`hearth screenshot: could not export a build to capture: ${message}`);
    }

    const htmlPath = joinPath(store.root, outDir, 'index.html');
    const html = await store.fs.readFile(htmlPath);
    const injected = injectBootScript(html, {
      manual: true,
      seed: opts.seed ?? 0,
      debug: !!opts.debug,
      width: opts.width,
      height: opts.height,
      scene: resolvedScene.id,
    });

    // Chromium needs a real filesystem path (file://) to navigate to; the
    // store's fs may be in-memory, so materialize the injected HTML on the
    // real OS filesystem regardless of what backs `store`.
    osTmpDir = await mkdtemp(path.join(tmpdir(), 'hearth-screenshot-'));
    const htmlFile = path.join(osTmpDir, 'index.html');
    await writeFile(htmlFile, injected, 'utf8');

    const browser = await launchChromium();
    try {
      const page = await browser.newPage({ viewport: { width, height } });

      // Listeners must be wired up before goto() so a boot-time crash can't
      // fire before we're listening for it.
      await waitForBootReady(page, () => page.goto(pathToFileURL(htmlFile).href));
      await page.evaluate(
        (n: number) =>
          (globalThis as unknown as { __hearth: { step(n: number): Promise<void> } }).__hearth.step(n),
        frame,
      );
      await page.evaluate(
        () => (globalThis as unknown as { __hearth: { render(): void } }).__hearth.render(),
      );

      const outPath = path.resolve(store.root, out);
      await mkdir(path.dirname(outPath), { recursive: true });
      await page.locator('canvas').screenshot({ path: outPath });

      return { path: outPath, width, height, frame, scene: resolvedScene.id };
    } finally {
      await browser.close();
    }
  } finally {
    if (osTmpDir) await rm(osTmpDir, { recursive: true, force: true });
    // Best-effort scratch cleanup: remove this call's export dir, then the
    // shared .hearth-tmp/ parent if (and only if) it's now empty — a
    // concurrent capture's dir must survive. Both steps tolerate the dirs
    // never having been created (e.g. exportWeb failed validation).
    await store.fs.remove(joinPath(store.root, outDir)).catch(() => {});
    const tmpParent = joinPath(store.root, '.hearth-tmp');
    try {
      if ((await store.fs.readdir(tmpParent)).length === 0) await store.fs.remove(tmpParent);
    } catch {
      // parent absent or non-empty-race — fine either way
    }
  }
}
