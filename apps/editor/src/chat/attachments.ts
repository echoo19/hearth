/**
 * What the composer does with a file before it becomes part of a message.
 *
 * Three ways in — the picker behind the +, a paste, a drop on the card — and
 * all three land here, because they are the same act. A file is read into
 * memory, images are shrunk to something a model can actually use, and the
 * result sits in the tray until the message is sent.
 *
 * The decisions are pure functions and the I/O is a thin shell around them, so
 * the rules (what is too big, how many is too many, what an image is scaled
 * to) are testable without a DOM, a canvas, or a file.
 */

/** Matches MAX_ATTACHMENTS in server/chatAttachments.ts. */
export const MAX_ATTACHMENTS = 8;

/**
 * The largest file the composer will take, before downscaling. Images almost
 * always come in under the wire limit after `downscaleImage`; this is what
 * stops someone dropping a 300 MB capture into a chat box.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/**
 * Longest edge an image is scaled down to. Both model APIs downscale larger
 * images on their side anyway, so shrinking first costs nothing in fidelity
 * and saves the upload, the disk, and the context window.
 */
export const MAX_IMAGE_EDGE = 1568;

/** Image types that go to the model as pixels. Mirrors the server's set. */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export function isInlineImage(mimeType: string): boolean {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

/** One file waiting in the composer's tray. */
export interface PendingAttachment {
  /** Local identity, for the tray's keys and its remove button. */
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  /** base64 payload, sent on the wire. */
  data: string;
  /** Object URL for the thumbnail, or null for a file with no picture. */
  previewUrl: string | null;
}

/** What the composer sends: the payload, without the local-only fields. */
export interface AttachmentPayload {
  name: string;
  mimeType: string;
  data: string;
}

export function attachmentPayload(attachment: PendingAttachment): AttachmentPayload {
  return { name: attachment.name, mimeType: attachment.mimeType, data: attachment.data };
}

/**
 * Why this file can't be added, or null when it can. One sentence, in the
 * words someone would use about their own file — this is shown, not logged.
 */
export function attachmentRejection(
  file: { name: string; size: number },
  existingCount: number,
): string | null {
  if (existingCount >= MAX_ATTACHMENTS) return `You can attach up to ${MAX_ATTACHMENTS} files at a time.`;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name} is larger than ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

/**
 * The size an image is drawn at. Anything already inside the box is left
 * exactly alone — re-encoding a small screenshot only loses detail.
 */
export function targetDimensions(
  width: number,
  height: number,
  maxEdge = MAX_IMAGE_EDGE,
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return null;
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A short human size, for the tray's file chips. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip the `data:…;base64,` prefix a FileReader result carries. */
export function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

let attachmentId = 0;

/**
 * Shrink an image that is bigger than the model will use anyway. Returns the
 * original blob when it is already small enough, when the format isn't one we
 * re-encode (an animated GIF must not become one frame), or when the browser
 * can't do it — every failure here falls back to sending what we were given.
 */
export async function downscaleImage(file: Blob, type: string): Promise<Blob> {
  if (type !== 'image/png' && type !== 'image/jpeg' && type !== 'image/webp') return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const target = targetDimensions(bitmap.width, bitmap.height);
    if (!target) {
      bitmap.close?.();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close?.();
      return file;
    }
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
    // A downscale that somehow got bigger is not a downscale.
    return blob && blob.size > 0 && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/** Read a blob as base64, without the data-URL prefix. */
function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read the file'));
    reader.onload = () => resolve(base64FromDataUrl(String(reader.result ?? '')));
    reader.readAsDataURL(blob);
  });
}

/**
 * Turn one picked/pasted/dropped file into a tray entry. Images are shrunk
 * first and get a preview URL; everything else keeps its bytes and shows as a
 * chip. The caller owns revoking `previewUrl` — see `releaseAttachments`.
 */
export async function readAttachment(file: File): Promise<PendingAttachment> {
  const mimeType = file.type !== '' ? file.type : 'application/octet-stream';
  const image = isInlineImage(mimeType);
  const blob = image ? await downscaleImage(file, mimeType) : file;
  const data = await readBase64(blob);
  return {
    id: `f${++attachmentId}`,
    name: file.name !== '' ? file.name : 'pasted-image',
    mimeType,
    bytes: blob.size,
    data,
    previewUrl: image && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : null,
  };
}

/** Let go of the object URLs a tray was holding. */
export function releaseAttachments(attachments: readonly PendingAttachment[]): void {
  if (typeof URL === 'undefined' || !URL.revokeObjectURL) return;
  for (const attachment of attachments) {
    if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
  }
}

/**
 * The files carried by a drop or a paste. A paste of copied TEXT also carries
 * `items`, so only real files count — otherwise pasting a paragraph would
 * silently attach something.
 */
export function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  if (out.length === 0) out.push(...Array.from(data.files ?? []));
  return out;
}
