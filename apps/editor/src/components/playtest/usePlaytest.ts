/**
 * When to re-read the playtest view.
 *
 * Polled while a sweep runs rather than pushed. The journal already streams
 * every milestone to the rail, and a second live channel carrying the same
 * facts is a second thing that can disagree with them, so this reads the
 * files the sweep is writing, on a clock, and the journal stays the one
 * progress feed. A read of one folder's evidence dir a second is cheap, and it
 * is also how the skip forecast reaches the screen: the runner makes it a beat
 * after the game opens, and nothing announces it.
 *
 * The state itself lives in the store rather than here, because it is not only
 * this screen's: the Playtest button's denominator is wrong until the plan says
 * which bots are actually going to run (see plannedRuns in store.ts).
 */
import { useEffect, useState } from 'react';
import { useApp } from '../../store';
import type { PlaytestView } from '../../types';

/** How often to re-read while a sweep is in flight. */
export const PLAYTEST_POLL_MS = 1000;

export interface PlaytestFeed {
  view: PlaytestView | null;
  /**
   * A read has come back at least once. Until then the screen says nothing:
   * "no playtest has run here" and "we have not looked yet" are different
   * things and only one of them is safe to print.
   */
  tried: boolean;
}

export function usePlaytest(project: string | null, running: boolean): PlaytestFeed {
  const view = useApp((s) => s.playtest);
  const refresh = useApp((s) => s.refreshPlaytest);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    setTried(false);
    let live = true;
    void refresh().finally(() => {
      if (live) setTried(true);
    });
    return () => {
      live = false;
    };
  }, [refresh, project]);

  // While something is running the state changes several times a minute: a run
  // finishes, the forecast arrives, the report lands. Between sweeps nothing
  // changes at all, so nothing is polled.
  useEffect(() => {
    if (!running || !project) return;
    const id = window.setInterval(() => void refresh(), PLAYTEST_POLL_MS);
    return () => window.clearInterval(id);
  }, [running, project, refresh]);

  // The last read of a sweep has to happen AFTER it ends: the report, and with
  // it every skip reason, is written on the way out, so the poll that ran while
  // it played never saw one.
  useEffect(() => {
    if (running) return;
    void refresh();
  }, [running, refresh]);

  return { view, tried };
}
