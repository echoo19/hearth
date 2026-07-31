/**
 * Files the user drops into the composer.
 *
 * A current client streams an attachment to HTTP first and puts only an
 * opaque, project-scoped token on the `chat-send` frame. Older clients may
 * still send base64 here. Either form is written into the conversation's own
 * folder before it is handed to whichever agent
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
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';

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

/**
 * Ceiling on ONE message's attachments, decoded and added up.
 *
 * Not a second guess at the per-file cap: eight files at the per-file limit is
 * ~128 MB of base64 in a single socket frame, which is over ws's own default
 * and would drop the connection — the user losing both the message and the
 * socket, with nothing to tell them an attachment caused it. This keeps a
 * legitimate maximal message comfortably deliverable.
 */
export const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;

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

/** One already-streamed attachment as named on a current `chat-send` frame. */
export interface StagedAttachmentInput {
  uploadToken: string;
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
  const base = typeof raw === 'string' ? (raw.split(/[\\/]/).pop() ?? '') : '';
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
  let total = 0;
  for (const row of raw) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (!row || typeof row !== 'object') continue;
    const { name, mimeType, data } = row as Record<string, unknown>;
    if (typeof data !== 'string' || data === '') continue;
    const bytes = base64Bytes(data);
    if (bytes > MAX_ATTACHMENT_BYTES) continue;
    if (total + bytes > MAX_MESSAGE_BYTES) break;
    total += bytes;
    out.push({
      name: safeAttachmentName(name),
      mimeType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'application/octet-stream',
      data,
    });
  }
  return out;
}

/** Accept tokens only. Their metadata and project ownership live server-side. */
export function parseStagedAttachmentInputs(raw: unknown): StagedAttachmentInput[] {
  if (!Array.isArray(raw)) return [];
  const out: StagedAttachmentInput[] = [];
  for (const row of raw) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (!row || typeof row !== 'object') continue;
    const token = (row as Record<string, unknown>).uploadToken;
    if (typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token)) out.push({ uploadToken: token });
  }
  return out;
}

/** The transcript's view of a saved attachment. */
export function storedAttachment(attachment: ChatAttachment): StoredAttachment {
  return {
    name: attachment.name,
    mimeType: attachment.mimeType,
    relPath: attachment.relPath,
  };
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

interface StagedUpload {
  root: string;
  path: string;
  name: string;
  mimeType: string;
  bytes: number;
  createdAt: number;
}

const UPLOADS_DIR = path.join('.hearth', 'chats', '.uploads');
const UPLOAD_TTL_MS = 60 * 60 * 1000;

/**
 * In-memory ownership ledger for streamed uploads.
 *
 * A token is useful only in the server process that minted it, and only for
 * the exact open project it was uploaded to. The filesystem path never comes
 * from the client. Uploading writes `*.part`, then renames it into place;
 * consuming similarly renames into the chat's permanent directory.
 */
export class ChatAttachmentStager {
  private readonly uploads = new Map<string, StagedUpload>();

  async stage(
    root: string,
    input: Readable,
    metadata: {
      name: unknown;
      mimeType: unknown;
      contentLength?: number | null;
    },
    now = Date.now(),
  ): Promise<{
    uploadToken: string;
    name: string;
    mimeType: string;
    bytes: number;
  }> {
    await this.cleanupExpired(now);
    if (
      metadata.contentLength !== undefined &&
      metadata.contentLength !== null &&
      (!Number.isSafeInteger(metadata.contentLength) ||
        metadata.contentLength <= 0 ||
        metadata.contentLength > MAX_ATTACHMENT_BYTES)
    ) {
      throw new Error('Attachment is empty or too large.');
    }
    const token = randomBytes(24).toString('base64url');
    const dir = path.join(root, UPLOADS_DIR);
    const part = path.join(dir, `${token}.part`);
    const staged = path.join(dir, token);
    const name = safeAttachmentName(metadata.name);
    const mimeType =
      typeof metadata.mimeType === 'string' && metadata.mimeType.trim() !== ''
        ? metadata.mimeType.slice(0, 200)
        : 'application/octet-stream';
    await fsp.mkdir(dir, { recursive: true });
    const handle = await fsp.open(part, 'wx');
    let bytes = 0;
    try {
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > MAX_ATTACHMENT_BYTES) throw new Error('Attachment is too large.');
        await handle.write(buffer);
      }
      if (bytes === 0) throw new Error('Attachment is empty.');
      await handle.close();
      await fsp.rename(part, staged);
      this.uploads.set(token, {
        root: path.resolve(root),
        path: staged,
        name,
        mimeType,
        bytes,
        createdAt: now,
      });
      return { uploadToken: token, name, mimeType, bytes };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fsp.rm(part, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async consume(
    root: string,
    chatId: string,
    inputs: readonly StagedAttachmentInput[],
    now = Date.now(),
  ): Promise<ChatAttachment[]> {
    await this.cleanupExpired(now);
    const resolvedRoot = path.resolve(root);
    const dir = path.join(resolvedRoot, ATTACHMENTS_DIR, chatId);
    const selected: Array<[string, StagedUpload]> = [];
    const seen = new Set<string>();
    let total = 0;
    for (const input of inputs.slice(0, MAX_ATTACHMENTS)) {
      if (seen.has(input.uploadToken)) continue;
      seen.add(input.uploadToken);
      const upload = this.uploads.get(input.uploadToken);
      if (!upload || upload.root !== resolvedRoot || total + upload.bytes > MAX_MESSAGE_BYTES) continue;
      total += upload.bytes;
      selected.push([input.uploadToken, upload]);
    }
    if (selected.length === 0) return [];
    await fsp.mkdir(dir, { recursive: true });
    const consumed: ChatAttachment[] = [];
    for (const [index, [token, upload]] of selected.entries()) {
      const fileName = attachmentFileName(now, index, upload.name);
      const abs = path.join(dir, fileName);
      try {
        await fsp.rename(upload.path, abs);
        this.uploads.delete(token);
        consumed.push({
          name: upload.name,
          mimeType: upload.mimeType,
          path: abs,
          relPath: path.posix.join(ATTACHMENTS_DIR.split(path.sep).join('/'), chatId, fileName),
          bytes: upload.bytes,
        });
      } catch {
        // Keep the ledger row: a transient destination failure may be retried.
      }
    }
    return consumed;
  }

  async discardProject(root: string): Promise<void> {
    const resolvedRoot = path.resolve(root);
    const removals: Promise<void>[] = [];
    for (const [token, upload] of this.uploads) {
      if (upload.root !== resolvedRoot) continue;
      this.uploads.delete(token);
      removals.push(fsp.rm(upload.path, { force: true }));
    }
    await Promise.allSettled(removals);
    await fsp
      .rm(path.join(resolvedRoot, UPLOADS_DIR), {
        recursive: true,
        force: true,
      })
      .catch(() => undefined);
  }

  async cleanupExpired(now = Date.now()): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const [token, upload] of this.uploads) {
      if (now - upload.createdAt < UPLOAD_TTL_MS) continue;
      this.uploads.delete(token);
      removals.push(fsp.rm(upload.path, { force: true }));
    }
    await Promise.allSettled(removals);
  }
}
