/**
 * `openWebGame()` — a `GameUnderTest` implementation over any local web game,
 * driven through headless Chromium (CDP via playwright-core).
 *
 * Two tiers, and the whole point of the design is that the first one needs
 * *nothing* from the game:
 *
 * - **Zero cooperation.** Point it at a directory or a URL. It opens the page,
 *   injects real keyboard/pointer input, captures PNGs, and collects console
 *   errors and uncaught exceptions. Senses it can honestly claim: `errors`,
 *   `screenshot`, `reset` (a full page reload — slow, but a genuine return to
 *   the initial state). Everything else is declared `false`, so detectors that
 *   need those senses get skipped rather than silently passed.
 *
 * - **Shim.** If the page exposes `window.__hearthProbe` (see
 *   `docs/probe-shim.md` and the reference `shim/probe-shim.js`), the adapter
 *   detects it after load and upgrades the declared capabilities to match what
 *   the shim actually provides: entities, scene ids, a game-event stream, a
 *   nav grid, and a cheap in-page reset.
 *
 * Capability honesty is enforced structurally: the optional `GameUnderTest`
 * methods are *absent* from the returned object unless the matching
 * capability is true, so a consumer can feature-detect either way.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GameUnderTest,
  NavGrid,
  PointerKind,
  ProbeCapabilities,
  ProbeEntity,
  ProbeError,
  StepObservation,
} from '@hearth/probe-core';
import { launchChromium, type PwBrowser, type PwPage } from './chromium.js';
import { openStatic, type StaticServer } from './server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the reference shim. It ships as a file for agents to copy
 * into their own game (owned code, not a dependency) — nothing imports it.
 * Resolves the same from `src/` and from the built `dist/`.
 */
export const PROBE_SHIM_PATH = path.resolve(HERE, '../shim/probe-shim.js');

/** action name → `KeyboardEvent.code`. */
export const DEFAULT_ACTION_KEYS: Readonly<Record<string, string>> = Object.freeze({
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  jump: 'Space',
  action: 'KeyZ',
});

export const DEFAULT_VIEWPORT = Object.freeze({ width: 960, height: 540 });
export const DEFAULT_STEP_MS = 100;

/** How long shim detection waits for `window.__hearthProbe` to appear. */
const SHIM_DETECT_TIMEOUT_MS = 1000;
/** Cap on how long a settle() waits for a frame, in case rAF never fires. */
const SETTLE_TIMEOUT_MS = 500;

export interface OpenWebGameOptions {
  /** Directory to serve on an ephemeral loopback port. */
  dir?: string;
  /** A URL that is already being served (wins over `dir`). */
  url?: string;
  /** Default true. */
  headless?: boolean;
  /** Browser viewport, also reported as the logical viewport. Default 960x540. */
  viewport?: { width: number; height: number };
  /**
   * action name → `KeyboardEvent.code`. Replaces the defaults wholesale when
   * given. Entries named `<axis>+` / `<axis>-` additionally define an axis
   * that `setAxis` can drive (e.g. `{ 'moveX+': 'KeyD', 'moveX-': 'KeyA' }`
   * makes `setAxis('moveX', 1)` hold `KeyD`).
   */
  actionKeys?: Record<string, string>;
  /** Wall-clock length of one `step()` sample window. Default 100ms. */
  stepMs?: number;
}

export interface WebGameUnderTest extends GameUnderTest {
  /** The URL actually opened. */
  readonly url: string;
  /** True once the page was found to expose a compatible `window.__hearthProbe`. */
  readonly shimDetected: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a browser).
// ---------------------------------------------------------------------------

/** Axis names with a complete `<name>+` / `<name>-` key pair. */
export function axisNamesFrom(actionKeys: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(actionKeys)) {
    if (!key.endsWith('+')) continue;
    const name = key.slice(0, -1);
    if (name && actionKeys[`${name}-`]) names.add(name);
  }
  return [...names].sort();
}

