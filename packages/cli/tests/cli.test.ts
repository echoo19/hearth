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

  it('set-settings sets a gamepad button binding end to end', async () => {
    const result = await runCli(
      ['set-settings', '--input-gamepad-buttons', '{"jump":["a"]}', '--json'],
      projectDir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.inputMappings.gamepadButtons).toEqual({ jump: ['a'] });

    // Persisted to hearth.json on disk.
    const raw = JSON.parse(await fsp.readFile(path.join(projectDir, 'hearth.json'), 'utf8'));
    expect(raw.inputMappings.gamepadButtons).toEqual({ jump: ['a'] });
  });
});

describe('hearth check-script', () => {
  it('--json reports valid: true for a syntactically clean --source', async () => {
    const result = await runCli(
      ['check-script', 'scripts/draft.lua', '--source', 'local x = 1\n', '--json'],
      projectDir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('checkScript');
    expect(envelope.data.valid).toBe(true);
    expect(envelope.data.language).toBe('lua');
    expect(envelope.data.diagnostics).toEqual([]);
  });

  it('exits non-zero and prints one "path:line message" line per diagnostic for broken --source', async () => {
    const result = await runCli(
      ['check-script', 'scripts/draft.lua', '--source', 'if x then\n'],
      projectDir,
    );
    expect(result.code).toBe(1);
    const lines = result.stdout.split('\n');
    const diagLine = lines.find((l) => l.startsWith('scripts/draft.lua:'));
    expect(diagLine).toBeTruthy();
  });

  it('infers js from the <path> extension when --source is given without --language', async () => {
    const result = await runCli(
      ['check-script', 'scripts/draft.js', '--source', 'export default {\n  onUpdate(ctx, dt) {\n};\n', '--json'],
      projectDir,
    );
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.data.language).toBe('js');
    expect(envelope.data.valid).toBe(false);
  });

  it('with no --source, reads and checks an existing project script by path', async () => {
    await runCli(['create', 'script', 'chk-good', '--json'], projectDir);
    const result = await runCli(['check-script', 'scripts/chk-good.lua', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.data.valid).toBe(true);
    await fsp.rm(path.join(projectDir, 'scripts', 'chk-good.lua'));
  });

  it('never writes: the checked script file is unchanged on disk', async () => {
    await runCli(['create', 'script', 'chk-untouched', '--json'], projectDir);
    const scriptFile = path.join(projectDir, 'scripts', 'chk-untouched.lua');
    const before = await fsp.readFile(scriptFile, 'utf8');
    await runCli(['check-script', 'scripts/chk-untouched.lua', '--source', 'if x then\n', '--json'], projectDir);
    const after = await fsp.readFile(scriptFile, 'utf8');
    expect(after).toBe(before);
    await fsp.rm(scriptFile);
  });

  it('a path outside scripts/ fails with INVALID_INPUT', async () => {
    const result = await runCli(['check-script', 'hearth.json', '--json'], projectDir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
  });

  it('a traversal payload (scripts/../hearth.json) fails with INVALID_INPUT and discloses nothing', async () => {
    const result = await runCli(['check-script', 'scripts/../hearth.json', '--json'], projectDir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
    // No diagnostics leaking hearth.json contents through syntax-error messages.
    expect(envelope.data).toBeNull();
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

describe('hearth undo / redo / history', () => {
  it('undo with nothing recorded returns a friendly NOT_FOUND error envelope', async () => {
    const dir = path.join(tmpRoot, 'history-empty');
    await fsp.mkdir(dir, { recursive: true });
    const init = await runCli(['init', 'Empty History', '--dir', dir, '--json'], tmpRoot);
    expect(init.code).toBe(0);

    const result = await runCli(['undo', '--json'], dir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.command).toBe('undo');
    expect(envelope.errors[0].code).toBe('NOT_FOUND');
  });

  it('redo with nothing recorded returns a friendly NOT_FOUND error envelope', async () => {
    const dir = path.join(tmpRoot, 'history-redo-empty');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Redo Empty', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(['redo', '--json'], dir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.command).toBe('redo');
    expect(envelope.errors[0].code).toBe('NOT_FOUND');
  });

  it('history --json lists a recorded mutation, and undo/redo navigate it', async () => {
    const dir = path.join(tmpRoot, 'history-flow');
    await fsp.mkdir(dir, { recursive: true });
    const init = await runCli(['init', 'History Flow', '--dir', dir, '--json'], tmpRoot);
    expect(init.code).toBe(0);

    const create = await runCli(['create', 'scene', 'Level2', '--json'], dir);
    expect(create.code).toBe(0);

    const history = await runCli(['history', '--json'], dir);
    expect(history.code).toBe(0);
    const historyEnvelope = parseJson(history.stdout);
    expect(historyEnvelope.success).toBe(true);
    expect(historyEnvelope.command).toBe('listHistory');
    expect(historyEnvelope.data.entries.length).toBe(1);
    expect(historyEnvelope.data.entries[0].seq).toBe(1);
    expect(historyEnvelope.data.entries[0].command).toBe('createScene');
    expect(historyEnvelope.data.entries[0].undone).toBe(false);

    const humanHistory = await runCli(['history'], dir);
    expect(humanHistory.code).toBe(0);
    // Exact full line: two-space prefix for live entries, and the summary
    // already leads with the command name (no "createScene createScene" dupe).
    expect(humanHistory.stdout.split('\n')).toContain('  [1] createScene Level2');
    expect(humanHistory.stdout).not.toContain('~');

    const undo = await runCli(['undo', '--json'], dir);
    expect(undo.code).toBe(0);
    const undoEnvelope = parseJson(undo.stdout);
    expect(undoEnvelope.success).toBe(true);
    expect(undoEnvelope.command).toBe('undo');
    expect(undoEnvelope.data.undone).toBe('createScene');
    expect(undoEnvelope.data.seq).toBe(1);

    const scenesAfterUndo = parseJson((await runCli(['inspect', 'scenes', '--json'], dir)).stdout);
    expect(scenesAfterUndo.data.scenes.some((s: { name: string }) => s.name === 'Level2')).toBe(false);

    const humanAfterUndo = await runCli(['history'], dir);
    expect(humanAfterUndo.code).toBe(0);
    expect(humanAfterUndo.stdout.split('\n')).toContain('~ [1] createScene Level2');

    const redo = await runCli(['redo', '--json'], dir);
    expect(redo.code).toBe(0);
    const redoEnvelope = parseJson(redo.stdout);
    expect(redoEnvelope.success).toBe(true);
    expect(redoEnvelope.command).toBe('redo');
    expect(redoEnvelope.data.redone).toBe('createScene');
    expect(redoEnvelope.data.seq).toBe(1);

    const scenesAfterRedo = parseJson((await runCli(['inspect', 'scenes', '--json'], dir)).stdout);
    expect(scenesAfterRedo.data.scenes.some((s: { name: string }) => s.name === 'Level2')).toBe(true);
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

describe('hearth log', () => {
  it('--json lists journal entries after a mutation', async () => {
    const dir = path.join(tmpRoot, 'log-json');
    await fsp.mkdir(dir, { recursive: true });
    const init = await runCli(['init', 'Log Json', '--dir', dir, '--json'], tmpRoot);
    expect(init.code).toBe(0);

    const create = await runCli(['create', 'scene', 'Level2', '--json'], dir);
    expect(create.code).toBe(0);

    const log = await runCli(['log', '--json'], dir);
    expect(log.code).toBe(0);
    const envelope = parseJson(log.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('listJournal');
    expect(envelope.data.entries.length).toBe(1);
    expect(envelope.data.entries[0].command).toBe('createScene');
    expect(envelope.data.entries[0].source).toBe('cli');
    expect(envelope.data.lastSeq).toBe(1);
  });

  it('human format renders one line per entry, oldest-first, without duplicating the command name', async () => {
    const dir = path.join(tmpRoot, 'log-human');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Log Human', '--dir', dir, '--json'], tmpRoot);
    await runCli(['create', 'scene', 'Level2', '--json'], dir);

    const log = await runCli(['log'], dir);
    expect(log.code).toBe(0);
    // summary already leads with the command name ("createScene Level2") —
    // the line must not repeat it (Wave D T3 lesson).
    expect(log.stdout.split('\n')).toContain('#1 [cli] createScene Level2');
    expect(log.stdout).not.toContain('createScene createScene');
  });

  it('a failing command appends with an ok=false error-code suffix', async () => {
    const dir = path.join(tmpRoot, 'log-fail');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Log Fail', '--dir', dir, '--json'], tmpRoot);
    await runCli(['create', 'scene', 'Level2', '--json'], dir);
    const dup = await runCli(['create', 'scene', 'Level2', '--json'], dir);
    expect(dup.code).toBe(1);

    const log = await runCli(['log'], dir);
    expect(log.code).toBe(0);
    expect(log.stdout.split('\n')).toContain('#2 [cli] createScene Level2 (CONFLICT)');
  });

  it('--since and --limit page the journal', async () => {
    const dir = path.join(tmpRoot, 'log-page');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Log Page', '--dir', dir, '--json'], tmpRoot);
    await runCli(['create', 'scene', 'Level2', '--json'], dir);
    await runCli(['create', 'scene', 'Level3', '--json'], dir);
    await runCli(['create', 'scene', 'Level4', '--json'], dir);

    const page = await runCli(['log', '--since', '1', '--limit', '1', '--json'], dir);
    expect(page.code).toBe(0);
    const envelope = parseJson(page.stdout);
    expect(envelope.data.entries.length).toBe(1);
    expect(envelope.data.entries[0].seq).toBe(2);
    expect(envelope.data.lastSeq).toBe(3);
  });
});

describe('hearth delete asset', () => {
  it('by default deletes the file too (deleteFile=true) and unregisters the asset', async () => {
    const dir = path.join(tmpRoot, 'delete-asset-default');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Delete Asset Default', '--dir', dir, '--json'], tmpRoot);

    const create = await runCli(['create', 'asset', 'sprite', 'coin', '--json'], dir);
    expect(create.code).toBe(0);
    const created = parseJson(create.stdout);
    const assetPath: string = created.data.asset.path;

    const del = await runCli(['delete', 'asset', 'coin', '--json'], dir);
    expect(del.code).toBe(0);
    const deleted = parseJson(del.stdout);
    expect(deleted.success).toBe(true);
    expect(deleted.command).toBe('removeAsset');
    expect(deleted.data.fileDeleted).toBe(true);

    await expect(fsp.access(path.join(dir, assetPath))).rejects.toThrow();

    const assets = parseJson((await runCli(['inspect', 'assets', '--json'], dir)).stdout);
    expect(assets.data.assets.some((a: { name: string }) => a.name === 'coin')).toBe(false);
  });

  it('--keep-file unregisters the asset but leaves the file on disk (deleteFile=false)', async () => {
    const dir = path.join(tmpRoot, 'delete-asset-keep');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Delete Asset Keep', '--dir', dir, '--json'], tmpRoot);

    const create = await runCli(['create', 'asset', 'sprite', 'coin', '--json'], dir);
    expect(create.code).toBe(0);
    const created = parseJson(create.stdout);
    const assetPath: string = created.data.asset.path;

    const del = await runCli(['delete', 'asset', 'coin', '--keep-file', '--json'], dir);
    expect(del.code).toBe(0);
    const deleted = parseJson(del.stdout);
    expect(deleted.success).toBe(true);
    expect(deleted.data.fileDeleted).toBe(false);

    await fsp.access(path.join(dir, assetPath)); // still present, does not throw

    const assets = parseJson((await runCli(['inspect', 'assets', '--json'], dir)).stdout);
    expect(assets.data.assets.some((a: { name: string }) => a.name === 'coin')).toBe(false);
  });
});

describe('hearth duplicate', () => {
  it('duplicate scene creates a copy and, with --with-playtests, clones targeting playtests', async () => {
    const dir = path.join(tmpRoot, 'duplicate-scene');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Duplicate Scene', '--dir', dir, '--json'], tmpRoot);
    const createPt = await runCli(['create', 'playtest', 'smoke', '--scene', 'Main', '--json'], dir);
    expect(createPt.code).toBe(0);

    const dup = await runCli(['duplicate', 'scene', 'Main', 'Main Copy', '--with-playtests', '--json'], dir);
    expect(dup.code).toBe(0);
    const envelope = parseJson(dup.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('duplicateScene');
    expect(envelope.data.name).toBe('Main Copy');
    expect(envelope.data.playtestsCloned).toBe(1);

    const scenes = parseJson((await runCli(['inspect', 'scenes', '--json'], dir)).stdout);
    expect(scenes.data.scenes.some((s: { name: string }) => s.name === 'Main Copy')).toBe(true);
  });

  it('duplicate entity supports --name and --offset', async () => {
    const dir = path.join(tmpRoot, 'duplicate-entity');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Duplicate Entity', '--dir', dir, '--json'], tmpRoot);

    const dup = await runCli(
      ['duplicate', 'entity', 'Main', 'Player', '--name', 'Player Two', '--offset', '5,10', '--json'],
      dir,
    );
    expect(dup.code).toBe(0);
    const envelope = parseJson(dup.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('duplicateEntity');
    expect(envelope.data.name).toBe('Player Two');
    expect(envelope.data.copiedCount).toBe(1);

    const entity = parseJson(
      (await runCli(['inspect', 'entity', 'Main', envelope.data.entityId, '--json'], dir)).stdout,
    );
    // Starter Player entity is created at (400, 480); offset is additive.
    expect(entity.data.components.Transform.position).toEqual({ x: 405, y: 490 });
  });

  it('duplicate entity defaults --name to "<name> copy" and --offset to 16,16', async () => {
    const dir = path.join(tmpRoot, 'duplicate-entity-defaults');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Duplicate Entity Defaults', '--dir', dir, '--json'], tmpRoot);

    const dup = await runCli(['duplicate', 'entity', 'Main', 'Player', '--json'], dir);
    expect(dup.code).toBe(0);
    const envelope = parseJson(dup.stdout);
    expect(envelope.data.name).toBe('Player copy');
  });
});

describe('hearth prefab', () => {
  it('prefab create serializes a subtree into a prefab asset and marks the source root', async () => {
    const dir = path.join(tmpRoot, 'prefab-create');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Prefab Create', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(['prefab', 'create', 'Main', 'Player', 'PlayerPrefab', '--json'], dir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('createPrefab');
    expect(envelope.data.asset.name).toBe('PlayerPrefab');
    expect(envelope.data.asset.type).toBe('prefab');
    expect(envelope.data.entityCount).toBe(1);

    const entity = parseJson((await runCli(['inspect', 'entity', 'Main', 'Player', '--json'], dir)).stdout);
    expect(entity.data.prefab).toEqual({ asset: envelope.data.asset.id });
  });

  it('prefab place instantiates into a scene with --position and --name', async () => {
    const dir = path.join(tmpRoot, 'prefab-place');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Prefab Place', '--dir', dir, '--json'], tmpRoot);
    await runCli(['prefab', 'create', 'Main', 'Player', 'PlayerPrefab', '--json'], dir);
    await runCli(['create', 'scene', 'Level2', '--json'], dir);

    const place = await runCli(
      ['prefab', 'place', 'PlayerPrefab', 'Level2', '--position', '50,60', '--name', 'Player Clone', '--json'],
      dir,
    );
    expect(place.code).toBe(0);
    const envelope = parseJson(place.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('instantiatePrefab');
    expect(envelope.data.entity.name).toBe('Player Clone');
    expect(envelope.data.entity.components.Transform.position).toEqual({ x: 50, y: 60 });
    expect(envelope.data.entityCount).toBe(1);
  });

  it('prefab place with an unknown prefab fails cleanly with NOT_FOUND', async () => {
    const dir = path.join(tmpRoot, 'prefab-place-missing');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Prefab Place Missing', '--dir', dir, '--json'], tmpRoot);

    const place = await runCli(['prefab', 'place', 'NoSuchPrefab', 'Main', '--json'], dir);
    expect(place.code).toBe(1);
    const envelope = parseJson(place.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('NOT_FOUND');
  });

  it('prefab update rewrites the payload from a modified instance, and prefab sync rebuilds instances', async () => {
    const dir = path.join(tmpRoot, 'prefab-update-sync');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Prefab Update Sync', '--dir', dir, '--json'], tmpRoot);
    await runCli(['prefab', 'create', 'Main', 'Player', 'PlayerPrefab', '--json'], dir);
    await runCli(
      ['prefab', 'place', 'PlayerPrefab', 'Main', '--position', '10,20', '--name', 'Player Two', '--json'],
      dir,
    );

    const setColor = await runCli(
      ['set', 'Main', 'Player', 'SpriteRenderer.color', '#123456', '--json'],
      dir,
    );
    expect(setColor.code).toBe(0);

    const update = await runCli(['prefab', 'update', 'PlayerPrefab', 'Main', 'Player', '--json'], dir);
    expect(update.code).toBe(0);
    const updateEnvelope = parseJson(update.stdout);
    expect(updateEnvelope.success).toBe(true);
    expect(updateEnvelope.command).toBe('updatePrefab');
    expect(updateEnvelope.data.asset.name).toBe('PlayerPrefab');

    const sync = await runCli(['prefab', 'sync', 'PlayerPrefab', '--scene', 'Main', '--json'], dir);
    expect(sync.code).toBe(0);
    const syncEnvelope = parseJson(sync.stdout);
    expect(syncEnvelope.success).toBe(true);
    expect(syncEnvelope.command).toBe('syncPrefabInstances');
    expect(syncEnvelope.data.total).toBe(2);

    const clone = parseJson((await runCli(['inspect', 'entity', 'Main', 'Player Two', '--json'], dir)).stdout);
    expect(clone.data.components.SpriteRenderer.color).toBe('#123456');
  });

  it('prefab update errors PREFAB_NOT_INSTANCE for an entity without a matching marker', async () => {
    const dir = path.join(tmpRoot, 'prefab-update-not-instance');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Prefab Update Not Instance', '--dir', dir, '--json'], tmpRoot);
    await runCli(['prefab', 'create', 'Main', 'Player', 'PlayerPrefab', '--json'], dir);

    const update = await runCli(['prefab', 'update', 'PlayerPrefab', 'Main', 'Ground', '--json'], dir);
    expect(update.code).toBe(1);
    const envelope = parseJson(update.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('PREFAB_NOT_INSTANCE');
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
