/**
 * Watching the tester play.
 *
 * The picture is the subject and the thinking is the caption. That ordering is
 * the whole layout: the frame takes the room, the thoughts sit beside it in a
 * quiet column, and nothing else on the surface competes with either. A tester
 * playing somewhere the person who asked for it cannot see is indistinguishable
 * from nothing happening, which is the exact failure that sank the feature this
 * replaces.
 *
 * The frames come through the existing stream (../../probeStream.ts) and never
 * touch React: the <img> subscribes by hand. What renders here is small and
 * changes a handful of times a session.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp, type TesterState } from '../../store';
import type { TesterNote } from '../../../server/tester/types';
import {
  closeProbeStream,
  openProbeStream,
  probeStreamStatus,
  subscribeProbeStatus,
} from '../../probeStream';
import { ProbeFrames, ProbeNote, stageNoteStatus } from '../game/ProbeStage';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { ReportView } from './ReportView';
import { readableNote } from './testerRows';

/**
 * Why the tester cannot be asked to play, or null when it can.
 *
 * Pure and shared by every Play control on this surface, so the three of them
 * cannot drift into three different accounts of the same folder.
 */
export function whyNoPlay(gamePresent: boolean, running: boolean, starting: boolean): string | null {
  if (!gamePresent) return 'There is no game in this project yet, so there is nothing for it to play.';
  if (starting) return 'It is waking up. Give it a moment.';
  if (running) return 'It is playing right now.';
  return null;
}

/**
 * The tester's answer, with its protocol taken back out of it.
 *
 * It answers in prose plus marker lines, because that is the only way a model
 * playing a game can say "hold right" and be understood exactly. Those markers
 * are addressed to the loop, not to the reader: `ACTION: right, jump` is an
 * instruction, and `VERDICT: no-difference` is a bare enum value. Neither is
 * something a person should have to learn to read their own tester, so the
 * instructions are dropped and the labels are turned back into words.
 */
export function readableThought(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    // Addressed to the loop. The person watching already sees the result of it
    // in the picture next to this column.
    if (/^(ACTION|CLICK|MOVE)\s*:/i.test(line) || /^DONE\b/i.test(line)) continue;

    const saw = /^SAW\s*(\d+)\s*:\s*(.*)$/i.exec(line);
    if (saw) {
      lines.push(`On picture ${saw[1]}, ${saw[2].charAt(0).toLowerCase()}${saw[2].slice(1)}`);
      continue;
    }
    const verdict = /^VERDICT\s*:\s*(.*)$/i.exec(line);
    if (verdict) {
      const word = verdict[1].toLowerCase();
      lines.push(
        /better|improv/.test(word)
          ? 'Its verdict: the change helped.'
          : /worse/.test(word)
            ? 'Its verdict: the change made things worse.'
            : 'Its verdict: no real difference.',
      );
      continue;
    }
    lines.push(
      line
        .replace(/^QUESTION\s*:\s*/i, 'Still not sure: ')
        .replace(/^CHANGE\s*:\s*/i, 'What it thinks changed: ')
        .replace(/^WHY\s*:\s*/i, 'Why: ')
        .replace(/^WORSE\s*:\s*/i, 'Anything worse: '),
    );
  }
  return lines.join('\n');
}

/**
 * What the tester is doing, in words a person can read.
 *
 * A phase name is a token for the code to switch on, and rendering one is how a
 * surface starts asking its reader to learn its vocabulary. Every state gets a
 * sentence instead.
 */
export function testerStatusLine(tester: TesterState): string {
  if (tester.starting) return 'Waking your tester up';
  if (!tester.running) {
    if (tester.phase === 'finished') return 'Finished';
    return tester.session === null ? 'Ready when you are' : 'Not playing';
  }
  switch (tester.phase) {
    case 'playing':
      return 'Playing your game';
    case 'reflecting':
      return 'Writing up what it saw';
    case 'writing':
      return 'Saving what it learned';
    default:
      return 'Opening your game';
  }
}

/**
 * Which turn of the budget is being spent. The thinking arrives one answer per
 * turn, so counting the answers is what the person is watching anyway. Capped at
 * the budget because the last few answers are the write-up, not more play.
 */