/** Action names: every mapped key that isn't one half of an axis pair. */
export function actionNamesFrom(actionKeys: Record<string, string>): string[] {
  return Object.keys(actionKeys)
    .filter((key) => !key.endsWith('+') && !key.endsWith('-'))
    .sort();
}

/** "http://x/y/player.js:31:9" (or a bare stack frame) → "player.js:31". */
export function formatLocation(url?: string, line?: number): string | undefined {
  if (!url) return undefined;
  let file = url;
  const q = file.indexOf('?');
  if (q >= 0) file = file.slice(0, q);
  const slash = file.lastIndexOf('/');
  if (slash >= 0) file = file.slice(slash + 1);
  if (!file) file = url;
  return typeof line === 'number' && line > 0 ? `${file}:${line}` : file;
}

/** Best-effort "file.js:31" from the first useful frame of a stack trace. */
export function whereFromStack(stack?: string): string | undefined {
  if (!stack) return undefined;
  for (const raw of stack.split('\n')) {
    const match = /((?:https?|file|blob):\/\/[^\s()]+?|[\w./-]+\.[cm]?js):(\d+):(\d+)/.exec(raw);
    if (match) return formatLocation(match[1], Number(match[2]));
  }
  return undefined;
}

/** Strip the engine's "Uncaught " prefix so pageerror/console dupes collapse. */
export function normalizeErrorMessage(message: string): string {
  return message.replace(/^Uncaught(\s+\(in promise\))?:?\s*/i, '').trim();
}

/**
 * Chromium reports one uncaught exception twice: as a `pageerror` (message
 * only, e.g. "x is not a function") and as a console error carrying the error
 * class too ("Uncaught TypeError: x is not a function"). After stripping
 * "Uncaught ", one is a suffix of the other — that's the dedupe rule.
 */
