/**
 * Central keyboard-shortcut registry for the editor.
 *
 * One table (`KEYBINDS`) is the single source of truth: it drives both the
 * global dispatcher (`installKeybinds`) AND the cheat-sheet overlay
 * (`ShortcutSheet`, via `groupedKeybinds`). Adding a row here wires up the
 * shortcut and documents it in one place — the no-drift test in
 * apps/editor/tests/keybinds.test.ts asserts the two can never disagree.
 *
 * Display-only rows (Space-pan, Escape, Zoom in/out/fit) have `display: true`
 * and a no-op `run`: the actual behavior lives where it needs local state
 * (SceneView's pan / mode-exit / deselect / view-transform handlers, or a
 * native <dialog>'s own Escape), but the row still documents the key in the
 * cheat sheet. The dispatcher returns early for them so the keypress reaches
 * those handlers untouched.
 */
import type { EditorStore } from './store';

export interface Keybind {
  id: string;
  /**
   * Canonical-ish combo string. `mod` = ⌘ on macOS, Ctrl elsewhere. Tokens:
   * 'mod', 'shift', 'alt' + a key ('z', 'd', 's', 'f', 'enter', 'delete',
   * 'up'/'down'/'left'/'right', 'escape', 'space', '/'). Token order is
   * normalized when matching, so 'shift+mod+z' and 'mod+shift+z' are equal.
   */
  combo: string;
  label: string;
  group: 'General' | 'Scene' | 'Selection';
  /**
   * 'selection' bindings only fire while an entity is selected. 'playing'
   * bindings only fire while the game preview is running (mirrors a
   * toolbar button's own `disabled={!playing}`) — e.g. Pause/Resume must
   * not fire while stopped.
   */
  when?: 'selection' | 'playing' | 'always';
  /** Documentation-only row: shown in the cheat sheet, never dispatched. */
  display?: boolean;
  /**
   * Fires even while a text-entry field (or CodeMirror's contentEditable
   * surface) has focus — the opposite of the isTypingTarget guard's default
   * yield-to-typing behavior. Reserved for global shortcuts that must work
   * "from anywhere" and don't collide with what the focused field's own
   * keymap binds (e.g. 'search-scripts': shift+mod+f, which CM6's built-in
   * searchKeymap never claims — it only binds plain Mod-f). Every other
   * binding still yields to typing, unchanged.
   */
  allowWhileTyping?: boolean;
  run(store: EditorStore): void;
}

/** True on Apple platforms — governs `mod` (⌘ vs Ctrl) and symbol display. */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform);

const noop = (): void => {};