export function testerTurnLine(tester: TesterState): string | null {
  if (!tester.running || tester.phase !== 'playing' || tester.maxSteps <= 0) return null;
  return `Turn ${Math.min(Math.max(tester.thoughts.length, 1), tester.maxSteps)} of ${tester.maxSteps}`;
}

/** How the session ended, said the way a person would say it. */
export function testerEndingLine(tester: TesterState): string | null {
  const note = tester.lastNote;
  if (!note || tester.running) return null;
  switch (note.stopped) {
    case 'budget':
      return `It played its full ${note.steps} turns.`;
    case 'user':
      return `You stopped it after ${note.steps} ${note.steps === 1 ? 'turn' : 'turns'}.`;
    case 'error':
      return 'It ran into trouble and wrote down what it had.';
    default:
      return `It played ${note.steps} ${note.steps === 1 ? 'turn' : 'turns'} and said it had seen enough.`;
  }
}

/**
 * Play, with the reason it cannot be pressed attached to it.
 *
 * `aria-disabled` rather than `disabled`, for the reason CapabilityStrip gives:
 * a natively disabled button dispatches no pointer events, so the tooltip
 * saying WHY it is unavailable never opens and the control is a dead end. The
 * click is guarded here instead, which is what makes that safe.
 */
export function PlayButton({
  blocked,
  label,
  hint,
  onPlay,
}: {
  blocked: string | null;
  label: string;
  /** What pressing it does, for when there is nothing stopping it. */
  hint: string;
  onPlay: () => void;
}) {
  return (
    <Tooltip content={blocked ?? hint}>
      <Button
        variant="primary"
        icon="play"
        aria-disabled={blocked !== null}
        onClick={() => {
          if (blocked === null) onPlay();
        }}
      >
        {label}
      </Button>
    </Tooltip>
  );
}

/**
 * The report for the session that just finished, offered where it finished.
 *
 * A session ended and left the pane saying so and nothing else, and the only
 * route to what it decided was the Tester screen, find the session, open the
 * whole thing. That is three moves away from the one surface the person was
 * already watching, and the plan of action, the part that is actually theirs to
 * approve, was at the bottom of the third one.
 *
 * Offered, never opened for them. A dialog that appears by itself over somebody
 * who walked away while their tester played is a dialog they dismiss without
 * reading, and the thing it interrupts might be anything.
 */
function FinishedReport({ note }: { note: TesterNote }) {
  const [reading, setReading] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // The same normalisation the history applies before it hands a note to the
  // report. A note straight off disk can be missing anything, and the dialog
  // reads it directly.
  const readable = readableNote(note);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="tester-read tester-rest-read"
        onClick={() => setReading(true)}
      >
        Read the report
      </button>
      <ReportView
        note={readable}
        open={reading}
        onClose={() => setReading(false)}
        returnFocusTo={trigger}
      />
    </>
  );
}

/** Nothing has ever played here. An invitation, not an empty log. */
function TesterInvitation({ onPlay, blocked }: { onPlay: () => void; blocked: string | null }) {
  return (
    <div className="tester-empty">
      <div className="tester-empty-frame" aria-hidden="true" />
      <p className="tester-empty-lead">Your tester has not played this game yet</p>
      <p className="tester-empty-hint">
        It plays the game itself, remembers every session, and tells you whether your last change
        helped. The first time it plays is the only naive look at your game it will ever have.
      </p>
      <PlayButton
        blocked={blocked}
        label="Play"
        hint="It opens your game and plays a session now."
        onPlay={onPlay}
      />
      {/* Said on the surface as well as in the tooltip. A hint that only exists
          on hover is a hint a keyboard and a phone never get. */}
      {blocked && <p className="tester-empty-blocked">{blocked}</p>}
    </div>
  );
}