export function isDuplicateError(existing: string, incoming: string): boolean {
  const a = normalizeErrorMessage(existing);
  const b = normalizeErrorMessage(incoming);
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/**
 * Console noise the *browser* generates on its own, which no game author can
 * fix and no detector should count as a game error. Chromium requests
 * `/favicon.ico` for every page whether or not the document asks for one, and
 * logs a console error when it 404s — every fixture and every hand-written
 * game would otherwise start its run "already broken".
 */
export function isBrowserNoise(url: string | undefined): boolean {
  return !!url && /\/favicon\.ico(\?|$)/.test(url);
}

/** Resolution order per the contract: id, then exact name, then tag. */
export function resolveEntity(entities: ProbeEntity[], ref: string): ProbeEntity | null {
  return (
    entities.find((e) => e.id === ref) ??
    entities.find((e) => e.name === ref) ??
    entities.find((e) => e.tags?.includes(ref)) ??
    null
  );
}

/** Defensive normalization of whatever the game's shim handed back. */
export function normalizeEntities(raw: unknown): ProbeEntity[] {
  if (!Array.isArray(raw)) return [];
  const out: ProbeEntity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const x = Number(rec.x);
    const y = Number(rec.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const entity: ProbeEntity = {
      id: String(rec.id ?? rec.name ?? `entity${out.length}`),
      x,
      y,
      alive: rec.alive === undefined ? true : Boolean(rec.alive),
    };
    if (typeof rec.name === 'string') entity.name = rec.name;
    if (Array.isArray(rec.tags)) entity.tags = rec.tags.filter((t): t is string => typeof t === 'string');
    out.push(entity);
  }
  return out;
}

export function normalizeNavGrid(raw: unknown): NavGrid | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const cols = Number(rec.cols);
  const rows = Number(rec.rows);
  const cellSize = Number(rec.cellSize);
  const solid = rec.solid;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || !Number.isFinite(cellSize)) return null;
  if (cols <= 0 || rows <= 0 || cellSize <= 0 || !Array.isArray(solid)) return null;
  if (solid.length !== cols * rows) return null;
  return {
    originX: Number(rec.originX) || 0,
    originY: Number(rec.originY) || 0,
    cellSize,
    cols,
    rows,
    solid: solid.map(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Page-side shapes. These mirror docs/probe-shim.md; nothing here is imported
// into the page — they only type the `evaluate` boundary.
// ---------------------------------------------------------------------------

interface PageShim {
  version?: number;
  actions?: unknown;
  axes?: unknown;
  scene?: () => unknown;
  entities?: () => unknown;
  drainEvents?: () => unknown;
  navGrid?: () => unknown;
  reset?: () => unknown;
}

interface PageGlobal {
  __hearthProbe?: PageShim;
  requestAnimationFrame?: (cb: () => void) => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
}

interface ShimDescriptor {
  version: number;
  actions: string[] | null;
  axes: string[] | null;
  hasScene: boolean;
  hasEntities: boolean;
  hasEvents: boolean;
  hasNav: boolean;
  hasReset: boolean;
}

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

export async function openWebGame(opts: OpenWebGameOptions = {}): Promise<WebGameUnderTest> {
  const actionKeys = { ...(opts.actionKeys ?? DEFAULT_ACTION_KEYS) };
  const viewport = { ...(opts.viewport ?? DEFAULT_VIEWPORT) };
  const stepMs = opts.stepMs ?? DEFAULT_STEP_MS;
  const headless = opts.headless ?? true;

  const server: StaticServer = await openStatic(opts);

  const capabilities: ProbeCapabilities = {
    input: {
      actions: actionNamesFrom(actionKeys),
      axes: axisNamesFrom(actionKeys),
      pointer: true,
    },
    senses: {
      errors: true,
      scenes: false,
      events: false,
      entities: false,
      screenshot: true,
      nav: false,
      // Always available: worst case it's a full page reload — slow, but a
      // real return to the initial state. The shim can make it cheap.
      reset: true,
    },
    viewport,
  };

  let browser: PwBrowser | null = null;
  let page: PwPage | null = null;
  let stopped = false;
  let frame = 0;
  let startedAt = 0;
  let pending: ProbeError[] = [];
  let shim: ShimDescriptor | null = null;
  let shimReset = false;
  const held = new Set<string>();

  const requirePage = (): PwPage => {
    if (!page) throw new Error('openWebGame: call start() before driving the game');
    return page;
  };

  const recordError = (message: string, where: string | undefined) => {
    const text = normalizeErrorMessage(message);
    if (!text) return;
    // Chromium reports an uncaught exception twice (pageerror + a console
    // "Uncaught ..." message). Collapse duplicates within the open window.
    if (pending.some((e) => isDuplicateError(e.message, text))) return;
    const err: ProbeError = { message: text, at: { frame, ms: Date.now() - startedAt } };
    if (where) err.where = where;
    pending.push(err);
  };

  const settle = async (): Promise<void> => {
    await requirePage().evaluate<void, number>(
      (timeout: number) =>
        new Promise<void>((resolve) => {
          const g = globalThis as PageGlobal;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          if (g.requestAnimationFrame) g.requestAnimationFrame(finish);
          else finish();
          g.setTimeout?.(finish, timeout);
        }),
      SETTLE_TIMEOUT_MS,
    );
  };

  const detectShim = async (): Promise<void> => {
    const target = requirePage();
    try {
      await target.waitForFunction(
        () => Boolean((globalThis as PageGlobal).__hearthProbe),
        undefined,
        { timeout: SHIM_DETECT_TIMEOUT_MS },
      );
    } catch {
      shim = null;
      return;
    }
    const found = await target.evaluate<ShimDescriptor | null>(() => {
      const probe = (globalThis as PageGlobal).__hearthProbe;
      if (!probe || probe.version !== 1) return null;
      const strings = (value: unknown): string[] | null =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
      return {
        version: 1,
        actions: strings(probe.actions),
        axes: strings(probe.axes),
        hasScene: typeof probe.scene === 'function',
        hasEntities: typeof probe.entities === 'function',
        hasEvents: typeof probe.drainEvents === 'function',
        hasNav: typeof probe.navGrid === 'function',
        hasReset: typeof probe.reset === 'function',
      };
    });
    shim = found;
  };

  /**
   * Fold a detected shim into the declared capabilities. Only senses the
   * adapter can actually deliver get turned on: `nav` additionally requires
   * `navGrid()` to return a usable grid right now, and shim-declared actions
   * narrow the input vocabulary to those the adapter also has a key for
   * (an action nobody can press must not be advertised).
   */
  const applyShim = async (): Promise<void> => {
    if (!shim) {
      shimReset = false;
      return;
    }
    capabilities.senses.scenes = shim.hasScene;
    capabilities.senses.events = shim.hasEvents;
    capabilities.senses.entities = shim.hasEntities;
    shimReset = shim.hasReset;
    if (shim.actions) {
      const declared = new Set(shim.actions);
      capabilities.input.actions = actionNamesFrom(actionKeys).filter((a) => declared.has(a));
    }
    if (shim.axes) {
      const declared = new Set(shim.axes);
      capabilities.input.axes = axisNamesFrom(actionKeys).filter((a) => declared.has(a));
    }
    capabilities.senses.nav = shim.hasNav ? (await readNavGrid()) !== null : false;
  };

  const readNavGrid = async (): Promise<NavGrid | null> => {
    const raw = await requirePage().evaluate<unknown>(() => {
      const probe = (globalThis as PageGlobal).__hearthProbe;
      if (!probe || typeof probe.navGrid !== 'function') return null;
      try {
        return probe.navGrid() ?? null;
      } catch {
        return null;
      }
    });
    return normalizeNavGrid(raw);
  };

  const readEntities = async (): Promise<ProbeEntity[]> => {
    const raw = await requirePage().evaluate<unknown>(() => {
      const probe = (globalThis as PageGlobal).__hearthProbe;
      if (!probe || typeof probe.entities !== 'function') return [];
      try {
        return probe.entities() ?? [];
      } catch {
        return [];
      }
    });
    return normalizeEntities(raw);
  };

  const releaseAll = async (): Promise<void> => {
    if (!page) {
      held.clear();
      return;
    }
    for (const key of [...held]) {
      try {
        await page.keyboard.up(key);
      } catch {
        // page may be gone; nothing to release
      }
      held.delete(key);
    }
  };

  const holdKey = async (key: string): Promise<void> => {
    if (held.has(key)) return;
    await requirePage().keyboard.down(key);
    held.add(key);
  };

  const releaseKey = async (key: string): Promise<void> => {
    if (!held.has(key)) return;
    await requirePage().keyboard.up(key);
    held.delete(key);
  };

  const game: WebGameUnderTest = {
    get url() {
      return server.url;
    },
    get shimDetected() {
      return shim !== null;
    },
    get capabilities() {
      return capabilities;
    },

    async start(): Promise<void> {
      if (page) return;
      browser = await launchChromium({ headless });
      page = await browser.newPage({ viewport });
      startedAt = Date.now();
      // Listeners are wired before the first navigation so nothing the page
      // does on load can fire before we're listening.
      page.on('pageerror', (error: Error) => {
        recordError(error.message || String(error), whereFromStack(error.stack));
      });
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const loc = message.location();
        if (isBrowserNoise(loc?.url)) return;
        recordError(message.text(), formatLocation(loc?.url, loc?.lineNumber));
      });
      await page.goto(server.url, { waitUntil: 'load' });
      await settle();
      await detectShim();
      await applyShim();
      attachOptionalMethods();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await releaseAll();
      try {
        await page?.close();
      } catch {
        // already gone
      }
      page = null;
      try {
        await browser?.close();
      } catch {
        // already gone
      }
      browser = null;
      await server.close();
    },

    async step(): Promise<StepObservation> {
      const target = requirePage();
      frame += 1;
      await target.waitForTimeout(stepMs);

      let sceneId: string | null = null;
      let newEvents: string[] = [];
      if (capabilities.senses.scenes || capabilities.senses.events) {
        const sample = await target.evaluate<{ scene: string | null; events: string[] }>(() => {
          const probe = (globalThis as PageGlobal).__hearthProbe;
          const out: { scene: string | null; events: string[] } = { scene: null, events: [] };
          if (!probe) return out;
          try {
            if (typeof probe.scene === 'function') {
              const value = probe.scene();
              out.scene = value == null ? null : String(value);
            }
          } catch {
            /* a throwing hook must not break sampling */
          }
          try {
            if (typeof probe.drainEvents === 'function') {
              const value = probe.drainEvents();
              if (Array.isArray(value)) out.events = value.map((e) => String(e));
            }
          } catch {
            /* same */
          }
          return out;
        });
        sceneId = sample.scene;
        newEvents = sample.events;
      }

      const newErrors = pending;
      pending = [];
      return { frame, ms: Date.now() - startedAt, newErrors, sceneId, newEvents };
    },

    async setActionDown(name: string): Promise<void> {
      const key = actionKeys[name];
      if (key) await holdKey(key);
    },

    async setActionUp(name: string): Promise<void> {
      const key = actionKeys[name];
      if (key) await releaseKey(key);
    },

    async setAxis(name: string, value: number): Promise<void> {
      const positive = actionKeys[`${name}+`];
      const negative = actionKeys[`${name}-`];
      if (!positive || !negative) return; // undrivable axis: honest no-op
      if (value > 0.5) {
        await releaseKey(negative);
        await holdKey(positive);
      } else if (value < -0.5) {
        await releaseKey(positive);
        await holdKey(negative);
      } else {
        await releaseKey(positive);
        await releaseKey(negative);
      }
    },

    async sendPointer(x: number, y: number, kind: PointerKind): Promise<void> {
      const mouse = requirePage().mouse;
      if (kind === 'move') await mouse.move(x, y);
      else if (kind === 'click') await mouse.click(x, y);
      else {
        await mouse.move(x, y);
        if (kind === 'down') await mouse.down();
        else await mouse.up();
      }
    },

    async screenshot(): Promise<Uint8Array> {
      const buffer = await requirePage().screenshot({ type: 'png' });
      return new Uint8Array(buffer);
    },
  };

  /**
   * The optional contract methods exist on the object exactly when the
   * matching capability is true, so consumers can feature-detect. `reset` is
   * always present (page reload is the floor); the rest arrive with the shim.
   */
  function attachOptionalMethods(): void {
    delete game.listEntities;
    delete game.findEntity;
    delete game.navGrid;

    if (capabilities.senses.entities) {
      game.listEntities = readEntities;
      game.findEntity = async (ref: string) => resolveEntity(await readEntities(), ref);
    }
    if (capabilities.senses.nav) {
      game.navGrid = readNavGrid;
    }
    game.reset = async () => {
      const target = requirePage();
      await releaseAll();
      if (shimReset) {
        await target.evaluate<void>(() => {
          const probe = (globalThis as PageGlobal).__hearthProbe;
          try {
            probe?.reset?.();
          } catch {
            /* a broken reset hook must not kill the run */
          }
        });
        await settle();
      } else {
        // Zero-cooperation floor: a full reload really does restore the
        // initial state. Slow, but valid — which is why `reset` is declared.
        await target.reload({ waitUntil: 'load' });
        await settle();
        await detectShim();
        await applyShim();
        attachOptionalMethods();
      }
      // Errors from the previous episode must not leak into the next one.
      pending = [];
    };
  }

  // `reset` is declared true from the start, so the method has to exist even
  // before start() upgrades the rest.
  attachOptionalMethods();

  return game;
}
