/**
 * Copy some text, and say so for a moment.
 *
 * The feedback is the point. A copy button that looks identical before and
 * after leaves people pressing it twice to be sure, so this hook owns a short
 * "Copied" state and every copy affordance in the app reads from it rather
 * than inventing its own timing.
 *
 * `navigator.clipboard` needs a secure context. That holds for the dev server
 * on localhost and for the packaged app, but the fallback stays because the
 * failure mode without it is a button that silently does nothing, and there is
 * no way for someone to tell that from a clipboard that did not change.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const CONFIRM_MS = 1400;

export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback((text: string) => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
    });
  }, []);

  return { copied, copy };
}

/** Returns whether the text actually made it to the clipboard. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through: a rejected write means no permission or no secure context,
    // and the older path below may still work.
  }
  return legacyCopy(text);
}

/**
 * The pre-async-clipboard route: put the text in an offscreen textarea, select
 * it, and let the document copy the selection. Deprecated, still implemented
 * everywhere, and the only option left when the modern API is unavailable.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  // Offscreen rather than hidden: a field that is not rendered cannot be
  // selected, and the copy would quietly do nothing.
  field.style.position = 'fixed';
  field.style.top = '-1000px';
  field.style.opacity = '0';
  document.body.appendChild(field);
  try {
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
