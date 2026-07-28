/**
 * How long something took, said once, the same way everywhere.
 *
 * Two places in the transcript report a span — a command that ran and a thought
 * the model had — and they have to agree, both on the wording and on when to
 * keep quiet. A replayed transcript folds in a millisecond, so without a floor
 * every line in it would claim to have taken 0.0s.
 */

/** Below this, a duration is noise rather than information. */
export const DURATION_FLOOR_MS = 100;

/** `840ms` / `1.2s` / `2m 04s` — one unit, never two decimal places. */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < DURATION_FLOOR_MS) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

/**
 * The same span, rounded for a line that is being watched rather than read.
 * A live counter ticking tenths is a fidget, so while something is still
 * running it counts whole seconds — and says nothing at all for the first few,
 * because most turns are over before a stopwatch is interesting.
 */
export const ELAPSED_FLOOR_S = 3;

export function formatElapsed(ms: number): string | null {
  const seconds = Math.floor(ms / 1000);
  if (seconds < ELAPSED_FLOOR_S) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}
