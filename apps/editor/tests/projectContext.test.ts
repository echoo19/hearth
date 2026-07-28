/**
 * The project's background reading, on disk.
 *
 * Two kinds of rule are pinned here. The first is what a user would notice
 * breaking: a project with no context folder yet opens to an empty pane rather
 * than an error, dropping two files with the same name leaves two files, and a
 * card never claims a line count for a PNG.
 *
 * The second is the part that has to hold even when the client is hostile.
 * `.hearth/context/` is a plain committed folder, and this module is the only
 * thing between a name someone typed and the user's disk — so traversal,
 * absolute paths, Windows separators and lookalike unicode separators all have
 * to end up as one harmless segment inside the folder, and a delete aimed
 * outside it has to miss.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_DIR,
  MAX_CONTEXT_FILE_BYTES,
  MAX_LINE_COUNT_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  contextDir,
  countLines,
  deleteContextFile,
  listContextFiles,
  parseContextInputs,
  readContextFile,
  saveContextFiles,
} from '../server/projectContext';

/** A one-pixel PNG: real binary bytes, NULs and all. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-context-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const dir = (): string => path.resolve(contextDir(root));

describe('where it lives', () => {
  it('is a per-project folder under .hearth, next to the other committable things', () => {
    expect(CONTEXT_DIR).toBe(path.join('.hearth', 'context'));
    expect(contextDir('/somewhere/game')).toBe(path.join('/somewhere/game', '.hearth', 'context'));
  });
});

describe('reading a folder that may not exist', () => {
  it('says empty for a project that has never been given context', async () => {
    expect(await listContextFiles(root)).toEqual([]);
  });

  it('says empty rather than throwing when the project itself is gone', async () => {
    expect(await listContextFiles(path.join(root, 'no-such-project'))).toEqual([]);
  });

  it('lists newest first, and skips folders and dotfiles', async () => {
    await fsp.mkdir(path.join(dir(), 'sub'), { recursive: true });
    await fsp.writeFile(path.join(dir(), 'old.md'), 'first\n');
    await fsp.writeFile(path.join(dir(), '.DS_Store'), 'noise');
    await fsp.writeFile(path.join(dir(), 'new.md'), 'second\n');
    // Written in the same millisecond on a fast disk, so state the order.
    await fsp.utimes(path.join(dir(), 'old.md'), new Date(1000), new Date(1000));
    await fsp.utimes(path.join(dir(), 'new.md'), new Date(9000), new Date(9000));
    expect((await listContextFiles(root)).map((f) => f.name)).toEqual(['new.md', 'old.md']);
  });

  it('reports the extension and a real timestamp for each card', async () => {
    await saveContextFiles(root, [{ name: 'design.MD', data: b64('# hi\n') }]);
    const [file] = await listContextFiles(root);
    expect(file.ext).toBe('md');
    expect(Number.isNaN(Date.parse(file.modifiedAt))).toBe(false);
    expect(file.bytes).toBe(5);
  });
});

describe('line counts', () => {
  it('counts the last line even when the file does not end in a newline', () => {
    expect(countLines(Buffer.from('a\nb\nc'))).toBe(3);
    expect(countLines(Buffer.from('a\nb\nc\n'))).toBe(3);
    expect(countLines(Buffer.from(''))).toBe(0);
  });

  it('is null for binary, because a card must not claim a PNG has lines', async () => {
    await saveContextFiles(root, [
      { name: 'shot.png', data: PNG_BASE64 },
      { name: 'notes.md', data: b64('one\ntwo\nthree\n') },
    ]);
    const files = await listContextFiles(root);
    expect(files.find((f) => f.name === 'shot.png')?.lines).toBeNull();
    expect(files.find((f) => f.name === 'notes.md')?.lines).toBe(3);
  });

  it('does not read a huge body just to put a number on a card', async () => {
    await fsp.mkdir(dir(), { recursive: true });
    const big = path.join(dir(), 'huge.log');
    await fsp.writeFile(big, 'x\n');
    await fsp.truncate(big, MAX_LINE_COUNT_BYTES + 1);
    const [file] = await listContextFiles(root);
    expect(file.bytes).toBe(MAX_LINE_COUNT_BYTES + 1);
    expect(file.lines).toBeNull();
  });
});

describe('what arrives on the wire', () => {
  it('drops rows that are the wrong shape without losing the good ones', () => {
    const parsed = parseContextInputs([
      null,
      'nonsense',
      { name: 'a.md', data: b64('a') },
      { name: 'empty.md' },
      { name: 'b.txt', data: b64('b') },
    ]);
    expect(parsed.map((f) => f.name)).toEqual(['a.md', 'b.txt']);
  });

  it('is not fooled by a non-array', () => {
    expect(parseContextInputs({ name: 'a.md', data: b64('a') })).toEqual([]);
    expect(parseContextInputs(undefined)).toEqual([]);
  });

  it('refuses an oversized payload without decoding it', () => {
    const huge = 'A'.repeat(MAX_CONTEXT_FILE_BYTES * 2);
    expect(parseContextInputs([{ name: 'big.bin', data: huge }])).toEqual([]);
  });

  it('stops at the per-request budget rather than accepting every file', () => {
    // One string, referenced many times: the point is the accounting, not the
    // memory. Each row is just under the per-file cap, so the request cap is
    // what has to stop it.
    const big = 'A'.repeat(Math.ceil((MAX_CONTEXT_FILE_BYTES - 1024) / 3) * 4);
    const parsed = parseContextInputs(Array.from({ length: MAX_UPLOAD_FILES }, (_, i) => ({ name: `f${i}.bin`, data: big })));
    expect(parsed.length).toBeLessThan(MAX_UPLOAD_FILES);
    const total = parsed.reduce((sum, f) => sum + Math.floor((f.data.replace(/=+$/, '').length * 3) / 4), 0);
    expect(total).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
  });

  it('caps how many files one drop can add', () => {
    const many = Array.from({ length: MAX_UPLOAD_FILES + 5 }, (_, i) => ({ name: `f${i}.md`, data: b64('x') }));
    expect(parseContextInputs(many)).toHaveLength(MAX_UPLOAD_FILES);
  });
});

describe('saving', () => {
  it('writes the bytes where the pane will find them', async () => {
    const saved = await saveContextFiles(root, [{ name: 'design.md', data: b64('# Design\n') }]);
    expect(saved.map((f) => f.name)).toEqual(['design.md']);
    expect(await fsp.readFile(path.join(dir(), 'design.md'), 'utf8')).toBe('# Design\n');
  });

  it('keeps two files with the same name apart instead of clobbering the first', async () => {
    await saveContextFiles(root, [
      { name: 'notes.md', data: b64('first\n') },
      { name: 'notes.md', data: b64('second\n') },
    ]);
    const names = (await listContextFiles(root)).map((f) => f.name).sort();
    expect(names).toEqual(['notes-2.md', 'notes.md']);
    expect(await fsp.readFile(path.join(dir(), 'notes.md'), 'utf8')).toBe('first\n');
    expect(await fsp.readFile(path.join(dir(), 'notes-2.md'), 'utf8')).toBe('second\n');
  });

  it('does not clobber a file dropped in an earlier request either', async () => {
    await saveContextFiles(root, [{ name: 'notes.md', data: b64('first\n') }]);
    const [again] = await saveContextFiles(root, [{ name: 'notes.md', data: b64('second\n') }]);
    expect(again.name).toBe('notes-2.md');
    expect(await fsp.readFile(path.join(dir(), 'notes.md'), 'utf8')).toBe('first\n');
  });

  it('cannot be talked into writing outside the context folder', async () => {
    const hostile = [
      '../../escape.md',
      '../../../../../../tmp/escape.md',
      '/etc/passwd',
      'C:\\Windows\\system32\\evil.md',
      '..\\..\\escape.md',
      '..',
      '...',
      // Lookalike separators and a bidi override: not path separators at all,
      // so they may survive as characters — but never as a directory step.
      '..\u2044..\u2044escape.md',
      '..\uff0f..\uff0fescape.md',
      '\u202eevil.md',
    ];
    await saveContextFiles(root, hostile.map((name) => ({ name, data: b64('nope\n') })));
    for (const file of await listContextFiles(root)) {
      const abs = path.resolve(dir(), file.name);
      expect(path.dirname(abs)).toBe(dir());
      expect((await fsp.stat(abs)).isFile()).toBe(true);
    }
    // Nothing leaked into the project root or above the context folder.
    expect(await fsp.readdir(root)).toEqual(['.hearth']);
    expect(await fsp.readdir(path.join(root, '.hearth'))).toEqual(['context']);
  });

  it('skips a payload that decodes to nothing rather than writing an empty file', async () => {
    expect(await saveContextFiles(root, [{ name: 'x.md', data: '====' }])).toEqual([]);
    expect(await listContextFiles(root)).toEqual([]);
  });

  it('makes the folder rather than failing on a fresh project', async () => {
    await saveContextFiles(root, [{ name: 'a.md', data: b64('a\n') }]);
    expect((await fsp.stat(dir())).isDirectory()).toBe(true);
  });

  it('is not a secret store — the folder is left readable, because it is committed', async () => {
    await saveContextFiles(root, [{ name: 'a.md', data: b64('a\n') }]);
    const mode = (await fsp.stat(dir())).mode & 0o777;
    expect(mode & 0o400).toBe(0o400);
    expect(mode).not.toBe(0o600);
  });
});

describe('deleting', () => {
  it('removes a file and says so', async () => {
    await saveContextFiles(root, [{ name: 'a.md', data: b64('a\n') }]);
    expect(await deleteContextFile(root, 'a.md')).toBe(true);
    expect(await listContextFiles(root)).toEqual([]);
  });

  it('says false for a file that was never there, rather than reporting a lie', async () => {
    // `rm --force` would succeed on this path; the pane would then remove a
    // card for a file that still exists somewhere else.
    expect(await deleteContextFile(root, 'ghost.md')).toBe(false);
    await saveContextFiles(root, [{ name: 'a.md', data: b64('a\n') }]);
    expect(await deleteContextFile(root, 'also-ghost.md')).toBe(false);
    expect(await listContextFiles(root)).toHaveLength(1);
  });

  it('cannot be aimed at a file outside the context folder', async () => {
    // A name that walks upwards is flattened to one segment, so the worst it
    // can ever name is a file inside the context folder — here, one that does
    // not exist. The API key file two levels up is not reachable from here.
    const outside = path.join(root, 'app.json');
    await fsp.writeFile(outside, '{"apiKey":"secret"}');
    for (const name of ['../../app.json', '..\\..\\app.json', '/etc/hosts', '../app.json']) {
      expect(await deleteContextFile(root, name)).toBe(false);
    }
    expect(await fsp.readFile(outside, 'utf8')).toBe('{"apiKey":"secret"}');
  });

  it('refuses to delete a directory someone dropped in by hand', async () => {
    await fsp.mkdir(path.join(dir(), 'sub'), { recursive: true });
    expect(await deleteContextFile(root, 'sub')).toBe(false);
  });
});

describe('previewing', () => {
  it('hands back the text of a document', async () => {
    await saveContextFiles(root, [{ name: 'design.md', data: b64('# Design\nlore\n') }]);
    expect(await readContextFile(root, 'design.md')).toBe('# Design\nlore\n');
  });

  it('is null for a file that is not there, a folder, or binary', async () => {
    await fsp.mkdir(path.join(dir(), 'sub'), { recursive: true });
    await saveContextFiles(root, [{ name: 'shot.png', data: PNG_BASE64 }]);
    expect(await readContextFile(root, 'missing.md')).toBeNull();
    expect(await readContextFile(root, 'sub')).toBeNull();
    expect(await readContextFile(root, 'shot.png')).toBeNull();
  });

  it('cannot be used to read a file outside the context folder', async () => {
    await fsp.writeFile(path.join(root, 'app.json'), '{"apiKey":"secret"}');
    expect(await readContextFile(root, '../../app.json')).toBeNull();
    expect(await readContextFile(root, '..\\..\\app.json')).toBeNull();
  });
});
