/**
 * How much the agent may do without asking: where it is stored, and what each
 * mode means to each backend.
 *
 * This is the one preference in the app where being wrong is a security bug
 * rather than an annoyance, so the tests are about the failures specifically:
 *
 *   1. it is stored PER MACHINE, in `~/.hearth/`, and never in the project
 *      folder. A `skip` that travelled in a committed file would hand whoever
 *      clones the game an agent running with `bypassPermissions` and
 *      `danger-full-access` on their own computer;
 *   2. an unrecognised mode is REJECTED, never coerced. Coercion has one
 *      plausible shape (fall back to the default) and it lies in the dangerous
 *      direction, telling a client `skip` while running `auto` or the reverse;
 *   3. everything that can go wrong reads as the default, and the default is
 *      today's behaviour. There is no state in which failing to read this file
 *      leaves the agent more permissive than it is out of the box;
 *   4. both backends get the SAME answer for a mode. The user chose how much
 *      the agent may do, not how much this vendor's agent may do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PERMISSION_MODE,
  MAX_PERMISSION_PROJECTS,
  getPermissionMode,
  isPermissionMode,
  permissionModePath,
  postPermissionMode,
  readPermissionMode,
  readPermissionState,
  readSkipAcknowledged,
  writePermissionMode,
  permissionKey,
  writeSkipAcknowledged,
} from '../server/permissionMode';
import { sdkApprovalFor, sdkPermissionMode } from '../server/chat';
import { codexPermissionParams } from '../server/chatDrivers/codexWire';

let home = '';
let previous: string | undefined;
/**
 * Fixture paths, written the way the platform running the test writes them.
 *
 * These were POSIX literals, which is a claim that everyone runs macOS or
 * Linux. `permissionKey` resolves what it is given, so on Windows `/w/game`
 * becomes `D:\w\game`, and a test that hand-wrote `/w/game` into the file and
 * then asked for `/w/game` back was asking a question the code had never been
 * given the answer to. Eight tests failed on the Windows runner and none on
 * anyone's Mac, which is the worst shape a test can have: green where it is
 * written, red where it ships.
 *
 * `path.resolve` here rather than a hardcoded `C:\...`, so the fixture is
 * whatever this platform means by that path, and the assertions below stay
 * about behaviour rather than about separators.
 */
const PROJECT = path.resolve('/w/game');
const OTHER = path.resolve('/w/other');

beforeEach(async () => {
  previous = process.env.HEARTH_HOME;
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-permissions-'));
  process.env.HEARTH_HOME = home;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.HEARTH_HOME;
  else process.env.HEARTH_HOME = previous;
  await fsp.rm(home, { recursive: true, force: true });
});

const readFile = async (): Promise<string> => fsp.readFile(permissionModePath(), 'utf8');

// ---------------------------------------------------------------------------
// Where it lives
// ---------------------------------------------------------------------------

