/**
 * Files sent with a message: what reaches the disk, and what reaches the agent.
 *
 * The rules pinned here are the ones a user would notice breaking — a picture
 * they attached is a picture the model actually sees, a message that is only a
 * picture is still a message, and nothing a client sends can write outside the
 * conversation's own folder.
 *
 * The codex shapes are not guesses: `localImage` and `mention` are two of the
 * five `UserInput` variants in codex-cli's own generated schema (see
 * CODEX_TESTED_VERSION), which is what makes this worth testing at the item
 * level rather than through a live child process.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ATTACHMENTS_DIR,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  base64Bytes,
  isInlineImage,
  parseAttachmentInputs,
  parseStoredAttachments,
  safeAttachmentName,
  saveAttachments,
  storedAttachment,
} from '../server/chatAttachments';
import { CHATS_DIR, parseTranscript, userRecordTitle } from '../server/chatStore';
import { sdkUserContent } from '../server/chat';
import { codexInputItems } from '../server/chatDrivers/codexWire';

/** A one-pixel PNG, so the "is this really an image" path has real bytes. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('attachment names', () => {
  it('reduces anything a client sends to one harmless segment', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentName('C:\\Users\\me\\shot.png')).toBe('shot.png');
    expect(safeAttachmentName('.gitconfig')).toBe('gitconfig');
    expect(safeAttachmentName('   ')).toBe('file');
    expect(safeAttachmentName(42)).toBe('file');
  });

  it('keeps the extension when a long name has to be cut', () => {
    const name = safeAttachmentName(`${'a'.repeat(200)}.png`);
    expect(name.endsWith('.png')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(60);
  });
});

describe('parsing what arrived on the wire', () => {
  it('drops rows that are the wrong shape without losing the good ones', () => {
    const parsed = parseAttachmentInputs([
      null,
      { name: 'a.png', mimeType: 'image/png', data: PNG_BASE64 },
      { name: 'no-data.png', mimeType: 'image/png' },
      'nonsense',
      { name: 'b.txt', data: 'aGVsbG8=' },
    ]);
    expect(parsed.map((a) => a.name)).toEqual(['a.png', 'b.txt']);
    // A row with no mime type still has to be storable.
    expect(parsed[1].mimeType).toBe('application/octet-stream');
  });

  it('stops at the per-message ceiling', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 4 }, (_, i) => ({
      name: `f${i}.png`,
      mimeType: 'image/png',
      data: PNG_BASE64,
    }));
    expect(parseAttachmentInputs(many)).toHaveLength(MAX_ATTACHMENTS);
  });

  it('refuses a payload over the size cap without decoding it', () => {
    const huge = 'A'.repeat(MAX_ATTACHMENT_BYTES * 2);
    expect(base64Bytes(huge)).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
    expect(parseAttachmentInputs([{ name: 'big.bin', mimeType: 'application/zip', data: huge }])).toEqual([]);
  });

  it('is not fooled by a non-array', () => {
    expect(parseAttachmentInputs({ name: 'a.png' })).toEqual([]);
    expect(parseAttachmentInputs(undefined)).toEqual([]);
  });
});

describe('saving', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-attach-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('lives under the conversation directory it belongs to', () => {
    expect(ATTACHMENTS_DIR.startsWith(CHATS_DIR)).toBe(true);
  });

  it('writes the bytes and reports a posix path the project can read back', async () => {
    const saved = await saveAttachments(root, 'chat-1', [
      { name: 'shot.png', mimeType: 'image/png', data: PNG_BASE64 },
    ], 1234);
    expect(saved).toHaveLength(1);
    expect(saved[0].relPath).toBe('.hearth/chats/attachments/chat-1/ya-0-shot.png');
    expect(saved[0].relPath.includes('\\')).toBe(false);
    expect(path.resolve(root, saved[0].relPath)).toBe(saved[0].path);
    const bytes = await fsp.readFile(saved[0].path);
    expect(bytes.length).toBe(saved[0].bytes);
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('keeps two files with the same name apart', async () => {
    const saved = await saveAttachments(root, 'chat-1', [
      { name: 'shot.png', mimeType: 'image/png', data: PNG_BASE64 },
      { name: 'shot.png', mimeType: 'image/png', data: PNG_BASE64 },
    ]);
    expect(new Set(saved.map((a) => a.path)).size).toBe(2);
  });

  it('cannot be talked into writing outside the chat folder', async () => {
    const saved = await saveAttachments(root, 'chat-1', [
      { name: safeAttachmentName('../../escape.png'), mimeType: 'image/png', data: PNG_BASE64 },
    ]);
    const dir = path.join(root, ATTACHMENTS_DIR, 'chat-1');
    expect(saved[0].path.startsWith(dir + path.sep)).toBe(true);
  });

  it('skips an empty payload rather than writing a zero-byte file', async () => {
    expect(await saveAttachments(root, 'chat-1', [{ name: 'x.png', mimeType: 'image/png', data: '====' }])).toEqual([]);
  });
});

describe('the transcript', () => {
  it('carries attachments through a write and a read', () => {
    const line = JSON.stringify({
      role: 'user',
      ts: '2026-07-26T00:00:00.000Z',
      text: 'what is wrong with this',
      attachments: [{ name: 'shot.png', mimeType: 'image/png', relPath: '.hearth/chats/attachments/c/shot.png' }],
    });
    const [record] = parseTranscript(line);
    expect(record.role).toBe('user');
    expect(record.role === 'user' && record.attachments?.[0].name).toBe('shot.png');
  });

  it('leaves a plain message without an attachments field', () => {
    const [record] = parseTranscript(JSON.stringify({ role: 'user', ts: 'x', text: 'hi' }));
    expect(record).not.toHaveProperty('attachments');
  });

  it('drops a saved row that lost its path', () => {
    expect(parseStoredAttachments([{ name: 'a.png', mimeType: 'image/png' }])).toEqual([]);
  });

  it('names a conversation after the file when there were no words', () => {
    expect(
      userRecordTitle({ text: '   ', attachments: [{ name: 'level-3.png', mimeType: 'image/png', relPath: 'x' }] }),
    ).toBe('level-3.png');
    expect(userRecordTitle({ text: 'make it snow' })).toBe('make it snow');
  });

  it('stores only what showing it again needs', () => {
    expect(
      storedAttachment({ name: 'a.png', mimeType: 'image/png', path: '/abs/a.png', relPath: 'r/a.png', bytes: 12 }),
    ).toEqual({ name: 'a.png', mimeType: 'image/png', relPath: 'r/a.png' });
  });
});

describe('what codex is handed', () => {
  const image = { name: 'shot.png', mimeType: 'image/png', path: '/p/shot.png', relPath: 'r', bytes: 1 };
  const zip = { name: 'level.zip', mimeType: 'application/zip', path: '/p/level.zip', relPath: 'r', bytes: 1 };

  it('sends an image as a local path, not as bytes', () => {
    expect(codexInputItems('what is this', [image])).toEqual([
      { type: 'localImage', path: '/p/shot.png' },
      { type: 'text', text: 'what is this', text_elements: [] },
    ]);
  });

  it('sends anything else as a mention the agent can open', () => {
    expect(codexInputItems('unpack this', [zip])[0]).toEqual({
      type: 'mention',
      name: 'level.zip',
      path: '/p/level.zip',
    });
  });

  it('omits the text item when the message was only a picture', () => {
    expect(codexInputItems('  ', [image])).toEqual([{ type: 'localImage', path: '/p/shot.png' }]);
  });

  it('still sends a text item when there is nothing attached', () => {
    expect(codexInputItems('hello', [])).toEqual([{ type: 'text', text: 'hello', text_elements: [] }]);
  });
});

describe('what the Agent SDK is handed', () => {
  const image = { name: 'shot.png', mimeType: 'image/png', path: '/p/shot.png', relPath: 'r', bytes: 1 };
  const zip = { name: 'level.zip', mimeType: 'application/zip', path: '/p/level.zip', relPath: 'r', bytes: 1 };
  const read = async (): Promise<Buffer> => Buffer.from('pixels');

  it('inlines an image as a base64 block, so the model can see it', async () => {
    expect(await sdkUserContent('what is this', [image], read)).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('pixels').toString('base64') } },
      { type: 'text', text: 'what is this' },
    ]);
  });

  it('points at anything else instead of trying to inline it', async () => {
    const content = await sdkUserContent('', [zip], read);
    expect(content).toEqual([{ type: 'text', text: 'Attached file: /p/level.zip' }]);
  });

  it('says so when an attached image cannot be read', async () => {
    const content = await sdkUserContent('', [image], async () => {
      throw new Error('gone');
    });
    expect(JSON.stringify(content)).toContain('could not be read');
  });
});

describe('which types go inline', () => {
  it('takes the four both APIs accept, and nothing else', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isInlineImage(type)).toBe(true);
    }
    expect(isInlineImage('IMAGE/PNG')).toBe(true);
    expect(isInlineImage('image/svg+xml')).toBe(false);
    expect(isInlineImage('application/pdf')).toBe(false);
  });
});
