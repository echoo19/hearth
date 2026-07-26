/**
 * Files the user drops into the composer.
 *
 * An attachment arrives base64-encoded on the `chat-send` frame, is written
 * into the conversation's own folder, and is then handed to whichever agent
 * answers — as a real path, never as a copy in the prompt:
 *
 *   .hearth/chats/attachments/<chatId>/<n>-<name>
 *
 * Writing it down first is what makes the rest work. The transcript can show
 * the image again after a restart (it is a file the project owns, served by
 * `GET /api/file`), codex can be pointed at it with `localImage`/`mention`
 * instead of shipping bytes through JSON-RPC, and an agent that wants to
 * actually open a non-image attachment has a path its own tools can read.
 *
 * Everything here is deliberately strict: a client can say anything, and this
 * module is the only thing between "anything" and the user's disk. Names are
 * flattened to a single safe segment, the count and per-file size are capped,
 * and a payload that doesn't decode is dropped rather than half-written.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Where a conversation's attachments live, relative to the project root.
 * Spelled out rather than derived from chatStore's `CHATS_DIR` because that
 * module reads this one — a test keeps the two from drifting apart.
 */
export const ATTACHMENTS_DIR = path.join('.hearth', 'chats', 'attachments');

/** Per-message ceiling. A composer tray, not an upload manager. */
export const MAX_ATTACHMENTS = 8;

/**
 * Per-file ceiling, on the DECODED bytes. The renderer already downscales
 * images before sending; this is the backstop for everything else.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/** How long a stored filename may get before it is truncated (extension kept). */
const MAX_NAME_LENGTH = 60;

/**
 * Image types both backends accept inline. Anything outside this set is still
 * attachable — it just travels as a path the agent can read, rather than as
 * pixels in the model's context.
 */
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isInlineImage(mimeType: string): boolean {
  return INLINE_IMAGE_TYPES.has(mimeType.toLowerCase());
}

/** One attachment as it arrives from the composer. */
export interface AttachmentInput {
  name: string;
  mimeType: string;
  /** base64, without a data: prefix. */
  data: string;
}

/** One attachment after it has been written down. */
export interface ChatAttachment {
  name: string;
  mimeType: string;
  /** Absolute path — what a driver hands to its agent. */
  path: string;
  /** Project-relative, posix separators — what the transcript stores. */
  relPath: string;
  bytes: number;
}

/** What a transcript line keeps: enough to show it again, and nothing else. */
export interface StoredAttachment {
  name: string;
  mimeType: string;
  relPath: string;
}

/**
 * Reduce a client-supplied filename to one harmless path segment. Directory
 * separators, leading dots and control characters all go; what survives is a
 * name, and a name that would be empty becomes `file`.
 */
export function safeAttachmentName(raw: unknown): string {
  const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() ?? '' : '';
  const cleaned = base
    // Control characters and the set Windows refuses, so a name that came
    // from one machine is still a name on another.
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned === '') return 'file';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  // Keep the extension when there is a plausible one: the extension is what
  // decides how the file opens, and it is the part a truncation must not eat.
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/**
 * The on-disk name for one attachment of one message. The index prefix keeps
 * two files called `screenshot.png` in the same conversation apart, and the
 * timestamp keeps two messages apart — sorted by name is sorted by time.
 */
export function attachmentFileName(stamp: number, index: number, name: string): string {
  return `${stamp.toString(36)}-${index}-${safeAttachmentName(name)}`;
}

/** Decoded size of a base64 payload, without allocating it. */
export function base64Bytes(data: string): number {
  const clean = data.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

/**
 * Coerce whatever arrived on the wire into attachments worth writing. Rows
 * that are the wrong shape, empty, or over the size cap are dropped
 * individually — one bad file must not lose the message it came with.
 */
export function parseAttachmentInputs(raw: unknown): AttachmentInput[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentInput[] = [];
  for (const row of raw) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (!row || typeof row !== 'object') continue;
    const { name, mimeType, data } = row as Record<string, unknown>;
    if (typeof data !== 'string' || data === '') continue;
    if (base64Bytes(data) > MAX_ATTACHMENT_BYTES) continue;
    out.push({
      name: safeAttachmentName(name),
      mimeType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'application/octet-stream',
      data,
    });
  }
  return out;
}

/** The transcript's view of a saved attachment. */
export function storedAttachment(attachment: ChatAttachment): StoredAttachment {
  return { name: attachment.name, mimeType: attachment.mimeType, relPath: attachment.relPath };
}

/** Read a transcript's attachment list back, dropping rows that lost a field. */
export function parseStoredAttachments(raw: unknown): StoredAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredAttachment[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const { name, mimeType, relPath } = row as Record<string, unknown>;
    if (typeof relPath !== 'string' || relPath === '') continue;
    out.push({
      name: typeof name === 'string' && name !== '' ? name : 'file',
      mimeType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'application/octet-stream',
      relPath,
    });
  }
  return out;
}

/**
 * Write one message's attachments into its conversation's folder. Returns the
 * ones that made it; a file that fails to write is skipped rather than
 * failing the send, because the words are the part the user cannot retype.
 */
export async function saveAttachments(
  root: string,
  chatId: string,
  inputs: readonly AttachmentInput[],
  now: number = Date.now(),
): Promise<ChatAttachment[]> {
  if (inputs.length === 0) return [];
  const dir = path.join(root, ATTACHMENTS_DIR, chatId);
  await fsp.mkdir(dir, { recursive: true });
  const saved: ChatAttachment[] = [];
  for (const [index, input] of inputs.entries()) {
    const fileName = attachmentFileName(now, index, input.name);
    const abs = path.join(dir, fileName);
    try {
      const bytes = Buffer.from(input.data, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;
      await fsp.writeFile(abs, bytes);
      saved.push({
        name: input.name,
        mimeType: input.mimeType,
        path: abs,
        relPath: path.posix.join(ATTACHMENTS_DIR.split(path.sep).join('/'), chatId, fileName),
        bytes: bytes.length,
      });
    } catch {
      /* one unwritable file must not cost the message */
    }
  }
  return saved;
}
