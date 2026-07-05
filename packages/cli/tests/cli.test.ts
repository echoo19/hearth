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

describe('hearth create script / inspect api / set-settings', () => {
  it('creates a Lua script by default', async () => {
    const result = await runCli(['create', 'script', 'spin', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.path).toBe('scripts/spin.lua');
    const source = await fsp.readFile(path.join(projectDir, 'scripts', 'spin.lua'), 'utf8');
    expect(source).toContain('local script = {}');
    expect(source).toContain('ctx.scenes.load(idOrName)');
    // Keep the shared test project free of stray scripts so the later
    // smoke-run tests only exercise what they set up themselves.
    await fsp.rm(path.join(projectDir, 'scripts', 'spin.lua'));
  });

  it('creates a JS script with --language js', async () => {
    const result = await runCli(['create', 'script', 'spin-js', '--language', 'js', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.data.path).toBe('scripts/spin-js.js');
    const source = await fsp.readFile(path.join(projectDir, 'scripts', 'spin-js.js'), 'utf8');
    expect(source).toContain('export default');
    await fsp.rm(path.join(projectDir, 'scripts', 'spin-js.js'));
  });

  it('inspect api returns the machine-readable ctx reference', async () => {
    const result = await runCli(['inspect', 'api', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('inspectApi');
    expect(envelope.data.languages).toEqual(['lua', 'js']);
    const paths = envelope.data.api.map((e: { path: string }) => e.path);
    expect(paths).toContain('scenes.load');
    expect(paths).toContain('save');
    expect(paths).toContain('random.next');
  });

  it('set-settings deep-merges buildSettings and sets the initial scene', async () => {
    const result = await runCli(
      ['set-settings', '--build-settings', '{"title":"CLI Game","loading":{"spinner":true}}', '--json'],
      projectDir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.buildSettings.title).toBe('CLI Game');
    expect(envelope.data.buildSettings.loading.spinner).toBe(true);
    // Untouched loading fields keep their defaults (deep merge, not replace).
    expect(envelope.data.buildSettings.loading.backgroundColor).toBe('#000000');

    const scene = await runCli(['set-settings', '--initial-scene', 'Main', '--json'], projectDir);
    expect(scene.code).toBe(0);
    expect(parseJson(scene.stdout).success).toBe(true);

    const bad = await runCli(['set-settings', '--initial-scene', 'NoSuchScene', '--json'], projectDir);
    expect(bad.code).toBe(1);
    expect(parseJson(bad.stdout).errors[0].code).toBe('NOT_FOUND');
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

describe('hearth create asset slice (sliceSpritesheet)', () => {
  it('slices a spritesheet with frame-size and optional parameters', async () => {
    // First create a sprite asset large enough to slice
    const createResult = await runCli(['create', 'asset', 'sprite', 'sheet', '--width', '128', '--height', '128', '--json'], projectDir);
    expect(createResult.code).toBe(0);

    // Slice it with frame size
    const sliceResult = await runCli(
      ['create', 'asset', 'slice', 'sheet', '--frame-size', '32x32', '--margin', '2', '--spacing', '1', '--prefix', 'frame', '--json'],
      projectDir,
    );
    if (sliceResult.code !== 0) {
      console.error('Slice stderr:', sliceResult.stderr);
      console.error('Slice stdout:', sliceResult.stdout);
    }
    expect(sliceResult.code).toBe(0);
    const envelope = parseJson(sliceResult.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('sliceSpritesheet');
    expect(envelope.data.frameCount).toBeGreaterThan(0);
    expect(envelope.data.frames).toBeInstanceOf(Array);
  });

  it('rejects invalid frame-size format', async () => {
    const createResult = await runCli(['create', 'asset', 'sprite', 'sheet2', '--width', '128', '--height', '128', '--json'], projectDir);
    expect(createResult.code).toBe(0);

    const result = await runCli(
      ['create', 'asset', 'slice', 'sheet2', '--frame-size', 'invalid', '--json'],
      projectDir,
    );
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
  });
});

describe('hearth create asset anim-from-sheet (createAnimationFromSheet)', () => {
  it('creates an animation from a sliced spritesheet with comma-separated frame list', async () => {
    // Create and slice a spritesheet
    const createResult = await runCli(['create', 'asset', 'sprite', 'anim_sheet', '--width', '128', '--height', '128', '--json'], projectDir);
    expect(createResult.code).toBe(0);

    const sliceResult = await runCli(
      ['create', 'asset', 'slice', 'anim_sheet', '--frame-size', '32x32', '--prefix', 'frame', '--json'],
      projectDir,
    );
    expect(sliceResult.code).toBe(0);
    const sliceEnvelope = parseJson(sliceResult.stdout);
    const frameList = sliceEnvelope.data.frames.slice(0, 2).join(',');

    // Create animation from frames
    const animResult = await runCli(
      ['create', 'asset', 'anim-from-sheet', 'my-anim', '--sheet', 'anim_sheet', '--frames', frameList, '--duration', '0.1', '--json'],
      projectDir,
    );
    expect(animResult.code).toBe(0);
    const envelope = parseJson(animResult.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('createAnimationFromSheet');
    expect(envelope.data.asset.id).toBeTruthy();
  });

  it('accepts --no-loop flag to disable looping', async () => {
    // Setup
    const createResult = await runCli(['create', 'asset', 'sprite', 'anim_sheet2', '--width', '128', '--height', '128', '--json'], projectDir);
    expect(createResult.code).toBe(0);

    const sliceResult = await runCli(
      ['create', 'asset', 'slice', 'anim_sheet2', '--frame-size', '32x32', '--prefix', 'frame', '--json'],
      projectDir,
    );
    expect(sliceResult.code).toBe(0);
    const sliceEnvelope = parseJson(sliceResult.stdout);
    const frameList = sliceEnvelope.data.frames.slice(0, 2).join(',');

    const result = await runCli(
      ['create', 'asset', 'anim-from-sheet', 'loop-test', '--sheet', 'anim_sheet2', '--frames', frameList, '--no-loop', '--json'],
      projectDir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
  });
});
