/**
 * The composer's side of an attachment: what it accepts, what it shrinks, and
 * what it puts on the wire.
 *
 * The decisions are pure functions precisely so they can be pinned without a
 * canvas or a real file — the browser plumbing around them (a picker, a paste,
 * a drop) is exercised in composer.test.tsx.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_EDGE,
  attachmentPayload,
  attachmentRejection,
  base64FromDataUrl,
  filesFromTransfer,
  formatBytes,
  isInlineImage,
  targetDimensions,
  type PendingAttachment,
} from '../src/chat/attachments';
import { makeUserMessage, replayAttachments, useApp } from '../src/store';

describe('what the tray refuses', () => {
  it('says why, in words about the user’s own file', () => {
    expect(attachmentRejection({ name: 'a.png', size: 10 }, MAX_ATTACHMENTS)).toContain(String(MAX_ATTACHMENTS));
    expect(attachmentRejection({ name: 'huge.mov', size: MAX_ATTACHMENT_BYTES + 1 }, 0)).toContain('huge.mov');
    expect(attachmentRejection({ name: 'empty.txt', size: 0 }, 0)).toContain('empty.txt');
  });

  it('accepts an ordinary file', () => {
    expect(attachmentRejection({ name: 'shot.png', size: 40_000 }, 2)).toBeNull();
  });
});

describe('downscaling', () => {
  it('leaves an image that is already small enough completely alone', () => {
    expect(targetDimensions(800, 600)).toBeNull();
    expect(targetDimensions(MAX_IMAGE_EDGE, 400)).toBeNull();
    expect(targetDimensions(0, 0)).toBeNull();
  });

  it('scales the long edge and keeps the proportions', () => {
    const target = targetDimensions(3200, 1600);
    expect(target).toEqual({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE / 2 });
  });

  it('never rounds a thin image away to nothing', () => {
    const target = targetDimensions(10_000, 3);
    expect(target?.height).toBeGreaterThanOrEqual(1);
  });
});

describe('small helpers', () => {
  it('reads the payload out of a FileReader result', () => {
    expect(base64FromDataUrl('data:image/png;base64,AAAB')).toBe('AAAB');
    expect(base64FromDataUrl('AAAB')).toBe('AAAB');
  });

  it('sizes a file the way a person would say it', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('sends only the payload, not the tray’s local bookkeeping', () => {
    const pending: PendingAttachment = {
      id: 'f1',
      name: 'a.png',
      mimeType: 'image/png',
      bytes: 3,
      data: 'AAA',
      previewUrl: 'blob:x',
    };
    expect(attachmentPayload(pending)).toEqual({ name: 'a.png', mimeType: 'image/png', data: 'AAA' });
  });

  it('agrees with the server about which types go inline', () => {
    expect(isInlineImage('image/webp')).toBe(true);
    expect(isInlineImage('text/plain')).toBe(false);
  });
});

describe('a paste or a drop', () => {
  const fileItem = (file: File): DataTransferItem =>
    ({ kind: 'file', getAsFile: () => file }) as unknown as DataTransferItem;
  const stringItem = (): DataTransferItem =>
    ({ kind: 'string', getAsFile: () => null }) as unknown as DataTransferItem;

  it('takes the files and ignores copied text riding along with them', () => {
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const data = { items: [stringItem(), fileItem(file)], files: [] } as unknown as DataTransfer;
    expect(filesFromTransfer(data).map((f) => f.name)).toEqual(['shot.png']);
  });

  it('falls back to `files` for a transfer that exposes no items', () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const data = { items: [], files: [file] } as unknown as DataTransfer;
    expect(filesFromTransfer(data)).toHaveLength(1);
  });

  it('treats a plain text paste as nothing to attach', () => {
    expect(filesFromTransfer({ items: [stringItem()], files: [] } as unknown as DataTransfer)).toEqual([]);
    expect(filesFromTransfer(null)).toEqual([]);
  });
});

describe('the message that results', () => {
  it('has no empty paragraph when it was only a picture', () => {
    const message = makeUserMessage('', [{ name: 'a.png', mimeType: 'image/png', url: 'data:…' }]);
    expect(message.parts).toEqual([]);
    expect(message.attachments).toHaveLength(1);
  });

  it('reads a replayed attachment back out of the project', () => {
    const [view] = replayAttachments(
      [{ name: 'a.png', mimeType: 'image/png', relPath: '.hearth/chats/attachments/c/a.png' }],
      '/Users/me/Hearth/game',
    );
    expect(view.url).toContain('/api/file?project=');
    expect(view.url).toContain(encodeURIComponent('.hearth/chats/attachments/c/a.png'));
  });

  it('shows nothing rather than a broken image when the folder is unknown', () => {
    expect(replayAttachments([{ name: 'a.png', mimeType: 'image/png', relPath: 'x' }], '')).toEqual([]);
  });
});

describe('sending', () => {
  const attachment: PendingAttachment = {
    id: 'f1',
    name: 'shot.png',
    mimeType: 'image/png',
    bytes: 3,
    data: 'AAA',
    previewUrl: 'blob:local',
  };

  beforeEach(() => {
    useApp.setState({ messages: [], chatBusy: false, chatError: null });
  });

  it('puts the files on the frame beside the words', () => {
    const sendFrame = vi.fn((_frame: unknown) => true);
    useApp.setState({ sendFrame });
    useApp.getState().sendChat('look at this', [attachment]);
    const frame = sendFrame.mock.calls[0][0] as { attachments?: unknown[] };
    expect(frame.attachments).toEqual([{ name: 'shot.png', mimeType: 'image/png', data: 'AAA' }]);
  });

  it('sends a picture with no words at all', () => {
    const sendFrame = vi.fn((_frame: unknown) => true);
    useApp.setState({ sendFrame });
    useApp.getState().sendChat('', [attachment]);
    expect(sendFrame).toHaveBeenCalledTimes(1);
    expect(useApp.getState().messages[0].attachments).toHaveLength(1);
  });

  it('still refuses a message that is nothing at all', () => {
    const sendFrame = vi.fn((_frame: unknown) => true);
    useApp.setState({ sendFrame });
    useApp.getState().sendChat('   ', []);
    expect(sendFrame).not.toHaveBeenCalled();
  });

  it('shows the bubble from bytes it already has, not from a blob it will revoke', () => {
    useApp.setState({ sendFrame: vi.fn((_frame: unknown) => true) });
    useApp.getState().sendChat('look', [attachment]);
    expect(useApp.getState().messages[0].attachments?.[0].url).toBe('data:image/png;base64,AAA');
  });
});
