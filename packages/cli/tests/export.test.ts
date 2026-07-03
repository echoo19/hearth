/**
 * End-to-end tests for `hearth export web` and `hearth create sound`: spawn
 * the real CLI with HEARTH_TOOLS_DIR pointing at a stub player bundle, so no
 * runtime player build is required.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_ENTRY = path.join(__dirname, '..', 'src', 'main.ts');

const STUB_PLAYER = 'window.HearthPlayer={boot(){}}';

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
let toolsDir: string;
let projectDir: string;

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-cli-export-'));
  toolsDir = path.join(tmpRoot, 'tools');
  await fsp.mkdir(toolsDir, { recursive: true });
  await fsp.writeFile(path.join(toolsDir, 'hearth-player.js'), STUB_PLAYER);

  projectDir = path.join(tmpRoot, 'zip-game');
  await fsp.mkdir(projectDir, { recursive: true });
  const init = await runCli(['init', 'Zip Game', '--dir', projectDir, '--json'], tmpRoot);
  expect(init.code).toBe(0);
}, 60000);

afterAll(async () => {
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe('hearth create sound', () => {
  it('creates a deterministic WAV asset', async () => {
    const result = await runCli(
      ['create', 'sound', 'Coin Pickup', '--preset', 'coin', '--seed', '3', '--json'],
      projectDir,
    );
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.asset.type).toBe('audio');
    expect(envelope.data.asset.path).toBe('assets/sounds/coin_pickup.wav');

    const wav = await fsp.readFile(path.join(projectDir, 'assets', 'sounds', 'coin_pickup.wav'));
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });
});

describe('hearth export web', () => {
  it('exports a playable web folder and an itch.io-ready zip', async () => {
    const result = await runCli(['export', 'web', '--zip', '--allow', 'build', '--json'], projectDir, {
      HEARTH_TOOLS_DIR: toolsDir,
    });
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('exportWeb');
    expect(envelope.data.outDir).toBe('export/web');
    expect(envelope.data.zip).toBe('export/zip_game-web.zip');

    const html = await fsp.readFile(path.join(projectDir, 'export', 'web', 'index.html'), 'utf8');
    expect(html).toContain('<title>Zip Game</title>');
    const player = await fsp.readFile(path.join(projectDir, 'export', 'web', 'hearth-player.js'), 'utf8');
    expect(player).toBe(STUB_PLAYER);

    // Zip sits next to the exported folder and contains index.html at its root.
    const zip = await fsp.readFile(path.join(projectDir, 'export', 'zip_game-web.zip'));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // local file header signature
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50); // end of central directory
    const names = zip.toString('latin1');
    expect(names).toContain('index.html');
    expect(names).toContain('project.bundle.json');
    expect(names).toContain('hearth-player.js');
    expect(names).not.toContain('web/index.html'); // entries are rooted at the folder itself
  });

  it('exports a single-file build', async () => {
    const result = await runCli(
      ['export', 'web', '--single-file', '--out', 'export/single', '--allow', 'build', '--json'],
      projectDir,
      { HEARTH_TOOLS_DIR: toolsDir },
    );
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.success).toBe(true);
    const html = await fsp.readFile(path.join(projectDir, 'export', 'single', 'index.html'), 'utf8');
    expect(html).toContain(STUB_PLAYER);
    await expect(
      fsp.access(path.join(projectDir, 'export', 'single', 'hearth-player.js')),
    ).rejects.toThrow();
  });
});
