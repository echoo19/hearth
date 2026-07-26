/**
 * Home — what the app is before it is a project.
 *
 * A greeting and a composer, centred, and nothing else. No cards, no feature
 * grid, no "get started" checklist: the first thing anyone should do here is
 * type a sentence, and every additional element on this screen is a reason not
 * to. The folder comes after — sending from here makes one (see
 * `startFromHome` in store.ts), which is the whole point of the screen.
 */
import React, { useMemo } from 'react';
import { useApp } from '../../store';
import { Composer } from '../chat/Composer';
import { Icon } from '../ui';
import { useOpenFolder } from '../shell/useOpenFolder';

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
  const openFolder = useOpenFolder();
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

        <p className="home-note">
          Chats become folders in <span className="mono">~/Hearth</span>
          <span className="home-note-sep" aria-hidden="true">
            ·
          </span>
          <button type="button" className="home-open" onClick={() => void openFolder()}>
            Open a folder…
          </button>
        </p>
      </div>
    </main>
  );
}
