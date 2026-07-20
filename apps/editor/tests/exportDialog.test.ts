/**
 * Export dialog — desktop target. This repo runs tests under the
 * `node` environment (no jsdom/RTL), so the dialog's logic is pulled to module
 * scope in ../src/components/exportJob.ts and unit-tested directly — the same
 * pattern as gameSettingsEdit.test.ts / consoleLinkClick.test.ts.
 *
 * Covers the brief's contract:
 *  - Desktop pane's platform model (four platforms, all preselected).
 *  - Progress frames append to the right platform row.
 *  - Per-platform error renders on its row; a global error becomes a banner.
 *  - Success rows carry each build's zip path.
 *  - The web pane's "Zip for itch.io" checkbox passes zip:true through.
 *  - A second export while one runs surfaces the already-running message.
 */
import { describe, expect, it } from 'vitest';
import type { DesktopExportResult } from '../src/types';
import {
  ALL_DESKTOP_PLATFORMS,
  defaultPlatformSelection,
  desktopExportPlatforms,
  desktopMacGatekeeperNote,
  desktopNextStepHint,
  formatBytes,
  initialExportJob,
  platformLabel,
  reduceExportJob,
  reopenMode,
  resolveOutDir,
  SHIPPING_GUIDE_URL,
  signingStatusLabel,
  stageLabel,
  startResultMessage,
  webExportArgs,
  webNextStepHint,
} from '../src/components/exportJob';

describe('platform model — four platforms, all preselected', () => {
  it('offers exactly the four desktop platforms', () => {
    expect(ALL_DESKTOP_PLATFORMS).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']);
  });

  it('preselects every offered platform', () => {
    const sel = defaultPlatformSelection(ALL_DESKTOP_PLATFORMS);
    expect(sel).toEqual({
      'darwin-arm64': true,
      'darwin-x64': true,
      'win32-x64': true,
      'linux-x64': true,
    });
  });

  it('desktopExportPlatforms keeps only the checked ones, in the offered order', () => {
    const sel = { 'darwin-arm64': true, 'darwin-x64': false, 'win32-x64': true, 'linux-x64': false };
    expect(desktopExportPlatforms(sel, ALL_DESKTOP_PLATFORMS)).toEqual(['darwin-arm64', 'win32-x64']);
  });

  it('gives every platform a human label', () => {
    expect(platformLabel('darwin-arm64')).toBe('macOS (Apple Silicon)');
    expect(platformLabel('darwin-x64')).toBe('macOS (Intel)');
    expect(platformLabel('win32-x64')).toBe('Windows');
    expect(platformLabel('linux-x64')).toBe('Linux');
  });
});

describe('signing status line', () => {
  it('reads the ad-hoc rung', () => {
    expect(signingStatusLabel({ mode: 'adhoc' })).toBe('Ad-hoc signing');
  });
  it('names the identity when signing', () => {
    expect(signingStatusLabel({ mode: 'identity', identity: 'Developer ID: Jake' })).toBe(
      'Signing as Developer ID: Jake',
    );
  });
  it('names the identity when signing + notarizing', () => {
    expect(signingStatusLabel({ mode: 'identity+notarize', identity: 'Jake' })).toBe(
      'Signing + notarizing as Jake',
    );
  });
});

describe('stage labels — the download stage is spelled out for slow first runs', () => {
  it('labels every packaging stage', () => {
    expect(stageLabel('stage')).toBe('Staging');
    expect(stageLabel('download')).toBe('Downloading Electron');
    expect(stageLabel('package')).toBe('Packaging');
    expect(stageLabel('sign')).toBe('Signing');
    expect(stageLabel('notarize')).toBe('Notarizing');
    expect(stageLabel('zip')).toBe('Zipping');
  });
});

describe('reduceExportJob — start seeds a row per selected platform', () => {
  it('opens a pending row for each platform and marks the job running', () => {
    const state = reduceExportJob(initialExportJob(), {
      type: 'start',
      jobId: 'job-1',
      platforms: ['darwin-arm64', 'win32-x64'],
    });
    expect(state.running).toBe(true);
    expect(state.jobId).toBe('job-1');
    expect(state.order).toEqual(['darwin-arm64', 'win32-x64']);
    expect(state.rows['darwin-arm64'].status).toBe('pending');
    expect(state.rows['win32-x64'].status).toBe('pending');
  });
});