export const KEYBINDS: Keybind[] = [
  // ---- General ----------------------------------------------------------
  { id: 'undo', combo: 'mod+z', label: 'Undo', group: 'General', when: 'always', run: (s) => void s.exec('undo') },
  { id: 'redo', combo: 'shift+mod+z', label: 'Redo', group: 'General', when: 'always', run: (s) => void s.exec('redo') },
  { id: 'redo-y', combo: 'mod+y', label: 'Redo (alternate)', group: 'General', when: 'always', run: (s) => void s.exec('redo') },
  {
    id: 'save',
    combo: 'mod+s',
    label: 'Save (auto-saves everywhere; also saves the open script in the Code panel)',
    group: 'General',
    when: 'always',
    // Intercept the browser's Save dialog; the project autosaves every change.
    // The Code panel's own Mod-s keymap (CodeEditor.tsx, Prec.highest) owns
    // this key while it has focus and does a real save there — see
    // isTypingTarget's contentEditable guard below, which yields to it.
    run: (s) => s.log('info', 'editor', 'Your changes are saved automatically — no need to save.'),
  },
  {
    id: 'checkpoint',
    combo: 'shift+mod+s',
    label: 'Save a checkpoint',
    group: 'General',
    when: 'always',
    run: (s) => void s.checkpoint(),
  },
  {
    id: 'shortcuts',
    combo: 'shift+/',
    label: 'Show keyboard shortcuts',
    group: 'General',
    when: 'always',
    run: (s) => s.toggleShortcutSheet(),
  },
  {
    id: 'search-scripts',
    combo: 'shift+mod+f',
    label: 'Search scripts',
    group: 'General',
    when: 'always',
    // Must work from anywhere, including with a script open and CodeMirror
    // focused — CM6's own searchKeymap only claims plain Mod-f, so this
    // never collides with it. See `allowWhileTyping` on the Keybind type.
    allowWhileTyping: true,
    run: (s) => s.requestCodeSearch(),
  },

  // ---- Scene ------------------------------------------------------------
  { id: 'play', combo: 'mod+enter', label: 'Play / Stop', group: 'Scene', when: 'always', run: (s) => s.togglePlay() },
  {
    id: 'pause',
    combo: 'shift+mod+enter',
    label: 'Pause / Resume',
    group: 'Scene',
    when: 'playing',
    run: (s) => s.setPaused(!s.paused),
  },
  { id: 'focus', combo: 'f', label: 'Focus the selected entity', group: 'Scene', when: 'selection', run: (s) => s.requestFocusSelection() },
  // Display-only: SceneView owns pan + mode-exit + deselect (needs its local
  // mode state); a native <dialog> owns its own Escape. Documented here.
  { id: 'pan', combo: 'space', label: 'Pan the canvas (hold)', group: 'Scene', display: true, run: noop },
  { id: 'escape', combo: 'escape', label: 'Deselect · exit the current mode', group: 'Scene', display: true, run: noop },
  // Display-only: SceneView owns zoom's local view-transform state (like pan
  // above). Bare keys — Mod+=/Mod+-/Mod+0 collide with the browser's own
  // page-zoom shortcuts, which preventDefault() can't reliably suppress
  // across browsers, so this deliberately skips the modifier.
  { id: 'zoom-in', combo: '=', label: 'Zoom in', group: 'Scene', display: true, run: noop },
  { id: 'zoom-out', combo: '-', label: 'Zoom out', group: 'Scene', display: true, run: noop },
  { id: 'zoom-fit', combo: '0', label: 'Zoom to fit the scene', group: 'Scene', display: true, run: noop },

  // ---- Selection --------------------------------------------------------
  { id: 'duplicate', combo: 'mod+d', label: 'Duplicate', group: 'Selection', when: 'selection', run: (s) => void s.duplicateSelection() },
  { id: 'delete', combo: 'delete', label: 'Delete', group: 'Selection', when: 'selection', run: (s) => void s.deleteSelection() },
  { id: 'nudge-up', combo: 'up', label: 'Nudge up (1px)', group: 'Selection', when: 'selection', run: (s) => s.nudgeSelection(0, -1) },
  { id: 'nudge-down', combo: 'down', label: 'Nudge down (1px)', group: 'Selection', when: 'selection', run: (s) => s.nudgeSelection(0, 1) },
  { id: 'nudge-left', combo: 'left', label: 'Nudge left (1px)', group: 'Selection', when: 'selection', run: (s) => s.nudgeSelection(-1, 0) },
  { id: 'nudge-right', combo: 'right', label: 'Nudge right (1px)', group: 'Selection', when: 'selection', run: (s) => s.nudgeSelection(1, 0) },
  { id: 'nudge-up-lg', combo: 'shift+up', label: 'Nudge up (10px)', group: 'Selection', when: 'selection', run: (s) => s.nudgeSelection(0, -10) },
  { id: 'nudge-down-lg', combo: 'shift+down', label: 'Nudge down (10px)', group: 'Selection', when: 'selection', run: (s) => s.nudgeSelection(0, 10) },
  { id: 'nudge-left-lg', combo: 'shift+left', label: 'Nudge left (10px)', group: 'Selection', when: 'selection', run: (s) => s.nudgeSelection(-10, 0) },
  { id: 'nudge-right-lg', combo: 'shift+right', label: 'Nudge right (10px)', group: 'Selection', when: 'selection', run: (s) => s.nudgeSelection(10, 0) },
];

const MOD_ORDER = ['mod', 'shift', 'alt', 'ctrl', 'meta'];

/** Reorder a combo's modifier tokens into a stable order so equal combos compare equal. */
export function canonicalCombo(combo: string): string {
  const toks = combo.toLowerCase().split('+');
  const key = toks[toks.length - 1];
  const mods = toks.slice(0, -1).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, key].join('+');
}

/** A KeyboardEvent-shaped input — kept structural so the pure helpers stay DOM-free (and node-testable). */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function normalizeKey(key: string): string | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'Enter':
      return 'enter';
    case 'Escape':
      return 'escape';
    case 'Delete':
    case 'Backspace':
      return 'delete';
    case ' ':
    case 'Spacebar':
      return 'space';
    case '/':
    case '?':
      return '/';
    case 'Shift':
    case 'Control':
    case 'Alt':
    case 'Meta':
      return null; // a lone modifier is not a shortcut
    default:
      return key.length === 1 ? key.toLowerCase() : null;
  }
}

/** Canonical combo string for a keyboard event, or null if the key can't bind. */
export function eventCombo(e: KeyLike, mac: boolean = isMac): string | null {
  const key = normalizeKey(e.key);
  if (!key) return null;
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(key);
  return canonicalCombo(parts.join('+'));
}

/** The binding for a combo, honoring the selection/playing guards. Undefined if none applies. */
export function resolveBinding(input: {
  combo: string;
  hasSelection: boolean;
  isPlaying?: boolean;
}): Keybind | undefined {
  const c = canonicalCombo(input.combo);
  const bind = KEYBINDS.find((b) => canonicalCombo(b.combo) === c);
  if (!bind) return undefined;
  if (bind.when === 'selection' && !input.hasSelection) return undefined;
  if (bind.when === 'playing' && !input.isPlaying) return undefined;
  return bind;
}

