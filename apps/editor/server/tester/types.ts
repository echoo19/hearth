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
 * a finding from there is a finding about that content and nothing else. A
 * tester dropped into year three of a management sim can report that year
 * three plays well while the budget rules make year two impossible to survive,
 * and the report would still read as glowing.
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

/**
 * Something the tester thinks is worth changing, in its own words.
 *
 * `kind` is the tester's own claim about what sort of thing it is, and the two
 * are never merged: it watched the crash happen, and it did not watch the jump
 * being unfair. Written as it arrived, so `report.ts` can be the one place that
 * decides what survives.
 */
export interface TesterProposal {
  kind: 'bug' | 'suggestion';
  text: string;
  /** Pictures it is pointing at. One that points at nothing does not survive. */
  evidence: number[];
}

/**
 * Where the game said the tester could be put, and where it went.
 *
 * A fact about the game as it was when the session ran, which is why it is
 * written down per session rather than read off the game later. Absent on
 * notes written before a game could name anywhere at all, so a reader has to
 * handle its absence rather than read a missing value as "it named nothing".
 */
export interface TesterPlacement {
  /** How many situations the game named. Zero when it named none. */
  offered: number;
  /** What the game called the one it was put into, when it went somewhere. */
  entered?: string;
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
  /**
   * What the game offered by way of somewhere to be put. Absent on notes
   * written before a game could name anywhere, and never inferred: a capability
   * Hearth did not have is a sentence in the report, not a silent gap.
   */
  placement?: TesterPlacement;
  /**
   * What it thinks is worth changing, which is allowed to be nothing at all.
   * Absent on notes written before the plan of action existed.
   */
  proposals?: TesterProposal[];
  /** What it still could not work out. Carried into the next session. */
  openQuestions: string[];
  steps: number;
  stopped: 'done' | 'budget' | 'user' | 'error';
}
