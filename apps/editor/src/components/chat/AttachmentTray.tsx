/**
 * What is attached to the message being written, and what was attached to one
 * already sent.
 *
 * The same two shapes serve both: a picture shows as a picture, and anything
 * else shows as a chip with its name — because a filename is the only thing
 * you can honestly show about a zip. In the composer the thumbnails carry a
 * remove button; in the transcript they don't, because a sent message is a
 * record.
 */
import React from 'react';
import type { ChatAttachmentView } from '../../types';
import { formatBytes, isInlineImage, type PendingAttachment } from '../../chat/attachments';
import { Icon } from '../ui';

/** A small page-with-corner mark, for an attachment that isn't a picture. */
function FileMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M3.5 1.75h4.25L10.5 4.5v7.75h-7z" strokeLinejoin="round" />
      <path d="M7.75 1.75V4.5h2.75" strokeLinejoin="round" />
    </svg>
  );
}

/** The composer's tray: still removable, not yet sent. */
export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: readonly PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className="attach-tray" aria-label="Attached files">
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className={attachment.previewUrl ? 'attach-item is-image' : 'attach-item'}
          title={`${attachment.name} · ${formatBytes(attachment.bytes)}`}
        >
          {attachment.previewUrl ? (
            <img className="attach-thumb" src={attachment.previewUrl} alt={attachment.name} />
          ) : (
            <span className="attach-file">
              <FileMark />
              <span className="attach-name">{attachment.name}</span>
            </span>
          )}
          <button
            type="button"
            className="attach-remove"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove(attachment.id)}
          >
            <Icon name="cross" size={8} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The transcript's version: the same objects, with nothing to press. */
export function SentAttachments({ attachments }: { attachments: readonly ChatAttachmentView[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="attach-tray is-sent" aria-label="Attached files">
      {attachments.map((attachment, index) => (
        <li
          key={`${attachment.name}-${index}`}
          className={isInlineImage(attachment.mimeType) ? 'attach-item is-image' : 'attach-item'}
          title={attachment.name}
        >
          {isInlineImage(attachment.mimeType) ? (
            <img className="attach-thumb" src={attachment.url} alt={attachment.name} loading="lazy" />
          ) : (
            <span className="attach-file">
              <FileMark />
              <span className="attach-name">{attachment.name}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