describe('storage', () => {
  it('writes into ~/.hearth and nowhere near the project folder', async () => {
    await writePermissionMode(PROJECT, 'skip');
    expect(permissionModePath()).toBe(path.join(home, 'permissions.json'));
    // The whole security argument for this module in one assertion: nothing
    // about this decision is written where a `git add .` could pick it up.
    const text = await readFile();
    expect(text).toContain('skip');
    await expect(fsp.readFile(path.join(PROJECT, '.hearth', 'project.json'), 'utf8')).rejects.toThrow();
  });

  it('round-trips every mode', async () => {
    for (const mode of ['ask', 'skip', 'auto'] as const) {
      expect(await writePermissionMode(PROJECT, mode)).toBe(mode);
      expect(await readPermissionMode(PROJECT)).toBe(mode);
    }
  });

  it('keys by project, so one folder cannot answer for another', async () => {
    await writePermissionMode(PROJECT, 'skip');
    expect(await readPermissionMode(OTHER)).toBe(DEFAULT_PERMISSION_MODE);
    await writePermissionMode(OTHER, 'ask');
    expect(await readPermissionMode(PROJECT)).toBe('skip');
  });

  it('treats the same folder spelled two ways as one project', async () => {
    await writePermissionMode(`${PROJECT}${path.sep}`, 'ask');
    expect(await readPermissionMode(PROJECT)).toBe('ask');
  });

  it('defaults a project nobody has configured', async () => {
    expect(await readPermissionMode(path.resolve('/w/never-seen'))).toBe('auto');
    expect(await readSkipAcknowledged(path.resolve('/w/never-seen'))).toBe(false);
  });

  it('defaults when the file is missing, corrupt, or the wrong shape', async () => {
    expect(await readPermissionMode(PROJECT)).toBe('auto'); // no file at all
    await fsp.mkdir(home, { recursive: true });
    for (const junk of ['{ this is not json', '[]', 'null', '"a string"', '{}', '{"projects":[]}']) {
      await fsp.writeFile(permissionModePath(), junk);
      expect(await readPermissionMode(PROJECT)).toBe('auto');
    }
  });

  it('defaults a project whose stored mode is a word this build does not know', async () => {
    // The failure (2) exists to prevent, arriving from the file side: a mode
    // Hearth cannot honour must not be treated as any of the three it can.
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(permissionModePath(), JSON.stringify({ projects: { [PROJECT]: { mode: 'yolo' } } }));
    expect(await readPermissionMode(PROJECT)).toBe('auto');
  });

  it('keeps the good entries in a file with one bad one', async () => {
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(
      permissionModePath(),
      JSON.stringify({ projects: { [PROJECT]: { mode: 'ask' }, [OTHER]: 'not an object' } }),
    );
    expect(await readPermissionMode(PROJECT)).toBe('ask');
    expect(await readPermissionMode(OTHER)).toBe('auto');
  });

  it('refuses to store a mode that is not one, rather than coercing it', async () => {
    await expect(writePermissionMode(PROJECT, 'yolo' as never)).rejects.toThrow();
    await expect(writePermissionMode(PROJECT, '' as never)).rejects.toThrow();
    expect(await readPermissionMode(PROJECT)).toBe('auto');
  });

  it('leaves other projects alone on a write', async () => {
    await writePermissionMode(OTHER, 'skip');
    await writeSkipAcknowledged(OTHER, true);
    await writePermissionMode(PROJECT, 'ask');
    expect(await readPermissionState(OTHER)).toEqual({ mode: 'skip', skipAcknowledged: true });
  });

  it('deletes the file rather than leaving entries that say nothing', async () => {
    await writePermissionMode(PROJECT, 'skip');
    await expect(readFile()).resolves.toContain('skip');
    await writePermissionMode(PROJECT, 'auto');
    // "Everyone is on the default" and "no file" are the same state.
    await expect(readFile()).rejects.toThrow();
  });

  it('writes a file a person can read and edit', async () => {
    await writePermissionMode(PROJECT, 'ask');
    const text = await readFile();
    expect(JSON.parse(text)).toEqual({ projects: { [permissionKey(PROJECT)]: { mode: 'ask', skipAcknowledged: false } } });
    expect(text.endsWith('\n')).toBe(true);
  });

  it('caps a file that has grown past anything a real machine could be', async () => {
    const projects: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PERMISSION_PROJECTS + 20; i++) projects[`/w/p${i}`] = { mode: 'skip' };
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(permissionModePath(), JSON.stringify({ projects }));
    await writePermissionMode(PROJECT, 'ask');
    const after = JSON.parse(await readFile()) as { projects: Record<string, unknown> };
    expect(Object.keys(after.projects)).toHaveLength(MAX_PERMISSION_PROJECTS);
    // The entry just written is never the one dropped.
    expect(await readPermissionMode(PROJECT)).toBe('ask');
  });

  it('recognises the three modes and nothing else', () => {
    expect(isPermissionMode('ask')).toBe(true);
    expect(isPermissionMode('auto')).toBe(true);
    expect(isPermissionMode('skip')).toBe(true);
    expect(isPermissionMode('default')).toBe(false);
    expect(isPermissionMode('bypassPermissions')).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The warning
// ---------------------------------------------------------------------------

describe('the skip acknowledgement', () => {
  it('starts unacknowledged and round-trips', async () => {
    expect(await readSkipAcknowledged(PROJECT)).toBe(false);
    expect(await writeSkipAcknowledged(PROJECT, true)).toBe(true);
    expect(await readSkipAcknowledged(PROJECT)).toBe(true);
    expect(await writeSkipAcknowledged(PROJECT, false)).toBe(false);
  });

  it('survives leaving skip and coming back', async () => {
    // Derived from the mode it would re-warn every time, which is how a warning
    // becomes something people click through without reading.
    await writePermissionMode(PROJECT, 'skip');
    await writeSkipAcknowledged(PROJECT, true);
    await writePermissionMode(PROJECT, 'auto');
    await writePermissionMode(PROJECT, 'skip');
    expect(await readSkipAcknowledged(PROJECT)).toBe(true);
  });

  it('is remembered per project, like the mode', async () => {
    await writeSkipAcknowledged(PROJECT, true);
    expect(await readSkipAcknowledged(OTHER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe('the route', () => {
  it('answers a read with the mode and whether the warning was accepted', async () => {
    expect(await getPermissionMode(PROJECT)).toEqual({
      status: 200,
      body: { ok: true, mode: 'auto', skipAcknowledged: false },
    });
  });

  it('refuses a read with no project', async () => {
    for (const bad of [undefined, null, '', '   ', 42]) {
      const result = await getPermissionMode(bad);
      expect(result.status).toBe(400);
      expect((result.body as { ok: boolean }).ok).toBe(false);
    }
  });

  it('stores a mode and reads it back', async () => {
    const posted = await postPermissionMode({ project: PROJECT, mode: 'ask' });
    expect(posted).toEqual({ status: 200, body: { ok: true, mode: 'ask', skipAcknowledged: false } });
    expect(await getPermissionMode(PROJECT)).toMatchObject({ body: { mode: 'ask' } });
  });

  it('takes the mode and the acknowledgement in one request', async () => {
    // The confirm dialog answers both at once; two requests would leave a
    // window where the mode is skip and the warning is unrecorded.
    const posted = await postPermissionMode({ project: PROJECT, mode: 'skip', skipAcknowledged: true });
    expect(posted.body).toEqual({ ok: true, mode: 'skip', skipAcknowledged: true });
  });

  it('rejects an unrecognised mode with a 400 and stores nothing', async () => {
    for (const mode of ['yolo', 'bypassPermissions', 'default', 'ASK', '', 3]) {
      const result = await postPermissionMode({ project: PROJECT, mode });
      expect(result.status).toBe(400);
      expect((result.body as { ok: boolean }).ok).toBe(false);
    }
    expect(await readPermissionMode(PROJECT)).toBe('auto');
  });

  it('rejects a body without a project, and one carrying fields it does not take', async () => {
    expect((await postPermissionMode({ mode: 'ask' })).status).toBe(400);
    expect((await postPermissionMode({ project: '', mode: 'ask' })).status).toBe(400);
    expect((await postPermissionMode({ project: PROJECT, sandbox: 'danger-full-access' })).status).toBe(400);
    expect((await postPermissionMode(null)).status).toBe(400);
  });

  it('reads rather than clearing when a body names neither field', async () => {
    await writePermissionMode(PROJECT, 'ask');
    expect((await postPermissionMode({ project: PROJECT })).body).toEqual({
      ok: true,
      mode: 'ask',
      skipAcknowledged: false,
    });
  });
});

// ---------------------------------------------------------------------------
// What each mode means to each backend
//
// One table, both halves of it, in one place: the two backends have completely
// different vocabularies and the only thing that keeps them honest is reading
// their answers side by side.
// ---------------------------------------------------------------------------

describe('the mapping', () => {
  const root = path.resolve('/w/game');
  /** A file inside the project, spelled the way this platform spells it. */
  const inside = (rel: string): string => path.join(root, rel);
  /** A file that is definitely not, on any platform. */
  const outside = path.resolve('/etc/hosts');

  it('gives the Agent SDK the permissionMode its binary accepts', () => {
    expect(sdkPermissionMode('ask')).toBe('default');
    expect(sdkPermissionMode('auto')).toBe('acceptEdits');
    expect(sdkPermissionMode('skip')).toBe('bypassPermissions');
  });

  it('gives codex the approval policy and the sandbox together', () => {
    expect(codexPermissionParams('ask')).toEqual({ approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    expect(codexPermissionParams('auto')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(codexPermissionParams('skip')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
  });

  it('never sends codex a read-only sandbox', () => {
    // The live bug this fixes: with no sandbox on the request, codex applies
    // its own default for a folder that is not in its trusted list, which is
    // read-only, and an approved patch then fails to write. Hearth opens game
    // folders the user never registered with codex, so that is the normal case.
    for (const mode of ['ask', 'auto', 'skip'] as const) {
      expect(codexPermissionParams(mode).sandbox).not.toBe('read-only');
    }
  });

  it('asks about everything it classifies in ask mode, inside the folder included', () => {
    expect(sdkApprovalFor('Write', { file_path: inside('src/a.js') }, root, 'ask')).toMatchObject({
      kind: 'file-change',
    });
    expect(sdkApprovalFor('Bash', { command: 'npm test' }, root, 'ask')).toEqual({
      kind: 'command',
      title: 'Run this command?',
      detail: 'npm test',
    });
    // Still asks about the things auto asks about, rather than replacing them.
    expect(sdkApprovalFor('Write', { file_path: outside }, root, 'ask')).toMatchObject({
      kind: 'file-change',
      detail: outside,
    });
  });

  it('keeps today’s rule for auto, which is also what an unspecified mode gets', () => {
    expect(sdkApprovalFor('Write', { file_path: inside('src/a.js') }, root, 'auto')).toBeNull();
    expect(sdkApprovalFor('Bash', { command: 'npm test' }, root, 'auto')).toBeNull();
    expect(sdkApprovalFor('Write', { file_path: outside }, root, 'auto')).toMatchObject({
      kind: 'file-change',
    });
    expect(sdkApprovalFor('Bash', { command: 'sudo reboot' }, root, 'auto')).toMatchObject({ kind: 'command' });
    // The default argument is the same rule, so an omitted mode is never a
    // silent loosening.
    expect(sdkApprovalFor('Write', { file_path: outside }, root)).toEqual(
      sdkApprovalFor('Write', { file_path: outside }, root, DEFAULT_PERMISSION_MODE),
    );
  });

  it('never asks in skip mode, whatever the call is', () => {
    expect(sdkApprovalFor('Write', { file_path: outside }, root, 'skip')).toBeNull();
    expect(sdkApprovalFor('Bash', { command: 'sudo rm -rf /' }, root, 'skip')).toBeNull();
    expect(sdkApprovalFor('Edit', { file_path: inside('a.js') }, root, 'skip')).toBeNull();
  });
});
