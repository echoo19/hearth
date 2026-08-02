/**
 * How long something took, said once, the same way everywhere.
 *
 * Two places in the transcript report a span — a command that ran and a thought
 * the model had — and they have to agree, both on the wording and on when to
 * keep quiet. A replayed transcript folds in a millisecond, so without a floor
 * every line in it would claim to have taken 0.0s.
 *
 * Whole seconds, never tenths. A number that is being watched should count the
 * way a person counts — one, two, three — and a decimal place on a figure that
 * changes ten times a second is movement carrying no information.
 */

/** Below this, a duration is noise rather than information. */
export const DURATION_FLOOR_MS = 100;

/**
 * `5s` / `2m 04s` / `3h 5m 10s`. Seconds are padded once a larger unit is
 * present so the line cannot jitter as it ticks; the leading unit never is,
 * because nothing sits to its left to line up with.
 */
function spanOf(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const padded = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}h ${minutes}m ${padded}s`;
  if (minutes > 0) return `${minutes}m ${padded}s`;
  return `${seconds}s`;
}

/** `840ms` / `5s` / `2m 04s` / `3h 5m 10s` — sub-second spans keep their unit. */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < DURATION_FLOOR_MS) return null;
  // Under a second there is no whole second to report, and `0s` would read as
  // "instant" for something that took most of one.
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return spanOf(Math.round(ms / 1000));
}

/**
 * The same span for a line that is being watched rather than read: it says
 * nothing at all for the first few seconds, because most turns are over before
 * a stopwatch is interesting.
 */
export const ELAPSED_FLOOR_S = 3;

export function formatElapsed(ms: number): string | null {
  const seconds = Math.floor(ms / 1000);
  if (seconds < ELAPSED_FLOOR_S) return null;
  return spanOf(seconds);
}
