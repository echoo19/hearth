/**
 * A published address: readable, copyable, and openable.
 *
 * All three, because a URL on screen that you cannot get out of the screen is
 * a URL you retype by hand from a modal — and this one is the whole point of
 * the flow that produced it. The address itself is selectable text (mono, so
 * a hyphen and an underscore are different shapes), Copy puts it on the
 * clipboard, and Open is a real link.
 *
 * The copied confirmation is a state on the button rather than a toast: the
 * question "did that work" is asked about the button, and answering it a
 * hundred pixels away in a corner is answering somewhere the eye isn't.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui';

/** How long the button stays on "Copied" before returning to rest. */
const COPIED_MS = 1600;

export function CopyableUrl({ url, label }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  async function copy(): Promise<void> {
    try {
      // Not present on every surface this could run on (a non-secure origin,
      // or a test DOM), and a missing clipboard must not take the dialog down
      // with it — the address is still on screen and still selectable.
      await navigator.clipboard?.writeText(url);
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Deliberately quiet. The failure mode is "the button did nothing",
      // with the URL still selectable beside it, which is recoverable without
      // being told about a clipboard permission.
      setCopied(false);
    }
  }

  return (
    <div className="publish-url">
      {label !== undefined && <span className="publish-url-label">{label}</span>}
      <a className="publish-url-text" href={url} target="_blank" rel="noreferrer noopener">
        {url}
      </a>
      <div className="publish-url-actions">
        <button type="button" className="btn btn-sm" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer noopener">
          Open
        </a>
      </div>
      {/* Announced, not just shown. The icon swap is invisible to a screen
          reader, and "did the copy work" is exactly the kind of thing that
          should not depend on seeing a tick. */}
      <span className="publish-sr" role="status">
        {copied ? 'Address copied to the clipboard' : ''}
      </span>
    </div>
  );
}