describe('reduceExportJob — progress frames append to the right platform row', () => {
  const started = reduceExportJob(initialExportJob(), {
    type: 'start',
    jobId: 'job-1',
    platforms: ['darwin-arm64', 'win32-x64'],
  });

  it('routes a progress frame to its own platform, not the others', () => {
    const s = reduceExportJob(started, {
      type: 'frame',
      frame: { type: 'export-progress', jobId: 'job-1', platform: 'win32-x64', stage: 'download', message: 'Fetching Electron 30 (120 MB)…' },
    });
    expect(s.rows['win32-x64'].stage).toBe('download');
    expect(s.rows['win32-x64'].message).toBe('Fetching Electron 30 (120 MB)…');
    expect(s.rows['win32-x64'].status).toBe('running');
    expect(s.activePlatform).toBe('win32-x64');
    // The other platform's row is untouched.
    expect(started.rows['darwin-arm64'].status).toBe('pending');
    expect(s.rows['darwin-arm64'].message).toBe('');
  });

  it('keeps a platform-less progress frame as a global status message', () => {
    const s = reduceExportJob(started, {
      type: 'frame',
      frame: { type: 'export-progress', jobId: 'job-1', platform: null, stage: 'stage', message: 'Assembling web build…' },
    });
    expect(s.globalMessage).toBe('Assembling web build…');
    expect(s.rows['darwin-arm64'].status).toBe('pending');
  });

  it('ignores frames from a different job', () => {
    const s = reduceExportJob(started, {
      type: 'frame',
      frame: { type: 'export-progress', jobId: 'other', platform: 'win32-x64', stage: 'package', message: 'x' },
    });
    expect(s).toBe(started);
  });
});

describe('reduceExportJob — success rows carry each build zip path', () => {
  const started = reduceExportJob(initialExportJob(), {
    type: 'start',
    jobId: 'job-1',
    platforms: ['darwin-arm64', 'win32-x64'],
  });
  const result: DesktopExportResult = {
    outDir: 'export/desktop',
    slug: 'my-game',
    builds: [
      { platform: 'darwin-arm64', appDir: 'export/desktop/my-game-darwin-arm64', zip: 'export/desktop/my-game-darwin-arm64.zip', signed: 'adhoc', notarized: false, zipBytes: 254_312_448 },
      { platform: 'win32-x64', appDir: 'export/desktop/my-game-win32-x64', zip: 'export/desktop/my-game-win32-x64.zip', signed: 'none', notarized: false },
    ],
  };

  it('marks each built platform success with its zip path and clears running', () => {
    const s = reduceExportJob(started, { type: 'frame', frame: { type: 'export-done', jobId: 'job-1', result } });
    expect(s.running).toBe(false);
    expect(s.finished).toBe(true);
    expect(s.activePlatform).toBeNull();
    expect(s.rows['darwin-arm64'].status).toBe('success');
    expect(s.rows['darwin-arm64'].zip).toBe('export/desktop/my-game-darwin-arm64.zip');
    expect(s.rows['darwin-arm64'].signed).toBe('adhoc');
    expect(s.rows['win32-x64'].zip).toBe('export/desktop/my-game-win32-x64.zip');
    expect(s.result).toEqual(result);
  });

  it('carries each build zipBytes through to its row (F-5), leaving it unset when the server could not stat it', () => {
    const s = reduceExportJob(started, { type: 'frame', frame: { type: 'export-done', jobId: 'job-1', result } });
    expect(s.rows['darwin-arm64'].zipBytes).toBe(254_312_448);
    expect(s.rows['win32-x64'].zipBytes).toBeUndefined();
  });
});

describe('reduceExportJob — errors land per-row or in the banner', () => {
  const started = reduceExportJob(initialExportJob(), {
    type: 'start',
    jobId: 'job-1',
    platforms: ['darwin-arm64', 'win32-x64'],
  });

  it('a per-platform error renders on that platform row, not the banner', () => {
    const s = reduceExportJob(started, {
      type: 'frame',
      frame: { type: 'export-error', jobId: 'job-1', platform: 'win32-x64', message: 'wine not found' },
    });
    expect(s.rows['win32-x64'].status).toBe('error');
    expect(s.rows['win32-x64'].error).toBe('wine not found');
    expect(s.bannerError).toBeNull();
    expect(s.running).toBe(false);
    // The healthy platform row is not turned into an error.
    expect(s.rows['darwin-arm64'].status).toBe('pending');
  });

  it('a global error (no platform) becomes a banner', () => {
    const s = reduceExportJob(started, {
      type: 'frame',
      frame: { type: 'export-error', jobId: 'job-1', message: 'player bundle missing' },
    });
    expect(s.bannerError).toBe('player bundle missing');
    expect(s.running).toBe(false);
    expect(s.rows['win32-x64'].status).toBe('pending');
  });
});

