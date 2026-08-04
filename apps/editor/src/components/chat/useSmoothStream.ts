/**
 * Text that arrives in lumps, shown as a flow.
 *
 * Providers do not stream a character at a time. They hand over whatever has
 * accumulated since the last flush — five words, then nothing for half a
 * second, then eight more — and rendering each lump the instant it lands means
 * the reader's eye is dragged to a new place several times a second. It is the
 * single thing that makes a transcript feel like a machine printing at you
 * rather than something writing.
 *
 * So what is on screen is allowed to lag what has arrived, and to catch up at
 * a rate rather than in a jump. The lag is bounded and small — a backlog is
 * mostly consumed inside a seventh of a second — so nothing ever feels held
 * back; the delay buys the eye a steady left-to-right crawl instead of a
 * sequence of teleports.
 *
 * The store still holds the truth. This paces the READING of it and nothing
 * else: no character is invented, dropped or reordered, and the moment a turn
 * ends the whole of it is on screen.
 *
 * And it is motion, so it answers to prefers-reduced-motion like everything
 * else that moves: with the setting on, text lands whole rather than crawling.
 */
import { useEffect, useRef, useState } from 'react';

/** How long a backlog takes to be mostly consumed. Under a fifth of a second:
 *  fast enough that nobody perceives a delay, slow enough to be a crawl. */
const CATCH_UP_MS = 140;

/** Always move, even one character behind, so a trickle never stalls. */
const MIN_STEP = 2;

/**
 * The most to reveal in one frame. Without it a large lump is "smoothed" into
 * a single 40-word jump, which is the thing this exists to prevent; with it,
 * two kilobytes take about half a second to lay down.
 */
const MAX_STEP = 90;

/**
 * Past this, pacing is the wrong answer. A jump this size is a replay, a
 * conversation being reopened, or a provider that batches an entire turn —
 * none of which is a stream, and all of which should simply be there.
 */
const SNAP_ABOVE = 6000;

/** How much of `total` should be on screen after `dtMs` more milliseconds. */
export function nextReveal(shown: number, total: number, dtMs: number): number {
  const backlog = total - shown;
  if (backlog <= 0) return total;
  if (backlog > SNAP_ABOVE) return total;
  const share = Math.ceil(backlog * Math.min(1, dtMs / CATCH_UP_MS));
  return Math.min(total, shown + Math.min(MAX_STEP, Math.max(MIN_STEP, share)));
}

/**
 * `text`, revealed at a readable rate while `live`.
 *
 * Only growth AFTER this mounts is paced. Text already present when the
 * component appears is shown whole: joining a turn in progress, or reopening a
 * conversation, is not something anyone wants typed out to them. Text that
 * stops being a prefix of what is shown (an edit, a rewind, a different
 * message reusing the element) is likewise taken as-is — the alternative is
 * showing characters that are no longer in the transcript.
 */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Whether the reader has asked for less movement, kept current if they change
 * their mind mid-turn.
 *
 * Laying text down at a rate IS motion, whatever it is made of — the eye
 * tracks a moving edge across the line exactly as it tracks a sliding panel.
 * The setting is not a style preference; for some readers it is the difference
 * between text they can follow and text that makes them ill. So the pacing is
 * the thing that goes, not the text.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION)?.matches === true,
  );
  useEffect(() => {
    const query = typeof window === 'undefined' ? undefined : window.matchMedia?.(REDUCED_MOTION);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function useSmoothStream(text: string, live: boolean): string {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(text.length);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const seenRef = useRef(text);

  useEffect(() => {
    const previous = seenRef.current;
    seenRef.current = text;
    // Not a continuation of what is on screen: nothing to pace.
    if (!text.startsWith(previous.slice(0, Math.min(previous.length, shownRef.current)))) {
      setShown(text.length);
      return;
    }
    // Not live, or motion is unwanted: the whole of it, now. A reader who has
    // turned motion off gets the text, not a slower version of the crawl.
    if (!live || reduced) {
      setShown(text.length);
      return;
    }
    if (shownRef.current >= text.length) return;

    let frame = 0;
    let last = performance.now();
    const step = (at: number): void => {
      const dt = at - last;
      last = at;
      const next = nextReveal(shownRef.current, text.length, dt);
      shownRef.current = next;
      setShown(next);
      if (next < text.length) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // `reduced` is a dependency so a crawl already under way is snapped shut
    // the moment the setting changes, rather than finishing at leisure.
  }, [text, live, reduced]);

  // Never claim more than exists: a shorter `text` arriving between renders
  // would otherwise slice past its end for one frame.
  return shown >= text.length ? text : text.slice(0, shown);
}
