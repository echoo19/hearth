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

/**
 * The slice of a CDP session the screencast below drives. Chromium-only, which
 * is fine: this package launches Chromium and nothing else.
 */
export interface PwCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'Page.screencastFrame', handler: (params: CdpScreencastFrame) => void): unknown;
  detach(): Promise<void>;
}

export interface PwBrowserContext {
  newCDPSession(page: PwPage): Promise<PwCdpSession>;
}

/** The `Page.screencastFrame` payload, as much of it as we read. */
export interface CdpScreencastFrame {
  /** base64 JPEG. */
  data: string;
  /** Echoed back in the ack; without it Chromium stops sending. */
  sessionId: number;
}

export interface PwPage {
  readonly keyboard: PwKeyboard;
  readonly mouse: PwMouse;
  context(): PwBrowserContext;
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

// ---------------------------------------------------------------------------
// Screencast: a live look at the page the probe is driving.
// ---------------------------------------------------------------------------

/**
 * Small enough to be a background picture, not a video player. 640 on the long
 * edge of a 960x540 viewport is 640x360, which lands around 3 KB a frame at
 * this quality: a whole sweep costs less than one of the PNGs it saves.
 */
export const SCREENCAST_MAX_EDGE = 640;
export const SCREENCAST_QUALITY = 50;
/**
 * Roughly 10 frames a second. Enough to read a game as moving, and the rate
 * this is throttled to in two places for two different reasons: the ack is
 * delayed so Chromium encodes fewer frames (uncapped it offers ~100/s, since
 * a headless compositor has no vsync to pace it), and delivery is dropped to
 * the same interval because the ack is only advisory (Chromium keeps several
 * frames in flight regardless).
 */
export const SCREENCAST_INTERVAL_MS = 100;

/**
 * Start streaming what a page is showing.
 *
 * `Page.screencastFrame` rather than `page.screenshot()` in a loop: a
 * screenshot is a round trip that stalls the page for tens of milliseconds,
 * and the probe is trying to play a game while this runs. The screencast is
 * pushed by the compositor and costs it almost nothing.
 *
 * Returns a stop function. Every failure is the caller's to ignore: a picture
 * of the run is a nicety, and nothing here is allowed to take a sweep down.
 */
export async function startScreencast(
  page: PwPage,
  onFrame: (data: string) => void,
  opts: { intervalMs?: number; maxEdge?: number; quality?: number } = {},
): Promise<() => Promise<void>> {
  const intervalMs = opts.intervalMs ?? SCREENCAST_INTERVAL_MS;
  const session = await page.context().newCDPSession(page);
  let stopped = false;
  let lastDelivered = 0;
  let lastAck = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  session.on('Page.screencastFrame', (frame) => {
    if (stopped) return;
    const now = Date.now();
    // A little slack under the interval: pacing jitter would otherwise push
    // every other frame just past the line and halve the rate that gets out.
    if (now - lastDelivered >= intervalMs - 10) {
      lastDelivered = now;
      try {
        onFrame(frame.data);
      } catch {
        // a consumer that throws must not stall the ack below
      }
    }
    const ack = (): void => {
      lastAck = Date.now();
      void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    };
    const wait = intervalMs - (now - lastAck);
    if (wait <= 0) ack();
    else {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!stopped) ack();
      }, wait);
      timers.add(timer);
    }
  });

  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: opts.quality ?? SCREENCAST_QUALITY,
    maxWidth: opts.maxEdge ?? SCREENCAST_MAX_EDGE,
    maxHeight: opts.maxEdge ?? SCREENCAST_MAX_EDGE,
    everyNthFrame: 1,
  });

  return async () => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    try {
      await session.send('Page.stopScreencast');
    } catch {
      // the page is already gone, which is the same outcome
    }
    try {
      await session.detach();
    } catch {
      // likewise
    }
  };
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