/** Whether an event target is a text-entry field where shortcuts must yield to typing. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

const KEY_LABEL: Record<string, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  enter: 'Enter',
  escape: 'Esc',
  delete: 'Del',
  space: 'Space',
  '/': '/',
  '?': '?',
};

function keyLabel(key: string): string {
  return KEY_LABEL[key] ?? key.toUpperCase();
}

/** Human display for a combo: '⌘Z' on macOS, 'Ctrl+Z' elsewhere. */
export function comboDisplay(combo: string, mac: boolean = isMac): string {
  const toks = canonicalCombo(combo).split('+');
  let key = toks[toks.length - 1];
  const mods = new Set(toks.slice(0, -1));
  // shift+/ is how you type "?" — show the question mark, drop the Shift.
  if (key === '/' && mods.has('shift')) {
    key = '?';
    mods.delete('shift');
  }
  const label = keyLabel(key);
  if (mac) {
    let out = '';
    if (mods.has('ctrl')) out += '⌃';
    if (mods.has('alt')) out += '⌥';
    if (mods.has('shift')) out += '⇧';
    if (mods.has('mod')) out += '⌘';
    return out + label;
  }
  const seq: string[] = [];
  if (mods.has('mod')) seq.push('Ctrl');
  if (mods.has('ctrl')) seq.push('Ctrl');
  if (mods.has('alt')) seq.push('Alt');
  if (mods.has('shift')) seq.push('Shift');
  seq.push(label);
  return seq.join('+');
}

export type KeybindGroup = { group: Keybind['group']; binds: Keybind[] };

/** KEYBINDS split into ordered groups — the cheat sheet's sole data source. */
export function groupedKeybinds(): KeybindGroup[] {
  const order: Keybind['group'][] = ['General', 'Scene', 'Selection'];
  return order.map((group) => ({ group, binds: KEYBINDS.filter((b) => b.group === group) }));
}

/** A KeyboardEvent-shaped input for dispatch decisions — KeyLike plus the fields the guards read. */
export interface DispatchEventLike extends KeyLike {
  repeat: boolean;
  target: unknown;
}

/** Ambient info the dispatcher needs beyond the event itself. */
export interface DispatchContext {
  hasSelection: boolean;
  /** Whether the game preview is currently running — gates 'playing' bindings (e.g. Pause). */
  isPlaying: boolean;
  /** Whether a native `<dialog>` is currently open. */
  dialogOpen: boolean;
}

export interface DispatchDecision {
  /** 'run': fire bind.run(store) and preventDefault. 'ignore': a guard ate the key, do nothing.
   * 'passthrough': a display-only row (or no binding at all) — let the key reach native/local handlers. */
  action: 'run' | 'ignore' | 'passthrough';
  bind?: Keybind;
  preventDefault: boolean;
}

/**
 * Pure decision function for a single keydown: given an event-shaped input
 * and ambient context, decide whether to run a binding, ignore the key, or
 * let it pass through untouched. No DOM access, no store mutation — kept
 * side-effect-free so the guards (repeat, typing target, dialog-open,
 * display-only rows) are unit-testable without a real KeyboardEvent/window.
 *
 * Guards (in order): auto-repeat (a held combo must not fire a burst of
 * mutating commands), typing fields (unless the resolved binding opts in via
 * `allowWhileTyping`), and an open native <dialog> (which owns everything
 * except Escape).
 */
export function dispatchDecision(e: DispatchEventLike, ctx: DispatchContext): DispatchDecision {
  if (e.repeat) return { action: 'ignore', preventDefault: false };
  const combo = eventCombo(e);
  if (!combo) return { action: 'ignore', preventDefault: false };
  // Resolved ahead of the typing-target guard so an `allowWhileTyping` row
  // (only 'search-scripts' today) can bypass it — every other binding's
  // guard behavior is unchanged, since resolveBinding is a pure lookup with
  // no side effects either way.
  const bind = resolveBinding({ combo, hasSelection: ctx.hasSelection, isPlaying: ctx.isPlaying });
  if (isTypingTarget(e.target) && !bind?.allowWhileTyping) {
    return { action: 'ignore', preventDefault: false };
  }
  if (ctx.dialogOpen && combo !== 'escape') return { action: 'ignore', preventDefault: false };
  if (!bind || bind.display) {
    // No binding, or a display-only row (Space-pan, Escape): let
    // SceneView/native handlers see the key untouched.
    return { action: 'passthrough', bind, preventDefault: false };
  }
  return { action: 'run', bind, preventDefault: true };
}

/**
 * Install the one global keydown listener. Returns a teardown fn.
 *
 * A thin DOM adapter around `dispatchDecision`: reads the event and the open
 * <dialog>/selection state, then applies the decision. InputSettings'
 * key-capture swallows keydowns at the *capture* phase, so this bubble-phase
 * listener never sees an armed capture — no extra guard needed here.
 */
export function installKeybinds(getStore: () => EditorStore): () => void {
  function onKeyDown(e: KeyboardEvent): void {
    const store = getStore();
    const dialogOpen =
      typeof document !== 'undefined' && document.querySelector('dialog[open]') !== null;
    const decision = dispatchDecision(e, {
      hasSelection: store.selection !== null,
      isPlaying: store.playing,
      dialogOpen,
    });
    if (decision.preventDefault) e.preventDefault();
    if (decision.action === 'run' && decision.bind) decision.bind.run(store);
  }
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