describe('web pane — the zip checkbox passes zip:true through', () => {
  it('threads the zip flag and maps the single-file target', () => {
    const args = webExportArgs('folder', 'export/web', true);
    expect(args.zip).toBe(true);
    expect(args.singleFile).toBe(false);
    expect(args.outDir).toBe('export/web');
  });

  it('leaves zip off when unchecked and maps single-file', () => {
    const args = webExportArgs('single', '  custom/out  ', false);
    expect(args.zip).toBe(false);
    expect(args.singleFile).toBe(true);
    expect(args.outDir).toBe('custom/out');
  });
});

describe('resolveOutDir — falls back when blank', () => {
  it('trims and defaults', () => {
    expect(resolveOutDir('  export/desktop ', 'fallback')).toBe('export/desktop');
    expect(resolveOutDir('   ', 'export/desktop')).toBe('export/desktop');
  });
});

describe('reduceExportJob — a late progress frame never drags a terminal row back to running', () => {
  const started = reduceExportJob(initialExportJob(), {
    type: 'start',
    jobId: 'job-1',
    platforms: ['darwin-arm64', 'win32-x64'],
  });

  it('keeps a succeeded row succeeded (zip path intact)', () => {
    const done = reduceExportJob(started, {
      type: 'frame',
      frame: {
        type: 'export-done',
        jobId: 'job-1',
        result: {
          outDir: 'export/desktop',
          slug: 'g',
          builds: [
            { platform: 'darwin-arm64', appDir: 'a', zip: 'export/desktop/g-darwin-arm64.zip', signed: 'adhoc', notarized: false },
          ],
        },
      },
    });
    const s = reduceExportJob(done, {
      type: 'frame',
      frame: { type: 'export-progress', jobId: 'job-1', platform: 'darwin-arm64', stage: 'package', message: 'late' },
    });
    expect(s.rows['darwin-arm64'].status).toBe('success');
    expect(s.rows['darwin-arm64'].zip).toBe('export/desktop/g-darwin-arm64.zip');
    expect(s.rows['darwin-arm64'].message).not.toBe('late');
  });

  it('keeps an errored row errored', () => {
    const failed = reduceExportJob(started, {
      type: 'frame',
      frame: { type: 'export-error', jobId: 'job-1', platform: 'win32-x64', message: 'boom' },
    });
    const s = reduceExportJob(failed, {
      type: 'frame',
      frame: { type: 'export-progress', jobId: 'job-1', platform: 'win32-x64', stage: 'zip', message: 'late' },
    });
    expect(s.rows['win32-x64'].status).toBe('error');
    expect(s.rows['win32-x64'].error).toBe('boom');
  });
});

describe('reduceExportJob — reset returns to the initial state', () => {
  it('clears a finished job entirely', () => {
    const started = reduceExportJob(initialExportJob(), {
      type: 'start',
      jobId: 'job-1',
      platforms: ['darwin-arm64'],
    });
    const failed = reduceExportJob(started, {
      type: 'frame',
      frame: { type: 'export-error', jobId: 'job-1', message: 'boom' },
    });
    expect(reduceExportJob(failed, { type: 'reset' })).toEqual(initialExportJob());
  });
});

describe('reduceExportJob — export-done extends the order for an unseeded platform', () => {
  it('appends a platform the start did not seed so its success row still renders', () => {
    const started = reduceExportJob(initialExportJob(), {
      type: 'start',
      jobId: 'job-1',
      platforms: ['darwin-arm64'],
    });
    const s = reduceExportJob(started, {
      type: 'frame',
      frame: {
        type: 'export-done',
        jobId: 'job-1',
        result: {
          outDir: 'export/desktop',
          slug: 'g',
          builds: [
            { platform: 'darwin-arm64', appDir: 'a', zip: 'a.zip', signed: 'adhoc', notarized: false },
            { platform: 'linux-x64', appDir: 'b', zip: 'b.zip', signed: 'none', notarized: false },
          ],
        },
      },
    });
    expect(s.order).toEqual(['darwin-arm64', 'linux-x64']);
    expect(s.rows['linux-x64'].status).toBe('success');
    expect(s.rows['linux-x64'].zip).toBe('b.zip');
  });
});

