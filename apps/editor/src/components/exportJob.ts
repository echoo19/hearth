/**
 * Export dialog logic + the live desktop-export job store, kept out of the
 * component so it's unit-testable under the repo's `node` test environment
 * (no jsdom/RTL) — same split as GameSettings' edit-shaping helpers.
 *
 * Two halves:
 *  - Pure helpers (labels, the platform selection model, arg shaping) plus a
 *    pure reducer that folds the ws export-* frame stream into per-platform
 *    rows. All directly testable.
 *  - A tiny module-level external store wrapping that reducer, fed by the
 *    store's shared WS message handler (ingestExportFrame) — mirroring
 *    useAgentSocket.ts, so a running job survives the dialog being closed and
 *    reopened. The dialog subscribes via useExportJob().
 */
import { useSyncExternalStore } from 'react';
import type {
  DesktopExportResult,
  DesktopPlatform,
  ExportCapability,
  ExportFrame,
  ExportStage,
  SigningMode,
  StartDesktopExportResult,
} from '../types';

// ---------------------------------------------------------------------------
// Platform model
// ---------------------------------------------------------------------------

/** The desktop targets the dialog offers, in display order. Mirrors core's
 * DesktopPlatform union; used as the fallback when /api/export/capability
 * can't be reached so the pane still renders its checkboxes. */
export const ALL_DESKTOP_PLATFORMS: DesktopPlatform[] = [
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'linux-x64',
];

export const PLATFORM_LABELS: Record<DesktopPlatform, string> = {
  'darwin-arm64': 'macOS (Apple Silicon)',
  'darwin-x64': 'macOS (Intel)',
  'win32-x64': 'Windows',
  'linux-x64': 'Linux',
};

export function platformLabel(platform: DesktopPlatform): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export type PlatformSelection = Record<string, boolean>;

/** Everything preselected — the common case is "ship all four". */
export function defaultPlatformSelection(platforms: DesktopPlatform[]): PlatformSelection {
  const selection: PlatformSelection = {};
  for (const platform of platforms) selection[platform] = true;
  return selection;
}

