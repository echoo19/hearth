/**
 * Decide whether the running game should CAPTURE (preventDefault + route) a
 * keyboard event, given the current focus/DOM state.
 *
 * Why this exists (L-001): the game's window-level keydown listener used to
 * `preventDefault()` every project-mapped code unconditionally, so a project
 * that maps Escape/Enter/Space/arrows/WASD would swallow those keys even while
 * the editor owns them — a modal `<dialog>` couldn't close on Escape, toolbar
 * buttons couldn't activate on Enter/Space, and editor fields couldn't receive
 * typed keys. This gate keeps game capture scoped to when the game is actually
 * receiving input.
 *
 * The rules, in order:
 *  - Paused game isn't stepping, so it isn't receiving input → never capture.
 *  - A modal `<dialog open>` anywhere owns the keyboard (Escape closes it) →
 *    never capture.
 *  - Ambient focus — nothing focused, or focus on `<body>`/`<html>` — means no
 *    chrome control is claiming the key. This is the EXPORTED-PLAYER case (the
 *    page is just the canvas, focus rests on body) and must keep FULL capture,
 *    so the guard never regresses exports.
 *  - Otherwise a specific element has focus: capture only when it lives inside
 *    the game view root (`captureRoot`). Focus in editor chrome (a field, a
 *    button, another panel) sits outside the root → don't capture.
 *  - No `captureRoot` configured → unrestricted capture (defensive default;
 *    an export can omit it and still behave as before).
 */
export function shouldCaptureGameKey(params: {
  paused: boolean;
  dialogOpen: boolean;
  activeElement: Element | null;
  captureRoot: Element | null;
}): boolean {
  const { paused, dialogOpen, activeElement, captureRoot } = params;
  if (paused) return false;
  if (dialogOpen) return false;
  if (isAmbientFocus(activeElement)) return true;
  if (!captureRoot) return true;
  return captureRoot.contains(activeElement);
}

/** Nothing is really focused: no element, or the document body/root element. */
function isAmbientFocus(active: Element | null): boolean {
  if (!active) return true;
  const tag = active.tagName;
  return tag === 'BODY' || tag === 'HTML';
}
