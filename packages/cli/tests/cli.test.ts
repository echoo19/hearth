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

describe('hearth init --template', () => {
  it('lists the available templates with --list-templates', async () => {
    const result = await runCli(['init', '--list-templates', '--json'], tmpRoot);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    const names = envelope.data.templates.map((t: { name: string }) => t.name);
    expect(names).toEqual(['platformer', 'topdown', 'arcade']);
    for (const t of envelope.data.templates) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it('scaffolds a platformer that validates clean, with fresh agent-config', async () => {
    const dir = path.join(tmpRoot, 'tpl-platformer');
    await fsp.mkdir(dir, { recursive: true });
    const result = await runCli(['init', 'My Platformer', '--dir', dir, '--template', 'platformer', '--json'], tmpRoot);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);

    const project = JSON.parse(await fsp.readFile(path.join(dir, 'hearth.json'), 'utf8'));
    expect(project.name).toBe('My Platformer');
    expect(project.id).toMatch(/^prj_/);

    // agent-config is regenerated with the new name + id (not the template's).
    const agentConfig = JSON.parse(await fsp.readFile(path.join(dir, '.hearth', 'agent-config.json'), 'utf8'));
    expect(agentConfig.project).toBe('My Platformer');
    expect(agentConfig.projectId).toBe(project.id);

    // A standard .gitignore was written even though the template ships none.
    const gitignore = await fsp.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('build/');

    // The scaffolded project validates through the real CLI validate command.
    const validate = await runCli(['validate', '--json'], dir);
    expect(validate.code).toBe(0);
    const valEnvelope = parseJson(validate.stdout);
    expect(valEnvelope.success).toBe(true);
    expect(valEnvelope.data.valid).toBe(true);
  });

  it('errors on an unknown template, listing the valid ones', async () => {
    const dir = path.join(tmpRoot, 'tpl-unknown');
    await fsp.mkdir(dir, { recursive: true });
    const result = await runCli(['init', 'Bad', '--dir', dir, '--template', 'roguelike', '--json'], tmpRoot);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    const msg = envelope.errors[0].message;
    expect(msg).toContain('platformer');
    expect(msg).toContain('topdown');
    expect(msg).toContain('arcade');
  });

  it('rejects --template together with --no-starter', async () => {
    const dir = path.join(tmpRoot, 'tpl-conflict');
    await fsp.mkdir(dir, { recursive: true });
    const result = await runCli(
      ['init', 'Conflict', '--dir', dir, '--template', 'arcade', '--no-starter', '--json'],
      tmpRoot,
    );
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
  });

  it('rejects --template together with --width/--height (templates own their build size)', async () => {
    const dir = path.join(tmpRoot, 'tpl-size-conflict');
    await fsp.mkdir(dir, { recursive: true });
    const result = await runCli(
      ['init', 'Sized', '--dir', dir, '--template', 'arcade', '--width', '1234', '--height', '777', '--json'],
      tmpRoot,
    );
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].message).toContain('--width/--height');
    // Nothing was scaffolded.
    await expect(fsp.readFile(path.join(dir, 'hearth.json'))).rejects.toThrow();

    // --height alone conflicts too.
    const heightOnly = await runCli(
      ['init', 'Sized H', '--dir', dir, '--template', 'arcade', '--height', '777', '--json'],
      tmpRoot,
    );
    expect(heightOnly.code).toBe(1);
    expect(parseJson(heightOnly.stdout).success).toBe(false);
  });

  it('refuses to scaffold a template over an existing project', async () => {
    // Same cwd, no --dir: both runs resolve to the same slug dir, so the
    // second scaffolds over an existing hearth.json and must CONFLICT.
    const cwd = path.join(tmpRoot, 'tpl-dup-cwd');
    await fsp.mkdir(cwd, { recursive: true });
    const first = await runCli(['init', 'Dup Tpl', '--template', 'topdown', '--json'], cwd);
    expect(first.code).toBe(0);
    const second = await runCli(['init', 'Dup Tpl', '--template', 'topdown', '--json'], cwd);
    expect(second.code).toBe(1);
    expect(parseJson(second.stdout).success).toBe(false);
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

    const badSet = await runCli(['set', 'Main', 'Coin', 'Transform.postiion.x', '999', '--json'], projectDir);
    expect(badSet.code).not.toBe(0);
    const badSetEnvelope = parseJson(badSet.stdout);
    expect(badSetEnvelope.success).toBe(false);
    expect(badSetEnvelope.errors[0].message).toContain('position');

    const setMany = await runCli(
      ['set-many', 'Main', 'Coin', '--properties', '{"Transform.position.y":300,"Transform.rotation":45}', '--json'],
      projectDir,
    );
    expect(setMany.code).toBe(0);
    const setManyEnvelope = parseJson(setMany.stdout);
    expect(setManyEnvelope.success).toBe(true);
    expect(setManyEnvelope.data.components.Transform.position.y).toBe(300);
    expect(setManyEnvelope.data.components.Transform.rotation).toBe(45);

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

  it('creates a script in a nested scripts directory with --dir', async () => {
    const result = await runCli(['create', 'script', 'noise', '--dir', 'lib', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.data.path).toBe('scripts/lib/noise.lua');
    const source = await fsp.readFile(path.join(projectDir, 'scripts', 'lib', 'noise.lua'), 'utf8');
    expect(source).toContain('local script = {}');
    await fsp.rm(path.join(projectDir, 'scripts', 'lib'), { recursive: true, force: true });
  });

  it('creates a script formatted by default, and verbatim with --no-format', async () => {
    const formatted = await runCli(['create', 'script', 'spin-fmt', '--json'], projectDir);
    expect(formatted.code).toBe(0);
    expect(parseJson(formatted.stdout).data.formatted).toBe(true);
    await fsp.rm(path.join(projectDir, 'scripts', 'spin-fmt.lua'));

    const unformatted = await runCli(['create', 'script', 'spin-noformat', '--no-format', '--json'], projectDir);
    expect(unformatted.code).toBe(0);
    expect(parseJson(unformatted.stdout).data.formatted).toBe(false);
    await fsp.rm(path.join(projectDir, 'scripts', 'spin-noformat.lua'));
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

  it('set-settings sets codeStyle.formatOnSave', async () => {
    const off = await runCli(['set-settings', '--format-on-save', 'false', '--json'], projectDir);
    expect(off.code).toBe(0);
    expect(parseJson(off.stdout).data.codeStyle).toEqual({ formatOnSave: false });

    const on = await runCli(['set-settings', '--format-on-save', 'true', '--json'], projectDir);
    expect(on.code).toBe(0);
    expect(parseJson(on.stdout).data.codeStyle).toEqual({ formatOnSave: true });
  });

  it('set-settings --format-on-save accepts true/false case-insensitively and rejects anything else', async () => {
    // Case-insensitive true/false must still work.
    const upper = await runCli(['set-settings', '--format-on-save', 'TRUE', '--json'], projectDir);
    expect(upper.code).toBe(0);
    expect(parseJson(upper.stdout).data.codeStyle).toEqual({ formatOnSave: true });

    const lower = await runCli(['set-settings', '--format-on-save', 'false', '--json'], projectDir);
    expect(lower.code).toBe(0);
    expect(parseJson(lower.stdout).data.codeStyle).toEqual({ formatOnSave: false });

    // Loose truthiness (anything not the literal string "false" becoming
    // true) must be gone: "yes" and "1" are common but wrong guesses for a
    // boolean flag and must be rejected with a clear error, not silently
    // coerced to true.
    const yes = await runCli(['set-settings', '--format-on-save', 'yes', '--json'], projectDir);
    expect(yes.code).toBe(1);
    const yesEnvelope = parseJson(yes.stdout);
    expect(yesEnvelope.success).toBe(false);
    expect(yesEnvelope.errors[0].code).toBe('INVALID_INPUT');
    expect(yesEnvelope.errors[0].message).toMatch(/--format-on-save/);

    const one = await runCli(['set-settings', '--format-on-save', '1', '--json'], projectDir);
    expect(one.code).toBe(1);
    const oneEnvelope = parseJson(one.stdout);
    expect(oneEnvelope.success).toBe(false);
    expect(oneEnvelope.errors[0].code).toBe('INVALID_INPUT');
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

describe('hearth script search / replace', () => {
  it('search --json returns 1-based line/column matches', async () => {
    await runCli(['create', 'script', 'srch-a', '--json'], projectDir);
    await fsp.writeFile(
      path.join(projectDir, 'scripts', 'srch-a.lua'),
      'local script = {}\nfunction script.onStart(ctx)\n  ctx.log("hello marker")\nend\nreturn script\n',
    );

    const result = await runCli(['script', 'search', 'marker', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.total).toBe(1);
    expect(envelope.data.matches[0]).toMatchObject({ path: 'scripts/srch-a.lua', line: 3 });

    await fsp.rm(path.join(projectDir, 'scripts', 'srch-a.lua'));
  });

  it('search plain-text output prints "path:line:col  preview" per match', async () => {
    await runCli(['create', 'script', 'srch-b', '--json'], projectDir);
    await fsp.writeFile(path.join(projectDir, 'scripts', 'srch-b.lua'), 'local plaintext_marker = 1\n');

    const result = await runCli(['script', 'search', 'plaintext_marker'], projectDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^scripts\/srch-b\.lua:1:7 {2}local plaintext_marker = 1$/m);

    await fsp.rm(path.join(projectDir, 'scripts', 'srch-b.lua'));
  });

  it('search exits 0 even with zero matches — it is a search, not a test', async () => {
    const result = await runCli(['script', 'search', 'no-such-token-xyz'], projectDir);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/no-such-token-xyz/);
  });

  it('replace --dry-run leaves disk untouched and reports per-file counts', async () => {
    await runCli(['create', 'script', 'rep-a', '--json'], projectDir);
    const scriptFile = path.join(projectDir, 'scripts', 'rep-a.lua');
    await fsp.writeFile(scriptFile, 'local value = "before"\n');
    const before = await fsp.readFile(scriptFile, 'utf8');

    const result = await runCli(['script', 'replace', 'before', 'after', '--dry-run'], projectDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('dry run');
    expect(result.stdout).toContain('scripts/rep-a.lua: 1 replacement');

    expect(await fsp.readFile(scriptFile, 'utf8')).toBe(before);
    await fsp.rm(scriptFile);
  });

  it('replace (real run) --json edits the file and applied is true', async () => {
    await runCli(['create', 'script', 'rep-b', '--json'], projectDir);
    const scriptFile = path.join(projectDir, 'scripts', 'rep-b.lua');
    await fsp.writeFile(scriptFile, 'local value = "before"\n');

    const result = await runCli(['script', 'replace', 'before', 'after', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.applied).toBe(true);
    expect(envelope.data.changes).toEqual([{ path: 'scripts/rep-b.lua', count: 1, preview: expect.any(String) }]);

    expect(await fsp.readFile(scriptFile, 'utf8')).toBe('local value = "after"\n');
    await fsp.rm(scriptFile);
  });

  it('replace with an invalid --regex query fails with INVALID_INPUT', async () => {
    const result = await runCli(['script', 'replace', '(', 'x', '--regex', '--json'], projectDir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
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
    // the line must not repeat it.
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

describe('hearth set enabled / set tags', () => {
  it('set enabled toggles an entity, and set (the property setter) still works unambiguously', async () => {
    const dir = path.join(tmpRoot, 'set-enabled');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Set Enabled', '--dir', dir, '--json'], tmpRoot);

    const disable = await runCli(['set', 'enabled', 'Main', 'Player', 'false', '--json'], dir);
    expect(disable.code).toBe(0);
    const disableEnvelope = parseJson(disable.stdout);
    expect(disableEnvelope.success).toBe(true);
    expect(disableEnvelope.command).toBe('setEntityEnabled');
    expect(disableEnvelope.data.enabled).toBe(false);

    const inspected = parseJson((await runCli(['inspect', 'entity', 'Main', 'Player', '--json'], dir)).stdout);
    expect(inspected.data.enabled).toBe(false);

    const enable = await runCli(['set', 'enabled', 'Main', 'Player', 'true', '--json'], dir);
    expect(parseJson(enable.stdout).data.enabled).toBe(true);

    // The plain property setter (`hearth set <scene> <entity> <property> <value>`)
    // must keep working even with the `enabled`/`tags` subcommands registered.
    const propertySet = await runCli(['set', 'Main', 'Player', 'Transform.position.x', '200', '--json'], dir);
    expect(propertySet.code).toBe(0);
    const propertySetEnvelope = parseJson(propertySet.stdout);
    expect(propertySetEnvelope.success).toBe(true);
    expect(propertySetEnvelope.command).toBe('setComponentProperty');
    expect(propertySetEnvelope.data.component.position.x).toBe(200);
  });

  it('set enabled rejects a non-boolean value', async () => {
    const dir = path.join(tmpRoot, 'set-enabled-invalid');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Set Enabled Invalid', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(['set', 'enabled', 'Main', 'Player', 'yes', '--json'], dir);
    expect(result.code).not.toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].message).toContain('expected "true" or "false"');
  });

  it('set tags replaces an entity\'s tags with a comma-separated list', async () => {
    const dir = path.join(tmpRoot, 'set-tags');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Set Tags', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(['set', 'tags', 'Main', 'Player', 'hero,controllable', '--json'], dir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('setEntityTags');
    expect(envelope.data.tags).toEqual(['hero', 'controllable']);

    const inspected = parseJson((await runCli(['inspect', 'entity', 'Main', 'Player', '--json'], dir)).stdout);
    expect(inspected.data.tags).toEqual(['hero', 'controllable']);

    const cleared = await runCli(['set', 'tags', 'Main', 'Player', '', '--json'], dir);
    expect(cleared.code).toBe(0);
    expect(parseJson(cleared.stdout).data.tags).toEqual([]);
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
    // inspectEntity now returns a resolved prefab block. The createPrefab source
    // is legacy-detached (empty ids), so it surfaces the asset link with a null
    // localId rather than the raw marker.
    expect(entity.data.prefab.asset).toBe(envelope.data.asset.id);
    expect(entity.data.prefab.localId).toBeNull();
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

  it('prefab revert <scene> <entity> [component] [path] restores an override to the prefab value', async () => {
    const dir = path.join(tmpRoot, 'prefab-revert');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Prefab Revert', '--dir', dir, '--json'], tmpRoot);
    await runCli(['prefab', 'create', 'Main', 'Player', 'PlayerPrefab', '--json'], dir);
    await runCli(['prefab', 'place', 'PlayerPrefab', 'Main', '--name', 'Player Two', '--json'], dir);

    // Override the placed instance's color, then revert it via the leading-scene form.
    const set = await runCli(['set', 'Main', 'Player Two', 'SpriteRenderer.color', '#123456', '--json'], dir);
    expect(set.code).toBe(0);

    const revert = await runCli(
      ['prefab', 'revert', 'Main', 'Player Two', 'SpriteRenderer', 'color', '--json'],
      dir,
    );
    expect(revert.code).toBe(0);
    const envelope = parseJson(revert.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('revertPrefabOverride');

    // Color restored to the prefab's value (the source Player's default color).
    const inspect = parseJson((await runCli(['inspect', 'entity', 'Main', 'Player Two', '--json'], dir)).stdout);
    expect(inspect.data.components.SpriteRenderer.color).toBe('#3498db');
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

describe('hearth create asset state-machine / set-state-machine', () => {
  /** Create two sprites + an animation named `name`, returning its asset id. */
  async function makeAnimation(name: string): Promise<string> {
    await runCli(['create', 'asset', 'sprite', `${name}_f1`, '--json'], projectDir);
    await runCli(['create', 'asset', 'sprite', `${name}_f2`, '--json'], projectDir);
    const anim = await runCli(
      ['create', 'animation', name, '--frames', `${name}_f1`, `${name}_f2`, '--json'],
      projectDir,
    );
    expect(anim.code).toBe(0);
    return parseJson(anim.stdout).data.asset.id as string;
  }

  function makeDoc(animId: string) {
    return {
      params: { moving: { type: 'bool', default: false } },
      states: [
        { name: 'idle', animation: animId, speed: 1 },
        { name: 'walk', animation: animId, speed: 1 },
      ],
      initial: 'idle',
      transitions: [
        { from: 'idle', to: 'walk', conditions: [{ param: 'moving', op: 'eq', value: true }] },
        { from: 'walk', to: 'idle', conditions: [{ param: 'moving', op: 'eq', value: false }] },
      ],
    };
  }

  it('creates a state machine asset from inline --data JSON', async () => {
    const animId = await makeAnimation('cli_sm_walk');
    const result = await runCli(
      ['create', 'asset', 'state-machine', 'cli-ai', '--data', JSON.stringify(makeDoc(animId)), '--json'],
      projectDir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('createStateMachineAsset');
    expect(envelope.data.path).toBe('assets/statemachines/cli_ai.asm.json');
  });

  it('creates a state machine asset from --data @file', async () => {
    const animId = await makeAnimation('cli_sm_walk2');
    const dataFile = path.join(projectDir, 'sm-doc.json');
    await fsp.writeFile(dataFile, JSON.stringify(makeDoc(animId)));

    const result = await runCli(
      ['create', 'asset', 'state-machine', 'cli-ai-file', '--data', `@${dataFile}`, '--json'],
      projectDir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(typeof envelope.data.assetId).toBe('string');
  });

  it('rejects a state referencing an unknown animation (ASM_ANIMATION_NOT_FOUND)', async () => {
    const result = await runCli(
      [
        'create',
        'asset',
        'state-machine',
        'cli-ai-bad',
        '--data',
        JSON.stringify(makeDoc('ast_doesnotexist')),
        '--json',
      ],
      projectDir,
    );
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('ASM_ANIMATION_NOT_FOUND');
  });

  it('set-state-machine replaces the document in place', async () => {
    const animId = await makeAnimation('cli_sm_walk3');
    const created = await runCli(
      ['create', 'asset', 'state-machine', 'cli-ai-update', '--data', JSON.stringify(makeDoc(animId)), '--json'],
      projectDir,
    );
    expect(created.code).toBe(0);
    const assetId = parseJson(created.stdout).data.assetId as string;

    const newDoc = makeDoc(animId);
    newDoc.states.push({ name: 'attack', animation: animId, speed: 2 });
    const updateResult = await runCli(
      ['set-state-machine', assetId, '--data', JSON.stringify(newDoc), '--json'],
      projectDir,
    );
    expect(updateResult.code).toBe(0);
    const envelope = parseJson(updateResult.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('updateStateMachineAsset');
    expect(envelope.data).toEqual({ assetId });
  });

  it('set-state-machine on an unknown assetId -> NOT_FOUND', async () => {
    const animId = await makeAnimation('cli_sm_walk4');
    const result = await runCli(
      ['set-state-machine', 'ast_doesnotexist', '--data', JSON.stringify(makeDoc(animId)), '--json'],
      projectDir,
    );
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('NOT_FOUND');
  });
});

describe('hearth import asset (single + bulk)', () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

  it('a single source path runs importAsset (unchanged single-asset output)', async () => {
    const src = path.join(tmpRoot, 'import-single.png');
    await fsp.writeFile(src, pngBytes);

    const result = await runCli(['import', 'asset', src, '--name', 'SingleCoin', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('importAsset');
    expect(envelope.data.asset.name).toBe('SingleCoin');
  });

  it('multiple source paths run importAssets as one batch, reporting per-file skips', async () => {
    const dir = path.join(tmpRoot, 'import-multi');
    await fsp.mkdir(dir, { recursive: true });
    const good1 = path.join(dir, 'coin.png');
    const good2 = path.join(dir, 'jump.wav');
    const bad = path.join(dir, 'notes.xyz');
    await fsp.writeFile(good1, pngBytes);
    await fsp.writeFile(good2, pngBytes);
    await fsp.writeFile(bad, pngBytes);

    const result = await runCli(['import', 'asset', good1, good2, bad, '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('importAssets');
    expect(envelope.data.imported).toHaveLength(2);
    expect(envelope.data.skipped).toHaveLength(1);
    expect(envelope.data.skipped[0].code).toBe('UNKNOWN_TYPE');
  });

  it('--recursive expands a directory (including nested subdirectories) into its files', async () => {
    const dir = path.join(tmpRoot, 'import-recursive');
    await fsp.mkdir(path.join(dir, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'top.png'), pngBytes);
    await fsp.writeFile(path.join(dir, 'nested', 'deep.png'), pngBytes);

    const result = await runCli(['import', 'asset', dir, '--recursive', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('importAssets');
    expect(envelope.data.imported).toHaveLength(2);
    expect(envelope.data.imported.map((i: any) => i.name).sort()).toEqual(['deep', 'top']);
  });

  it('a bare directory path without --recursive is a clean INVALID_INPUT error', async () => {
    const dir = path.join(tmpRoot, 'import-bare-dir');
    await fsp.mkdir(dir, { recursive: true });

    const result = await runCli(['import', 'asset', dir, '--json'], projectDir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
  });

  it('--name with multiple source paths is rejected', async () => {
    const dir = path.join(tmpRoot, 'import-name-reject');
    await fsp.mkdir(dir, { recursive: true });
    const a = path.join(dir, 'a.png');
    const b = path.join(dir, 'b.png');
    await fsp.writeFile(a, pngBytes);
    await fsp.writeFile(b, pngBytes);

    const result = await runCli(['import', 'asset', a, b, '--name', 'Nope', '--json'], projectDir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
  });

  it('a --type override applied to a bulk import applies to every file', async () => {
    const dir = path.join(tmpRoot, 'import-type-override');
    await fsp.mkdir(dir, { recursive: true });
    const a = path.join(dir, 'a.dat');
    const b = path.join(dir, 'b.dat');
    await fsp.writeFile(a, pngBytes);
    await fsp.writeFile(b, pngBytes);

    const result = await runCli(['import', 'asset', a, b, '--type', 'other', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.data.imported).toHaveLength(2);
    expect(envelope.data.imported.every((i: any) => i.type === 'other')).toBe(true);
  });
});

describe('hearth create music', () => {
  it('creates a chiptune WAV asset from inline JSON tracks', async () => {
    const dir = path.join(tmpRoot, 'music-ok');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Music Game', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(
      ['create', 'music', 'theme', '--tempo', '120', '--tracks', '[{"wave":"square","notes":"C4 E4 G4 -"}]', '--loop', '--json'],
      dir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('createMusic');
    expect(envelope.data.asset.type).toBe('audio');
    expect(envelope.data.asset.metadata.music.tempo).toBe(120);
    expect(envelope.data.asset.metadata.music.loop).toBe(true);
    const wav = await fsp.readFile(path.join(dir, envelope.data.asset.path));
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('reports a bad note token as INVALID_INPUT', async () => {
    const dir = path.join(tmpRoot, 'music-bad');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Music Bad', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(
      ['create', 'music', 'oops', '--tempo', '120', '--tracks', '[{"wave":"square","notes":"H9"}]', '--json'],
      dir,
    );
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
  });
});

describe('hearth create asset sprite --shading', () => {
  it('records gradient shading + secondaryColor in asset metadata', async () => {
    const dir = path.join(tmpRoot, 'sprite-shading');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Shading Game', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(
      ['create', 'asset', 'sprite', 'orb', '--shape', 'circle', '--color', '#ff0000', '--shading', 'gradient', '--secondary-color', '#000000', '--json'],
      dir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.asset.metadata.shading).toBe('gradient');
    const svg = await fsp.readFile(path.join(dir, envelope.data.asset.path), 'utf8');
    expect(svg).toContain('linearGradient');
  });
});

describe('hearth delete playtest', () => {
  it('removes a playtest definition and its file', async () => {
    const dir = path.join(tmpRoot, 'delete-playtest');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Delete PT', '--dir', dir, '--json'], tmpRoot);
    const created = await runCli(['create', 'playtest', 'smoke', '--scene', 'Main', '--json'], dir);
    expect(created.code).toBe(0);

    const del = await runCli(['delete', 'playtest', 'smoke', '--json'], dir);
    expect(del.code).toBe(0);
    const envelope = parseJson(del.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('deletePlaytest');

    const list = parseJson((await runCli(['inspect', 'project', '--json'], dir)).stdout);
    // Playtest is gone from the project, so a fresh session sees none.
    const files = await fsp.readdir(path.join(dir, 'playtests')).catch(() => []);
    expect(files.some((f) => f.includes('smoke'))).toBe(false);
    expect(list.success).toBe(true);
  });

  it('reports NOT_FOUND for a missing playtest', async () => {
    const dir = path.join(tmpRoot, 'delete-playtest-missing');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Delete PT Missing', '--dir', dir, '--json'], tmpRoot);

    const del = await runCli(['delete', 'playtest', 'ghost', '--json'], dir);
    expect(del.code).toBe(1);
    const envelope = parseJson(del.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('NOT_FOUND');
  });
});

describe('hearth bench', () => {
  it('benchmarks a scene headlessly and reports per-frame timing', async () => {
    const result = await runCli(['bench', 'Main', '--frames', '5', '--warmup', '2', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('benchScene');
    expect(envelope.data.frames).toBe(5);
    expect(envelope.data.sceneName).toBe('Main');
    expect(typeof envelope.data.medianMs).toBe('number');
  });

  it('adds a withinBudget verdict when --budget-ms is given', async () => {
    const result = await runCli(['bench', 'Main', '--frames', '3', '--budget-ms', '16.67', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.data.budgetMs).toBe(16.67);
    expect(typeof envelope.data.withinBudget).toBe('boolean');
  });

  it('defaults the scene to the project initial scene', async () => {
    const result = await runCli(['bench', '--frames', '3', '--json'], projectDir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.sceneName).toBe('Main');
  });
});

describe('hearth sweep', () => {
  it('sweeps a scene with the idle policy and reports verdicts plus a report file', async () => {
    const dir = path.join(tmpRoot, 'sweep-basic');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Sweep Basic', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(
      ['sweep', 'Main', '--policies', 'idle', '--seeds', '2', '--max-frames', '60', '--json'],
      dir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('sweepScene');
    expect(envelope.data.verdicts).toBeDefined();
    expect(typeof envelope.data.reportFile).toBe('string');

    const reportRaw = await fsp.readFile(path.join(dir, envelope.data.reportFile), 'utf8');
    expect(() => JSON.parse(reportRaw)).not.toThrow();
  });

  it('defaults the scene to the project initial scene', async () => {
    const dir = path.join(tmpRoot, 'sweep-default-scene');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Sweep Default Scene', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(['sweep', '--policies', 'idle', '--seeds', '1', '--max-frames', '30', '--json'], dir);
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.data.scene).toBe('main');
  });

  it('--bake freezes one run into a *.playtest.json file', async () => {
    const dir = path.join(tmpRoot, 'sweep-bake');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Sweep Bake', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(
      ['sweep', 'Main', '--policies', 'idle', '--seed-start', '0', '--max-frames', '30', '--bake', 'idle-bake', '--json'],
      dir,
    );
    expect(result.code).toBe(0);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.command).toBe('bakePlaytest');

    const files = await fsp.readdir(path.join(dir, 'playtests'));
    // slugify() turns "-" into "_" for the on-disk file name.
    const baked = files.find((f) => f.endsWith('.playtest.json') && f.includes('idle_bake'));
    expect(baked).toBeDefined();
    const raw = await fsp.readFile(path.join(dir, 'playtests', baked!), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe('idle-bake');
    expect(parsed.seed).toBe(0);
  });

  it('rejects --bake with more than one policy', async () => {
    const dir = path.join(tmpRoot, 'sweep-bake-multi-policy');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Sweep Bake Multi Policy', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(['sweep', 'Main', '--policies', 'idle,mash', '--bake', 'nope', '--json'], dir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
  });

  it('rejects --bake with more than one seed', async () => {
    const dir = path.join(tmpRoot, 'sweep-bake-multi-seed');
    await fsp.mkdir(dir, { recursive: true });
    await runCli(['init', 'Sweep Bake Multi Seed', '--dir', dir, '--json'], tmpRoot);

    const result = await runCli(
      ['sweep', 'Main', '--policies', 'idle', '--seeds', '2', '--bake', 'nope', '--json'],
      dir,
    );
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0].code).toBe('INVALID_INPUT');
  });
});

describe('hearth capture (option validation, no Chromium)', () => {
  it('rejects a frame range that exceeds the hard cap before launching a browser', async () => {
    // step 1 over 0..200 is 201 frames, past MAX_SEQUENCE_FRAMES (64); the
    // validation error fires before any Chromium launch, so this is hermetic.
    const result = await runCli(['capture', 'Main', '--to', '200', '--step', '1', '--json'], projectDir);
    expect(result.code).toBe(1);
    const envelope = parseJson(result.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.command).toBe('capture');
  });
});
