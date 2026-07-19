/**
 * End-to-end tests for `hearth screenshot`: spawns the real CLI against a
 * real starter project, using the actual built @hearth/runtime web player
 * (not a stub) so headless Chrome renders real game content. Chromium-
 * dependent assertions are gated behind canLaunchChromium() so this suite
 * still passes in environments without Chrome/Chromium.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { canLaunchChromium } from '@hearth/playtest';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_ENTRY = path.join(__dirname, '..', 'src', 'main.ts');

async function runCli(args: string[], cwd: string, env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let tmpRoot: string;
let projectDir: string;

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-cli-screenshot-'));
  projectDir = path.join(tmpRoot, 'shot-game');
  await fsp.mkdir(projectDir, { recursive: true });
  // No HEARTH_TOOLS_DIR: loadPlayerBundle() falls back to the repo checkout's
  // packages/runtime/player/hearth-player.js, which must be built (`npm run
  // build -w @hearth/runtime`) for these tests to see real game content.
  const init = await runCli(['init', 'Shot Game', '--dir', projectDir, '--json'], tmpRoot);
  expect(init.code).toBe(0);
}, 60000);

afterAll(async () => {
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe('hearth screenshot: permissions and input validation', () => {
  it('does not require --allow build — screenshot is read-only observation', async () => {
    // Screenshot is how the agent sees its own work; it must work in the default
    // session with no build grant. It may still fail for a non-permission reason
    // (no Chromium / unbuilt runtime here), but never PERMISSION_DENIED.
    const result = await runCli(['screenshot', '--json'], projectDir);
    const envelope = JSON.parse(result.stdout);
    if (!envelope.success) {
      expect(envelope.errors[0].code).not.toBe('PERMISSION_DENIED');
    } else {
      expect(envelope.command).toBe('screenshot');
    }
  });

  it('fails with INVALID_INPUT on a malformed --size', async () => {
    const result = await runCli(['screenshot', '--allow', 'build', '--size', 'huge', '--json'], projectDir);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
  });

  it('fails cleanly on an unknown scene', async () => {
    const result = await runCli(
      ['screenshot', 'NoSuchScene', '--allow', 'build', '--json'],
      projectDir,
    );
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(false);
  });

  it('rejects an absolute --out (project-relative sandbox, enforced in captureScreenshot)', async () => {
    const evilOut = path.join(tmpRoot, 'evil.png');
    const result = await runCli(
      ['screenshot', '--allow', 'build', '--out', evilOut, '--json'],
      projectDir,
    );
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].message).toMatch(/project-relative/);
    await expect(fsp.access(evilOut)).rejects.toThrow();
  });
});

const hasChromium = await canLaunchChromium();

describe('hearth screenshot: real capture', () => {
  it.skipIf(!hasChromium)('captures a PNG of the starter scene at frame 0', async () => {
    const result = await runCli(
      ['screenshot', '--allow', 'build', '--out', 'shot0.png', '--json'],
      projectDir,
    );
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('screenshot');
    expect(envelope.data.frame).toBe(0);
    expect(typeof envelope.data.scene).toBe('string');

    const info = await fsp.stat(path.join(projectDir, 'shot0.png'));
    expect(info.size).toBeGreaterThan(1000);
    const bytes = await fsp.readFile(path.join(projectDir, 'shot0.png'));
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG magic bytes
  }, 30000);

  it.skipIf(!hasChromium)('captures frame 60 with --debug and --size', async () => {
    const result = await runCli(
      [
        'screenshot',
        '--allow', 'build',
        '--frame', '60',
        '--seed', '2',
        '--size', '640x480',
        '--debug',
        '--out', 'shot60-debug.png',
        '--json',
      ],
      projectDir,
    );
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.frame).toBe(60);
    expect(envelope.data.width).toBe(640);
    expect(envelope.data.height).toBe(480);

    const info = await fsp.stat(path.join(projectDir, 'shot60-debug.png'));
    expect(info.size).toBeGreaterThan(1000);
  }, 30000);

  it.skipIf(!hasChromium)('is deterministic: same seed+frame produces identical PNG bytes across runs', async () => {
    const a = await runCli(
      ['screenshot', '--allow', 'build', '--frame', '30', '--seed', '9', '--out', 'det-a.png', '--json'],
      projectDir,
    );
    const b = await runCli(
      ['screenshot', '--allow', 'build', '--frame', '30', '--seed', '9', '--out', 'det-b.png', '--json'],
      projectDir,
    );
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const [bytesA, bytesB] = await Promise.all([
      fsp.readFile(path.join(projectDir, 'det-a.png')),
      fsp.readFile(path.join(projectDir, 'det-b.png')),
    ]);
    expect(Buffer.compare(bytesA, bytesB)).toBe(0);
  }, 30000);
});