describe('reopenMode — a finished job resurfaces the desktop pane with its results intact', () => {
  const started = reduceExportJob(initialExportJob(), {
    type: 'start',
    jobId: 'job-1',
    platforms: ['darwin-arm64'],
  });

  it('opens onto the desktop pane while a job runs', () => {
    expect(reopenMode(started)).toBe('desktop');
  });

  it('opens onto the desktop pane when a job finished while the dialog was closed', () => {
    const done = reduceExportJob(started, {
      type: 'frame',
      frame: {
        type: 'export-done',
        jobId: 'job-1',
        result: {
          outDir: 'export/desktop',
          slug: 'g',
          builds: [{ platform: 'darwin-arm64', appDir: 'a', zip: 'a.zip', signed: 'adhoc', notarized: false }],
        },
      },
    });
    expect(reopenMode(done)).toBe('desktop');
    // The results a reopen must still show: nothing about routing resets rows.
    expect(done.rows['darwin-arm64'].zip).toBe('a.zip');
  });

  it('opens onto the desktop pane when a job failed while the dialog was closed', () => {
    const failed = reduceExportJob(started, {
      type: 'frame',
      frame: { type: 'export-error', jobId: 'job-1', message: 'boom' },
    });
    expect(reopenMode(failed)).toBe('desktop');
  });

  it('defaults to the web pane when no job has run', () => {
    expect(reopenMode(initialExportJob())).toBe('web');
  });

  it('a new start (Export again) is what clears the previous finished rows', () => {
    const done = reduceExportJob(started, {
      type: 'frame',
      frame: {
        type: 'export-done',
        jobId: 'job-1',
        result: {
          outDir: 'export/desktop',
          slug: 'g',
          builds: [{ platform: 'darwin-arm64', appDir: 'a', zip: 'a.zip', signed: 'adhoc', notarized: false }],
        },
      },
    });
    const restarted = reduceExportJob(done, { type: 'start', jobId: 'job-2', platforms: ['win32-x64'] });
    expect(restarted.rows['darwin-arm64']).toBeUndefined();
    expect(restarted.rows['win32-x64'].status).toBe('pending');
    expect(restarted.result).toBeNull();
  });
});

describe('startResultMessage — a second export while one runs is surfaced', () => {
  it('returns null when the job actually started', () => {
    expect(startResultMessage({ ok: true, jobId: 'job-2' })).toBeNull();
  });

  it('explains an already-running job when the start is refused', () => {
    const msg = startResultMessage({ ok: false });
    expect(msg).toMatch(/already running/i);
  });

  it('prefers a server-supplied reason when present', () => {
    expect(startResultMessage({ ok: false, error: 'busy: try later' })).toBe('busy: try later');
  });
});

describe('next-step hints (F-1 / F-3, L-118 export-friction reaudit)', () => {
  it('points the web pane at getting the build in front of a player', () => {
    expect(webNextStepHint()).toBe('Upload the zip to itch.io or any static host');
    expect(SHIPPING_GUIDE_URL).toBe('https://hearthengine.com/docs/shipping-to-itch');
  });

  it('tells the desktop pane the build just needs unzipping and double-clicking', () => {
    expect(desktopNextStepHint()).toBe('Unzip and share. Players double-click the app.');
  });

  it('adds a Gatekeeper note only when a finished build targets macOS', () => {
    expect(desktopMacGatekeeperNote(['win32-x64', 'linux-x64'])).toBeNull();
    expect(desktopMacGatekeeperNote(['darwin-arm64'])).toMatch(/Gatekeeper/);
    expect(desktopMacGatekeeperNote(['win32-x64', 'darwin-x64'])).toMatch(/right-click/);
  });

  it('has no macOS note at all when nothing finished', () => {
    expect(desktopMacGatekeeperNote([])).toBeNull();
  });
});

describe('formatBytes (F-5, L-118 export-friction reaudit)', () => {
  it('renders a near-empty example project zip in MB, not a raw byte count', () => {
    expect(formatBytes(254_312_448)).toBe('242.5 MB');
  });

  it('handles small sizes below 1KB', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('handles GB-scale sizes', () => {
    expect(formatBytes(1_610_612_736)).toBe('1.5 GB');
  });

  it('returns null when the server could not stat the zip', () => {
    expect(formatBytes(undefined)).toBeNull();
  });
});
