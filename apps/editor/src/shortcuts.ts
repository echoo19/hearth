/**
 * Keyboard shortcuts, and the one place that knows which modifier key this
 * computer uses.
 *
 * Hearth ships to macOS and to Windows, and the two disagree about the primary
 * modifier: Command on a Mac, Control everywhere else. Every shortcut in the
 * app is declared here as "mod" and resolved per machine, so no component ever
 * hardcodes one platform's key and quietly does nothing on the other.
 *
 * The label matters as much as the binding. A Windows user reading "⌘K" learns
 * nothing, so `shortcutLabel` renders the same declaration as "⌘K" or "Ctrl K"
 * depending on where it is being read.
 */

/**
 * Whether this is a Mac.
 *
 * `navigator.userAgentData` is the supported way to ask and is what Chromium
 * answers first; `navigator.platform` is deprecated but still populated, and is
 * the fallback for the older runtime. The user agent string is the last resort.
 * Anything unrecognised is treated as not-a-Mac, which is the safer default:
 * Control is the modifier on Windows and Linux both.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  if (data?.platform) return data.platform.toLowerCase().startsWith('mac');
  if (navigator.platform) return navigator.platform.toLowerCase().startsWith('mac');
  return /mac/i.test(navigator.userAgent ?? '');
}

/** One shortcut, written once, resolved per platform. */
export interface Shortcut {
  /** The physical key, compared case-insensitively against `event.key`. */
  key: string;
  /** Command on a Mac, Control on Windows and Linux. */
  mod?: boolean;
  shift?: boolean;
  /** Literal Alt/Option. Rare, and never the only modifier on a destructive action. */
  alt?: boolean;
}

/**
 * Does this keystroke match the declaration?
 *
 * The mod check is deliberately exclusive: on a Mac a shortcut declared with
 * `mod` requires Command and rejects Control, so Ctrl+K stays available to the
 * terminal, where it means something else entirely.
 */
export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut, mac = isMac()): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  const wantMod = shortcut.mod === true;
  const gotMod = mac ? event.metaKey : event.ctrlKey;
  const otherMod = mac ? event.ctrlKey : event.metaKey;
  if (gotMod !== wantMod || otherMod) return false;
  if ((shortcut.shift === true) !== event.shiftKey) return false;
  if ((shortcut.alt === true) !== event.altKey) return false;
  return true;
}

/**
 * How this shortcut should be written on this machine.
 *
 * Mac convention packs the symbols together with no separator, because the
 * glyphs already read as keys. Windows spells them out and needs the gap.
 */
export function shortcutLabel(shortcut: Shortcut, mac = isMac()): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  const parts: string[] = [];
  if (shortcut.mod) parts.push(mac ? '⌘' : 'Ctrl');
  if (shortcut.alt) parts.push(mac ? '⌥' : 'Alt');
  if (shortcut.shift) parts.push(mac ? '⇧' : 'Shift');
  parts.push(key);
  return mac ? parts.join('') : parts.join('+');
}

/**
 * Is the person typing right now?
 *
 * A global shortcut must never eat a character someone is putting into a
 * message. Text fields and anything contenteditable are off limits, with one
 * exception: a shortcut that carries the mod key is not a character, so it
 * still fires. That is what lets the search shortcut work from inside the
 * composer, which is exactly where someone is most likely to press it.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The shortcuts the app actually binds, named so they can be listed.
 *
 * The last three are not new. The application menu has been printing them next
 * to Open, Settings and Files since it was written, on the stated assumption
 * that the renderer bound the keys; nothing did, so all three were promises the
 * app did not keep. They are declared here to match what the menu already says,
 * which is why the accelerators there are still display-only.
 */
export const SHORTCUTS = {
  search: { key: 'k', mod: true } as Shortcut,
  newChat: { key: 'n', mod: true } as Shortcut,
  settings: { key: ',', mod: true } as Shortcut,
  openFolder: { key: 'o', mod: true } as Shortcut,
  files: { key: 'p', mod: true } as Shortcut,
} as const;
