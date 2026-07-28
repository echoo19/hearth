/**
 * The one transient message slot.
 *
 * This exists because of a specific failure: a send that could not go out
 * logged "Not connected. Wait a moment and send again." to the console panel,
 * which lives behind a tab in the game pane. Someone chatting pressed send,
 * nothing happened, and the reason was somewhere they had no cause to look.
 * Anything a person has to act on has to appear where they already are.
 *
 * Deliberately one slot rather than a stack. Toasts pile up in exactly the
 * situations that produce them, a dropped connection or a retry loop, and a
 * corner filling with near-identical notes is worse than the newest one
 * replacing the last. A repeat of the message already showing just restarts
 * its timer instead of queueing behind it.
 *
 * Kept out of the main store on purpose: this is display state with a timer,
 * nothing persists it, and the modules that need to raise a toast should not
 * have to reach into the app store to do it.
 */

export type ToastTone = 'info' | 'error';

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  /** An optional single action, for the cases where saying it is not enough. */
  action?: { label: string; run: () => void };
}

/** How long a toast stays. Errors linger: they are usually longer to read. */
const DWELL_MS: Record<ToastTone, number> = { info: 4000, error: 7000 };

type Listener = (toast: Toast | null) => void;

let current: Toast | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(current);
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

export function subscribeToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentToast(): Toast | null {
  return current;
}

export function showToast(message: string, tone: ToastTone = 'info', action?: Toast['action']): void {
  const trimmed = message.trim();
  if (trimmed === '') return;
  // Same message again: restart the clock rather than swap in a new card. The
  // text has not changed, so a re-entry animation would only be noise. Keeping
  // the id is what holds the card still, since the id is its React key.
  const showing = current;
  const repeat = showing !== null && showing.message === trimmed && showing.tone === tone;
  current = { id: repeat ? showing.id : nextId++, message: trimmed, tone, action };
  clearTimer();
  timer = setTimeout(dismissToast, DWELL_MS[tone]);
  emit();
}

export function dismissToast(): void {
  clearTimer();
  if (current === null) return;
  current = null;
  emit();
}

/** Test seam: drop the slot and every listener between cases. */
export function resetToasts(): void {
  clearTimer();
  current = null;
  listeners.clear();
  nextId = 1;
}
