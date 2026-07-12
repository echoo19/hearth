/**
 * In-process tests for `hearth export desktop`: flag parsing, platform
 * validation, the permission guard, and --json/human output shapes — all
 * against a stubbed `resources.packageDesktop`, so these never invoke the
 * real Electron packager (that coverage lives in @hearth/shipping's tests).
 *
 * Unlike the rest of the CLI test suite (which spawns a real subprocess),
 * this file mocks `../src/context.js`'s `openSession` so a session backed by
 * an in-memory project + stub resources can be injected directly into the
 * real `buildProgram()` commander tree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  DEFAULT_MODES,
  parseModes,
  type CommandResources,
  type DesktopBuildSpec,
  type DesktopBuildResult,
} from '@hearth/core';
import type { GlobalOpts } from '../src/context.js';

const STUB_PLAYER = 'window.HearthPlayer={boot(){}}';

let packageDesktopImpl: ((spec: DesktopBuildSpec) => Promise<DesktopBuildResult[]>) | undefined;
let capturedSpecs: DesktopBuildSpec[];

vi.mock('../src/context.js', async () => {
  const actual = await vi.importActual<typeof import('../src/context.js')>('../src/context.js');
  return {
    ...actual,
    openSession: vi.fn(async (opts: GlobalOpts) => {
      const fs = new MemoryFileSystem();
      const { store } = await createProject(fs, '/proj', { name: 'Desktop Export Test' });
      const granted = opts.allow ? parseModes(opts.allow) : [...DEFAULT_MODES];
      const resources: CommandResources = {
        getPlayerBundle: async () => STUB_PLAYER,
        packageDesktop: packageDesktopImpl,
      };
      return HearthSession.fromStore(store, { granted, resources, source: 'cli' });
    }),
  };
});

const { buildProgram } = await import('../src/program.js');

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliRun> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdoutLines.push(a.join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderrLines.push(a.join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
  try {
    const program = buildProgram();
    await program.parseAsync(['node', 'hearth', ...args]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
}

function stubBuild(overrides: Partial<DesktopBuildResult> = {}): DesktopBuildResult {
  return {
    platform: 'darwin-arm64',
    appDir: 'export/desktop/darwin-arm64/Desktop Export Test.app',
    zip: 'export/desktop/desktop_export_test-darwin-arm64.zip',
    signed: 'adhoc',
    notarized: false,
    ...overrides,
  };
}

beforeEach(() => {
  capturedSpecs = [];
  packageDesktopImpl = async (spec) => {
    capturedSpecs.push(spec);
    return spec.platforms.map((platform) => stubBuild({ platform }));
  };
});

describe('hearth export desktop: permission guard', () => {
  it('denies without --allow build (same guard as export web)', async () => {
    const result = await runCli(['export', 'desktop', '--json']);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('PERMISSION_DENIED');
    expect(capturedSpecs).toHaveLength(0);
  });

  it('proceeds with --allow build', async () => {
    const result = await runCli(['export', 'desktop', '--allow', 'build', '--json']);
    expect(result.code).toBe(0);
    expect(capturedSpecs).toHaveLength(1);
  });
});

describe('hearth export desktop: --platform validation', () => {
  it('rejects an unknown platform id, listing the valid ids', async () => {
    const result = await runCli(['export', 'desktop', '--platform', 'bogus-plat', '--allow', 'build', '--json']);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].message).toContain('bogus-plat');
    for (const id of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']) {
      expect(envelope.errors[0].message).toContain(id);
    }
    expect(capturedSpecs).toHaveLength(0);
  });

  it('accepts repeatable --platform flags and passes exactly those through', async () => {
    const result = await runCli([
      'export',
      'desktop',
      '--platform',
      'darwin-arm64',
      '--platform',
      'win32-x64',
      '--allow',
      'build',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(capturedSpecs).toHaveLength(1);
    expect(capturedSpecs[0].platforms).toEqual(['darwin-arm64', 'win32-x64']);
  });

  it('defaults to all four platforms when --platform is omitted', async () => {
    const result = await runCli(['export', 'desktop', '--allow', 'build', '--json']);
    expect(result.code).toBe(0);
    expect(capturedSpecs[0].platforms).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']);
  });
});

describe('hearth export desktop: --out', () => {
  it('defaults --out to export/desktop', async () => {
    await runCli(['export', 'desktop', '--allow', 'build', '--json']);
    expect(capturedSpecs[0].outDirAbs).toBe('/proj/export/desktop');
  });

  it('respects a custom --out', async () => {
    await runCli(['export', 'desktop', '--out', 'dist/desktop', '--allow', 'build', '--json']);
    expect(capturedSpecs[0].outDirAbs).toBe('/proj/dist/desktop');
  });
});

describe('hearth export desktop: --json output', () => {
  it('returns the exportDesktop command result untouched', async () => {
    const result = await runCli(['export', 'desktop', '--platform', 'darwin-arm64', '--allow', 'build', '--json']);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('exportDesktop');
    expect(envelope.data.outDir).toBe('export/desktop');
    expect(envelope.data.builds).toEqual([
      stubBuild({ platform: 'darwin-arm64' }),
    ]);
  });
});

describe('hearth export desktop: human output', () => {
  it('prints a signing header and one line per build', async () => {
    const result = await runCli([
      'export',
      'desktop',
      '--platform',
      'darwin-arm64',
      '--platform',
      'win32-x64',
      '--allow',
      'build',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('signing: ad-hoc');
    expect(result.stdout).toContain('darwin-arm64');
    expect(result.stdout).toContain('desktop_export_test-darwin-arm64.zip');
    expect(result.stdout).toContain('win32-x64');
    expect(result.stdout).toContain('adhoc');
  });

  it('surfaces a failing exportDesktop result in human mode with a non-zero exit code', async () => {
    packageDesktopImpl = async () => {
      throw new Error('packaging exploded');
    };
    const result = await runCli(['export', 'desktop', '--allow', 'build']);
    expect(result.code).toBe(1);
  });
});