/** The checked platforms, in the offered order (never the map's order). */
export function desktopExportPlatforms(
  selection: PlatformSelection,
  offered: DesktopPlatform[],
): DesktopPlatform[] {
  return offered.filter((platform) => selection[platform]);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<ExportStage, string> = {
  stage: 'Staging',
  // Spelled out on purpose: the first desktop export downloads Electron
  // (~100MB+) and can sit here for a while — the row must say why.
  download: 'Downloading Electron',
  package: 'Packaging',
  sign: 'Signing',
  notarize: 'Notarizing',
  zip: 'Zipping',
};

export function stageLabel(stage: ExportStage): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function signingStatusLabel(capability: { mode: SigningMode; identity?: string }): string {
  const who = capability.identity ?? 'your Developer ID';
  switch (capability.mode) {
    case 'adhoc':
      return 'Ad-hoc signing';
    case 'identity':
      return `Signing as ${who}`;
    case 'identity+notarize':
      return `Signing + notarizing as ${who}`;
  }
}

// ---------------------------------------------------------------------------
// Next-step hints (L-118 export-friction reaudit, F-1 / F-3) — the finished
// result panel used to show only a raw path with a copy button and nothing
// telling the user what to actually do with it (upload it? double-click it?
// does it need a server?), despite docs/shipping-to-itch.md covering exactly
// that. Pure so the copy is unit-tested without a DOM.
// ---------------------------------------------------------------------------

export const SHIPPING_GUIDE_URL = 'https://hearth-engine.vercel.app/docs/shipping-to-itch';

/** F-1: one-line next-step hint under a finished web export, minus the
 * "see the shipping guide" link (the dialog renders that part as an actual
 * `<a>` to SHIPPING_GUIDE_URL). Same line regardless of folder/single-file/
 * zip — the destination is the same either way (get it in front of a
 * player); the guide covers the per-format detail. */
export function webNextStepHint(): string {
  return 'Upload the zip to itch.io or any static host';
}

/** F-1: one-line next-step hint under a finished desktop export. */
export function desktopNextStepHint(): string {
  return 'Unzip and share — players double-click the app.';
}

/** F-3: a short Gatekeeper note, shown only when at least one *finished*
 * build in this job targets macOS (ad-hoc-signed exports are unsigned as far
 * as Gatekeeper is concerned, so a downloaded build needs this on first
 * launch — see docs/shipping-to-itch.md's signing table). */
export function desktopMacGatekeeperNote(finishedPlatforms: DesktopPlatform[]): string | null {
  return finishedPlatforms.some((p) => p.startsWith('darwin'))
    ? 'First launch on macOS: right-click the app and choose Open (Gatekeeper).'
    : null;
}

// ---------------------------------------------------------------------------
// Zip size (L-118 export-friction reaudit, F-5) — a near-empty example
// project's darwin-arm64 zip is 254MB (almost entirely the bundled Electron
// runtime), and the row showed only the path with no context for that
// number. The server stats the produced zip (see projectServer.ts's
// attachZipSizes) and this formats it for display.
// ---------------------------------------------------------------------------

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** Human-readable byte size, or null when unknown (server couldn't stat it). */
export function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

// ---------------------------------------------------------------------------
// Arg shaping
// ---------------------------------------------------------------------------

export function resolveOutDir(raw: string, fallback: string): string {
  return raw.trim() || fallback;
}

export interface WebExportArgs {
  outDir: string;
  singleFile: boolean;
  zip: boolean;
}

/** Shape the exportWeb call from the web pane's controls (the testable seam
 * for "the zip checkbox passes zip:true"). */
export function webExportArgs(
  target: 'folder' | 'single',
  outDir: string,
  zip: boolean,
): WebExportArgs {
  return { outDir: resolveOutDir(outDir, 'export/web'), singleFile: target === 'single', zip };
}

/** null when the desktop job actually started; otherwise the message to show
 * (only one export runs at a time server-side, so a refused start means one is
 * already running). */
export function startResultMessage(result: StartDesktopExportResult): string | null {
  if (result.ok) return null;
  return result.error ?? 'An export is already running. Wait for it to finish, then try again.';
}

// ---------------------------------------------------------------------------
// Job reducer — folds the export-* frame stream into per-platform rows
// ---------------------------------------------------------------------------

export type PlatformRowStatus = 'pending' | 'running' | 'success' | 'error';

export interface PlatformRow {
  platform: DesktopPlatform;
  stage: ExportStage | null;
  message: string;
  status: PlatformRowStatus;
  /** Set on success (from the export-done build result). */
  zip?: string;
  /** Byte size of `zip`, when the server managed to stat it (F-5). */
  zipBytes?: number;
  appDir?: string;
  signed?: 'adhoc' | 'identity' | 'none';
  notarized?: boolean;
  /** Set when this platform failed (per-platform export-error). */
  error?: string;
}

export interface ExportJobState {
  jobId: string | null;
  running: boolean;
  finished: boolean;
  /** Platforms in display order (seeded at start, extended if a frame names
   * one we didn't seed). */
  order: DesktopPlatform[];
  rows: Record<string, PlatformRow>;
  /** The platform whose row is currently working — the one that gets the ember
   * accent. Null between/around builds and once the job ends. */
  activePlatform: DesktopPlatform | null;
  /** A platform-less progress message (e.g. the shared web-build staging step). */
  globalMessage: string | null;
  /** A whole-job failure with no platform attached. */
  bannerError: string | null;
  result: DesktopExportResult | null;
}

export type ExportJobAction =
  | { type: 'start'; jobId: string; platforms: DesktopPlatform[] }
  | { type: 'reset' }
  | { type: 'frame'; frame: ExportFrame };

export function initialExportJob(): ExportJobState {
  return {
    jobId: null,
    running: false,
    finished: false,
    order: [],
    rows: {},
    activePlatform: null,
    globalMessage: null,
    bannerError: null,
    result: null,
  };
}

function pendingRow(platform: DesktopPlatform): PlatformRow {
  return { platform, stage: null, message: '', status: 'pending' };
}

function ensureOrder(order: DesktopPlatform[], platform: DesktopPlatform): DesktopPlatform[] {
  return order.includes(platform) ? order : [...order, platform];
}

export function reduceExportJob(state: ExportJobState, action: ExportJobAction): ExportJobState {
  switch (action.type) {
    case 'reset':
      return initialExportJob();
    case 'start': {
      const rows: Record<string, PlatformRow> = {};
      for (const platform of action.platforms) rows[platform] = pendingRow(platform);
      return {
        ...initialExportJob(),
        jobId: action.jobId,
        running: true,
        order: [...action.platforms],
        rows,
      };
    }
    case 'frame': {
      const { frame } = action;
      // Once a job is tracked, ignore frames from any other one (a stale job,
      // or another client's export echoed onto the shared socket).
      if (state.jobId && frame.jobId !== state.jobId) return state;

      if (frame.type === 'export-progress') {
        if (frame.platform === null) return { ...state, globalMessage: frame.message };
        const platform = frame.platform;
        const prev = state.rows[platform] ?? pendingRow(platform);
        // A finished row (already succeeded or errored) isn't dragged back to
        // running by a late progress frame.
        const nextRow: PlatformRow =
          prev.status === 'success' || prev.status === 'error'
            ? prev
            : { ...prev, stage: frame.stage, message: frame.message, status: 'running' };
        return {
          ...state,
          rows: { ...state.rows, [platform]: nextRow },
          order: ensureOrder(state.order, platform),
          activePlatform: platform,
        };
      }

      if (frame.type === 'export-done') {
        const rows = { ...state.rows };
        let order = state.order;
        for (const build of frame.result.builds) {
          const prev = rows[build.platform] ?? pendingRow(build.platform);
          rows[build.platform] = {
            ...prev,
            status: 'success',
            zip: build.zip,
            zipBytes: build.zipBytes,
            appDir: build.appDir,
            signed: build.signed,
            notarized: build.notarized,
            error: undefined,
          };
          order = ensureOrder(order, build.platform);
        }
        return {
          ...state,
          running: false,
          finished: true,
          activePlatform: null,
          result: frame.result,
          rows,
          order,
        };
      }

      // export-error: a per-platform failure lands on its row; a platform-less
      // one is a whole-job banner. Either way the job is over.
      if (frame.platform) {
        const prev = state.rows[frame.platform] ?? pendingRow(frame.platform);
        return {
          ...state,
          running: false,
          finished: true,
          activePlatform: null,
          order: ensureOrder(state.order, frame.platform),
          rows: { ...state.rows, [frame.platform]: { ...prev, status: 'error', error: frame.message } },
        };
      }
      return { ...state, running: false, finished: true, activePlatform: null, bannerError: frame.message };
    }
    default:
      return state;
  }
}

/**
 * Which pane a (re)opened dialog should land on. Desktop whenever a job is
 * live OR finished-but-not-yet-cleared — a build that completed while the
 * dialog was closed must resurface its results (zip paths, errors), not hide
 * them behind the default Web tab. Finished rows persist until the user
 * starts a new export (the 'start' action reseeds the rows); routing never
 * resets anything.
 */
export function reopenMode(state: ExportJobState): 'web' | 'desktop' {
  return state.running || state.finished ? 'desktop' : 'web';
}

// ---------------------------------------------------------------------------
// External store — module-level, outside React, so a running job outlives the
// dialog's own mount/unmount. Fed by store.ts's WS message handler
// (ingestExportFrame); the dialog drives start/reset and subscribes via
// useExportJob(). No dependency on the zustand store, so no import cycle.
// ---------------------------------------------------------------------------

let jobState: ExportJobState = initialExportJob();
const listeners = new Set<() => void>();

function commit(next: ExportJobState): void {
  jobState = next;
  for (const listener of listeners) listener();
}

/** Fold one server export-* frame into the tracked job. */
export function ingestExportFrame(frame: ExportFrame): void {
  commit(reduceExportJob(jobState, { type: 'frame', frame }));
}

/** Begin tracking a freshly-started job (clears any previous job's rows). */
export function startExportJob(jobId: string, platforms: DesktopPlatform[]): void {
  commit(reduceExportJob(jobState, { type: 'start', jobId, platforms }));
}

export function resetExportJob(): void {
  commit(reduceExportJob(jobState, { type: 'reset' }));
}

export function subscribeExportJob(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getExportJobSnapshot(): ExportJobState {
  return jobState;
}

/** React seam onto the live job store. */
export function useExportJob(): ExportJobState {
  return useSyncExternalStore(subscribeExportJob, getExportJobSnapshot, getExportJobSnapshot);
}

// Re-exported for the dialog so the capability payload's inner shape has a name.
export type ExportSigningCapability = ExportCapability['capability'];
