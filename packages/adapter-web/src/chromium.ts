/**
 * Chromium launch, isolated from the adapter so `playwright-core` stays a
 * lazy, optional dependency.
 *
 * `playwright-core` is imported dynamically *inside* `launchChromium()` — the
 * exact pattern `@hearth/playtest`'s `screenshot.ts` uses — so importing this
 * package (or anything that re-exports it) works fine on a machine with no
 * browser automation installed. The launch strategy list is copied from
 * playtest verbatim: installed Chrome, then Edge, then `CHROMIUM_PATH`, then
 * whatever playwright's own download provides.
 *
 * The Playwright surface is described by hand-rolled structural types rather
 * than imported from `playwright-core`, again mirroring playtest: the
 * optional dependency must not be needed to *typecheck* this package either.
 * The types cover only the slice the adapter drives.
 */

export interface PwConsoleMessage {
  type(): string;
  text(): string;
  location(): { url?: string; lineNumber?: number; columnNumber?: number };
}

export interface PwKeyboard {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
}

export interface PwMouse {
  move(x: number, y: number): Promise<void>;
  down(): Promise<void>;
  up(): Promise<void>;
  click(x: number, y: number): Promise<void>;
}

export interface PwPage {
  readonly keyboard: PwKeyboard;
  readonly mouse: PwMouse;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload(opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  waitForFunction(fn: () => unknown, arg?: unknown, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: { type?: 'png' | 'jpeg' }): Promise<Buffer>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  close(): Promise<void>;
  on(event: 'pageerror', handler: (error: Error) => void): unknown;
  on(event: 'console', handler: (message: PwConsoleMessage) => void): unknown;
}

export interface PwBrowser {
  newPage(opts?: Record<string, unknown>): Promise<PwPage>;
  close(): Promise<void>;
}

interface PwChromium {
  launch(opts: Record<string, unknown>): Promise<PwBrowser>;
}

export const CHROMIUM_MISSING_ERROR =
  'The Hearth web probe needs Chrome or Chromium installed (or CHROMIUM_PATH set). ' +
  'Install Google Chrome, or: npx playwright install chromium';

/** Try each launch strategy in order; first success wins. */
export async function launchChromium(opts: { headless?: boolean } = {}): Promise<PwBrowser> {
  const headless = opts.headless ?? true;
  let chromium: PwChromium;
  try {
    ({ chromium } = (await import('playwright-core')) as unknown as { chromium: PwChromium });
  } catch {
    throw new Error(CHROMIUM_MISSING_ERROR);
  }

  const attempts: Array<() => Promise<PwBrowser>> = [
    () => chromium.launch({ channel: 'chrome', headless }),
    () => chromium.launch({ channel: 'msedge', headless }),
  ];
  if (process.env.CHROMIUM_PATH) {
    attempts.push(() => chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless }));
  }
  attempts.push(() => chromium.launch({ headless }));

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
