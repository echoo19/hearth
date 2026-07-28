/**
 * What the private tester writes down.
 *
 * Shared by the play loop, the routes and the history surface, so the shape of
 * a session note is stated once and every reader agrees with every writer.
 */

/**
 * How the tester came to be where something happened.
 *
 * 'played' means it got there by playing, so what it saw is also evidence that
 * the place is reachable. 'placed' means the game put it there on request, and
 * a finding from there is a finding about that content and nothing else: level
 * sixteen's exit could be broken and a report from level seventeen would still
 * read as glowing.
 */
export type ObservationReach = 'played' | 'placed';

/** One thing the tester saw, anchored to the frame it saw it on. */
export interface TesterObservation {
  /** Index into the session's frames directory. A claim with no frame is not evidence. */
  frame: number;
  text: string;
  /** Absent on notes written before the tester could be placed anywhere. */
  reached?: ObservationReach;
}

/**
 * How an observation was reached, for readers that need an answer either way.
 *
 * A note with no `reached` was written when nothing could put the tester
 * anywhere, so 'played' is what happened rather than a guess. Nothing else in
 * the observation is consulted: text that sounds like a teleport is still text.
 */
export function observationReach(observation: TesterObservation): ObservationReach {
  return observation.reached === 'placed' ? 'placed' : 'played';
}

/** The tester's verdict on what you changed since it last played. */
export interface ChangeVerdict {
  /** What it understood you changed, in its own words. */
  seen: string;
  verdict: 'better' | 'worse' | 'no-difference' | 'first-session';
  why: string;
}

/** One session, written once at the end and never rewritten. */
export interface TesterNote {
  session: number;
  startedAt: string;
  finishedAt: string;
  onTheChange: ChangeVerdict;
  /**
   * Required, and "nothing got worse" is a choice it has to actively make.
   * An optional field here would be answered by silence every time, which is
   * how a tester becomes a flattery machine.
   */
  regression: string;
  observations: TesterObservation[];
  /** What it still could not work out. Carried into the next session. */
  openQuestions: string[];
  steps: number;
  stopped: 'done' | 'budget' | 'user' | 'error';
}
