/**
 * End-to-end tests for the `hearth` CLI: spawn it as a real subprocess (via
 * tsx, so no build step is required) and assert on stdout/exit codes. This
 * exercises the same path a coding agent invoking the binary would take.
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
// Spawn node + tsx's JS entry directly (not the .bin shim) so it works on
// Windows too, where the shim is a .cmd file execFile can't run.
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_ENTRY = path.join(__dirname, '..', 'src', 'main.ts');

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function parseJson(stdout: string): any {
  return JSON.parse(stdout);
}

let tmpRoot: string;
let projectDir: string;

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-cli-test-'));
});

afterAll(async () => {
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe('hearth init', () => {
  it('creates a project directly inside an explicit empty --dir', async () => {
    const dir = path.join(tmpRoot, 'proj-a');
    await fsp.mkdir(dir, { recursive: true });
    const result = await runCli(['init', 'My Test Game', '--dir', dir, '--json'], tmpRoot);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.path).toBe(dir);

    const hearthJsonPath = path.join(dir, 'hearth.json');
    const raw = await fsp.readFile(hearthJsonPath, 'utf8');
    const project = JSON.parse(raw);
    expect(project.name).toBe('My Test Game');
    expect(project.scenes.length).toBe(1);

    projectDir = dir; // reused by later describe blocks
  });

  it('refuses to init over an existing project (same target dir twice)', async () => {
    const cwd = path.join(tmpRoot, 'dup-cwd');
    await fsp.mkdir(cwd, { recursive: true });
    const first = await runCli(['init', 'Dup Game', '--json'], cwd);
    expect(first.code).toBe(0);

    const second = await runCli(['init', 'Dup Game', '--json'], cwd);
    expect(second.code).toBe(1);
    const envelope = parseJson(second.stdout);
    expect(envelope.success).toBe(false);
  });
});

describe('hearth inspect / create / set / validate (end-to-end flow)', () => {
  it('inspects the freshly created project', async () => {
    const result = await runCli(['inspect', 'project', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('inspectProject');
    expect(envelope.data.scenes.length).toBe(1);
  });

  it('creates an entity, sets a property, and validates cleanly', async () => {
    const create = await runCli(
      [
        'create',
        'entity',
        'Main',
        'Coin',
        '--components',
        '{"SpriteRenderer":{"shape":"circle","color":"#f1c40f"}}',
        '--json',
      ],
      projectDir,
    );
    expect(create.code).toBe(0);
    const createEnvelope = parseJson(create.stdout);
    expect(createEnvelope.success).toBe(true);
    expect(createEnvelope.data.name).toBe('Coin');

    const set = await runCli(['set', 'Main', 'Coin', 'Transform.position.x', '200', '--json'], projectDir);
    expect(set.code).toBe(0);
    const setEnvelope = parseJson(set.stdout);
    expect(setEnvelope.success).toBe(true);
    expect(setEnvelope.data.component.position.x).toBe(200);

    const validate = await runCli(['validate', '--json'], projectDir);
    expect(validate.code).toBe(0);
    const validateEnvelope = parseJson(validate.stdout);
    expect(validateEnvelope.data.valid).toBe(true);
  });
});

describe('hearth snapshot / diff', () => {
  it('reports changes made after a snapshot', async () => {
    const snap = await runCli(['snapshot', '--json'], projectDir);
    expect(snap.code).toBe(0);

    const createScene = await runCli(['create', 'scene', 'Level2', '--json'], projectDir);
    expect(createScene.code).toBe(0);

    const diff = await runCli(['diff', '--json'], projectDir);
    expect(diff.code).toBe(0);
    const diffEnvelope = parseJson(diff.stdout);
    expect(diffEnvelope.success).toBe(true);
    expect(diffEnvelope.data.hasChanges).toBe(true);
    expect(diffEnvelope.data.stats.scenesAdded).toBe(1);
  });
});

describe('permissions', () => {
  it('denies a mutating command when --allow is read-only', async () => {
    const result = await runCli(['--allow', 'read-only', 'create', 'scene', 'Blocked', '--json'], projectDir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('PERMISSION_DENIED');
  });

  it('still allows read-only commands under --allow read-only', async () => {
    const result = await runCli(['--allow', 'read-only', 'inspect', 'project', '--json'], projectDir);
    expect(result.code).toBe(0);
  });
});

describe('unknown command', () => {
  it('exits 1 for a command the CLI does not recognize', async () => {
    const result = await runCli(['not-a-real-command'], projectDir);
    expect(result.code).toBe(1);
  });
});

describe('hearth commands', () => {
  it('lists more than 30 registered engine commands', async () => {
    const result = await runCli(['commands', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.commands.length).toBeGreaterThan(30);
    const names = envelope.data.commands.map((c: { name: string }) => c.name);
    expect(names).toContain('createScene');
    expect(names).toContain('validateProject');
  });
});

describe('hearth doctor', () => {
  it('reports a healthy project without a project root requirement failing the process', async () => {
    const result = await runCli(['doctor', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.data.projectFound).toBe(true);
    expect(envelope.data.loads).toBe(true);
  });

  it('still runs (without crashing) outside any project', async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-cli-noproj-'));
    const result = await runCli(['doctor', '--json'], outside);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.data.projectFound).toBe(false);
    await fsp.rm(outside, { recursive: true, force: true });
  });
});

describe('runtime-dependent commands', () => {
  it('run: executes a headless scene smoke and reports a passing result', async () => {
    const result = await runCli(['run', 'Main', '--frames', '10', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('runScene');
    expect(envelope.data.framesRun).toBe(10);
    expect(envelope.data.passed).toBe(true);
    expect(envelope.data.errors).toEqual([]);
  });

  it('run: unknown scene fails cleanly with a CommandResult, not a stack trace', async () => {
    const result = await runCli(['run', 'NoSuchScene', '--json'], projectDir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors.length).toBeGreaterThan(0);
    expect(result.stdout).not.toContain('at Object.<anonymous>');
  });
});
