/**
 * The blank surface: a greeting, a composer, and which project the message
 * lands in. This is BOTH the app's first screen and what New chat shows, on
 * purpose — "what are we working on" is the same question whether or not a
 * project is already open, and having two screens ask it differently was the
 * app disagreeing with itself.
 *
 * Nothing else is on it. No cards, no feature grid, no "get started"
 * checklist: the one thing to do here is type a sentence, and every other
 * element is a reason not to. Where it lands is a control ON the composer
 * (see ProjectSelector), not a step before it — the project is created by the
 * message when it needs to be (`startFromHome` in store.ts).
 */
import React, { useMemo } from 'react';
import { useApp } from '../../store';
import { Composer } from '../chat/Composer';
import { Icon } from '../ui';

/**
 * The greeting, by hour of day. Four times of day, two lines each, chosen by
 * `seed` so the same hour doesn't say the same thing forever. Pure: the whole
 * rotation is checkable without a clock.
 *
 * Warm, short, and about the work — this is the first sentence the app says,
 * and it is a greeting, not a slogan. No exclamation marks: the app is glad
 * you're here, not excited at you.
 */
const GREETINGS: Record<'morning' | 'afternoon' | 'evening' | 'late', readonly string[]> = {
  morning: ['What are we making this morning?', 'Morning. What should we build?'],
  afternoon: ['What should we play today?', 'What are we building this afternoon?'],
  evening: ['What are we making tonight?', 'Evening. Where should the game go?'],
  late: ["It's a late-night build session.", 'Still up. What are we making?'],
};

/** Which set of lines an hour belongs to. Pure, exported for its own test. */
export function timeOfDay(hour: number): 'morning' | 'afternoon' | 'evening' | 'late' {
  // Hours outside 0–23 are a caller bug, not a reason to render nothing.
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'late';
}

export function greetingFor(hour: number, seed: number): string {
  const lines = GREETINGS[timeOfDay(hour)];
  const index = ((Math.floor(seed) % lines.length) + lines.length) % lines.length;
  return lines[index];
}

/**
 * A seed that changes daily and not within a session: the greeting rotating
 * mid-session (on a re-render, on a folder closing) would read as a glitch.
 */
function todaySeed(now: number = Date.now()): number {
  return Math.floor(now / 86_400_000);
}

export function Home() {
  const error = useApp((s) => s.chatError);
  const target = useApp((s) => s.composeTarget);
  // Read the clock once per mount. A greeting that re-rolls under the user is
  // the app fidgeting.
  const greeting = useMemo(() => greetingFor(new Date().getHours(), todaySeed()), []);

  return (
    <main className="home" aria-label="Start">
      <div className="home-column">
        <h1 className="home-greeting">
          <span className="home-mark" aria-hidden="true">
            <Icon name="flame" size={26} />
          </span>
          {greeting}
        </h1>

        <Composer variant="home" />

        {error && (
          <p className="home-error" role="status">
            {error}
          </p>
        )}

        {/* Only said when it is actually about to happen. Inside an existing
            project this line would be describing something else's behaviour.
            It no longer promises a name: sending asks for one, with a draft
            already filled in from what you wrote. */}
        {target === null && (
          <p className="home-note">
            Sending starts a new project in <span className="mono">~/Hearth</span>. You'll name it first.
          </p>
        )}
      </div>
    </main>
  );
}
