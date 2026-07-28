/**
 * Binding side of `shortcuts.ts`, kept separate so the matching rules stay a
 * plain module that tests can exercise without a DOM or a React tree.
 *
 * Listens on the window during the capture phase so a shortcut still works
 * while focus sits inside the composer or a dialog, and calls
 * `preventDefault` only when something actually matched. Swallowing keystrokes
 * the app has no use for is how a desktop app breaks the browser primitives
 * people expect to still work.
 */
import { useEffect, useRef } from 'react';
import { isTypingTarget, matchesShortcut, type Shortcut } from './shortcuts';

export function useShortcut(shortcut: Shortcut, handler: () => void, enabled = true): void {
  // The handler is read through a ref so a caller passing an inline arrow does
  // not tear down and rebind the listener on every single render.
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (!matchesShortcut(event, shortcut)) return;
      // A bare key while typing is a character, not a command. A shortcut
      // carrying the mod key is never a character, so it fires anywhere.
      if (!shortcut.mod && isTypingTarget(event.target)) return;
      event.preventDefault();
      latest.current();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcut.key, shortcut.mod, shortcut.shift, shortcut.alt, enabled]);
}