export function TesterStage() {
  const projectPath = useApp((s) => s.projectPath);
  const gamePresent = useApp((s) => s.game.present);
  const tester = useApp((s) => s.tester);
  const playTester = useApp((s) => s.playTester);
  const stopTester = useApp((s) => s.stopTester);
  const refreshTesterHistory = useApp((s) => s.refreshTesterHistory);
  const openScreen = useApp((s) => s.openScreen);
  const thoughtsRef = useRef<HTMLOListElement>(null);

  const streamStatus = useSyncExternalStore(subscribeProbeStatus, probeStreamStatus);
  const noteStatus = stageNoteStatus(streamStatus, tester.running);

  // What the folder already knows, read once when this surface appears. A
  // session started in another window (or before a reload) is still running
  // on the server, and this is how this window finds out.
  useEffect(() => {
    if (projectPath) void refreshTesterHistory();
  }, [projectPath, refreshTesterHistory]);

  // Hold the picture open for as long as this surface is showing a session.
  // The stream counts its viewers, so mounting and unmounting around a running
  // session is safe.
  useEffect(() => {
    if (!projectPath || !(tester.running || tester.starting)) return;
    openProbeStream(projectPath);
    return () => closeProbeStream();
  }, [projectPath, tester.running, tester.starting]);

  // Follow the newest thought. No smooth scrolling: the text is arriving in
  // fragments, and animating the follow would keep the column in motion for the
  // whole session.
  useEffect(() => {
    const list = thoughtsRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [tester.thoughts]);

  // A turn whose whole answer was an instruction to the loop leaves nothing for
  // a reader, and an empty paragraph appearing in the column would look like a
  // fault rather than like a turn that had nothing to say.
  const readable = tester.thoughts
    .map((thought) => ({ turn: thought.turn, text: readableThought(thought.text) }))
    .filter((thought) => thought.text !== '');

  const idle = !tester.running && !tester.starting;
  const neverPlayed = idle && tester.session === null && tester.sessions.length === 0;
  const turnLine = testerTurnLine(tester);
  const endingLine = testerEndingLine(tester);
  // The session whose report this surface can offer. `lastNote` is this
  // window's own session and is cleared the moment a new one starts; the fall
  // back to the newest on disk is what makes the offer survive a reload.
  const finished =
    idle && !tester.error
      ? (tester.lastNote ?? tester.sessions[tester.sessions.length - 1] ?? null)
      : null;

  const blocked = whyNoPlay(gamePresent, tester.running, tester.starting);

  if (neverPlayed && !tester.error) {
    return (
      <div className="tester-pane">
        <TesterInvitation onPlay={() => void playTester()} blocked={blocked} />
      </div>
    );
  }

  return (
    <div className="tester-pane">
      <header className="tester-bar">
        <span className={`tester-live${tester.running ? ' is-live' : ''}`} aria-hidden="true" />
        {/* The only live region on the surface. The thoughts below change
            constantly and would make a screen reader unusable; this changes a
            handful of times a session and is the thing worth announcing. */}
        <p className="tester-status" aria-live="polite">
          {testerStatusLine(tester)}
        </p>
        {turnLine && <span className="tester-budget">{turnLine}</span>}
        <span className="tester-bar-gap" />
        {/* The pane shows this session; the history is what the tester is
            actually for. Quiet, because it is a way out rather than the act. */}
        {tester.sessions.length > 0 && (
          <Button variant="ghost" onClick={() => openScreen('tester')}>
            Every session
          </Button>
        )}
        {tester.running || tester.starting ? (
          <Button icon="stop" onClick={() => void stopTester()}>
            Stop
          </Button>
        ) : (
          <PlayButton
            blocked={blocked}
            label="Play again"
            hint="It opens your game and plays another session now."
            onPlay={() => void playTester()}
          />
        )}
      </header>

      {tester.error && (
        <p className="tester-error" role="alert">
          {tester.error}
        </p>
      )}

      <div className="tester-body">
        <div className="tester-view">
          {tester.running || tester.starting ? (
            <>
              <ProbeFrames />
              <ProbeNote status={noteStatus} />
            </>
          ) : (
            <div className="tester-view-rest">
              <p className="tester-rest-line">{endingLine ?? 'Nothing is playing.'}</p>
              {finished && <FinishedReport key={finished.session} note={finished} />}
            </div>
          )}
        </div>

        <div className="tester-think">
          <h2 className="tester-think-title">What it is thinking</h2>
          {readable.length === 0 ? (
            <p className="tester-think-empty">
              {tester.running ? 'Waiting for its first look at the game.' : 'Nothing said yet.'}
            </p>
          ) : (
            <ol className="tester-thoughts" ref={thoughtsRef}>
              {readable.map((thought) => (
                <li key={thought.turn} className="tester-thought">
                  {thought.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
