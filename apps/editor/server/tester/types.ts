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

/**
 * The tester's verdict on what you changed since it last played.
 *
 * 'unreadable' is not something a tester can ever say. It is what a note gets
 * when the file on disk is not in a shape this version of Hearth can read, and
 * it exists so that case has somewhere to go other than one of the four real
 * answers. A session folder that has to be shown as "better" in order to be
 * shown at all is a session folder that can lie about someone's game.
 *
 * 'unclear' is the note the tester DID write, whose verdict line said something
 * that is not one of the three. "Mixed", "I cannot tell", "not better, if
 * anything worse". Its own value because the alternative was recording one of
 * the three anyway: "not better" was recorded as better and rendered as "that
 * helped", which is the exact opposite of what the tester said, in the one
 * sentence this whole feature exists to deliver. Everything else on such a note
 * is real and is still shown; only the verdict is missing.
 */
export interface ChangeVerdict {
  /** What it understood you changed, in its own words. */
  seen: string;
  verdict: 'better' | 'worse' | 'no-difference' | 'first-session' | 'unreadable' | 'unclear';
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
   * The first picture taken after the game put the tester somewhere, or absent
   * when that never happened during the session.
   *
   * Written down rather than derived, and that is the whole point of the field.
   * `report.ts` used to recover the placement line from the observations, so a
   * session whose SAW lines all happened to describe pictures taken BEFORE the
   * placement recovered nothing, and every uncited picture after the placement
   * was then reported as reached by playing. That is the stronger claim, it was
   * made about content the game had dropped the tester into, and it went out to
   * an agent as evidence that a player can get there. Only the session knows
   * where this line fell, so only the session may say.
   */
  placedFrom?: number;
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
  /**
   * How many pictures the session actually took, which is not always how many
   * turns it played: a screenshot that fails costs the turn its picture. Absent
   * on notes written before it was recorded, and readers fall back to the turn
   * count, which is an upper bound and never a smaller one.
   */
  frames?: number;
  /** 'unreadable' is Hearth's word about the file, never the tester's about the game. */
  stopped: 'done' | 'budget' | 'user' | 'error' | 'unreadable';
}

/** What a note says about a change it cannot be read as having judged. */
export const UNREADABLE_SEEN = 'Hearth could not read this session out of its note.';

/** Why, said without guessing at what the file was supposed to contain. */
export const UNREADABLE_WHY =
  'The file is in the folder, but not in a shape this version of Hearth knows how to read. Older and newer Hearths write notes differently, and a note can also be hand-edited.';

/**
 * The regression answer on an unreadable note. Its own sentence rather than
 * MISSING_REGRESSION, because "it never said" and "we could not read what it
 * said" are different facts and only one of them is about the tester.
 */
export const UNREADABLE_REGRESSION = 'Whether anything got worse could not be read out of this note.';

/**
 * A session that exists on disk and cannot be read, as a note.
 *
 * Every field that carries a claim about the game is emptied rather than
 * half-recovered. A note that is partly readable is still a note whose missing
 * half is unknown, and showing the half that parsed would put a selective
 * account of someone's game on screen under a heading that promises the whole
 * one. The session number survives because the history is append-only and a
 * session vanishing from it is its own kind of lie.
 */
export function unreadableNote(session: number, startedAt = '', finishedAt = ''): TesterNote {
  return {
    session,
    startedAt,
    finishedAt,
    onTheChange: { seen: UNREADABLE_SEEN, verdict: 'unreadable', why: UNREADABLE_WHY },
    regression: UNREADABLE_REGRESSION,
    observations: [],
    proposals: [],
    openQuestions: [],
    steps: 0,
    stopped: 'unreadable',
  };
}
