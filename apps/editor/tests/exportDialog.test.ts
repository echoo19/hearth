/**
 * Task 7: Export dialog — desktop target. This repo runs tests under the
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
  initialExportJob,
  platformLabel,
  reduceExportJob,
  resolveOutDir,
  signingStatusLabel,
  stageLabel,
  startResultMessage,
  webExportArgs,
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
      { platform: 'darwin-arm64', appDir: 'export/desktop/my-game-darwin-arm64', zip: 'export/desktop/my-game-darwin-arm64.zip', signed: 'adhoc', notarized: false },
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
