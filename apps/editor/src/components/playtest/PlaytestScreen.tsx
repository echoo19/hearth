/**
 * Playtesters: the bots that play your game, one panel each.
 *
 * The pane's rail answers "what happened, in order". This answers the question
 * people actually have after watching two bots wander around pressing buttons:
 * why is that all they did? Usually because the other bots were never able to
 * start. wander and seek need to know where the avatar is and where the floor
 * is, and a game that declares neither gets skipped WITH A REASON that until
 * now went into a report file nobody opens. Here it is the largest thing in
 * the panel, because it is the most useful sentence the probe ever writes.
 *
 * Why a column and not a grid:
 *
 * A sweep is sequential. `runSweep` walks its policies one at a time against
 * ONE browser, so exactly one of these can be alive at any moment, and a row
 * of equal boxes would draw several live feeds where there is only ever one. A
 * stacked column in the sweep's own running order says the true thing
 * structurally: this is a queue. The one with the browser is the one that
 * opens up to show a picture; everything above it has already played,
 * everything below is waiting, and the skipped ones sit in the line they were
 * asked in with their reason where their run would have been.
 *
 * The picture is the same stream the game pane uses, reused rather than
 * rebuilt (see ../../probeStream.ts): frames go straight to an <img> that
 * subscribes by hand, and only the STATUS ever reaches React. Ten frames a
 * second through a store would re-render this whole screen ten times a second.
 *
 * And the honesty rule the stream came with is kept intact: a panel gets the
 * live treatment only while frames are really arriving. When the sweep is up
 * but there is no picture (no browser on this machine, a session with no CDP)
 * the panel says where the bot actually is instead of glowing at an empty box.
 */
import React, { useEffect } from 'react';
import { useApp } from '../../store';
import { closeProbeStream, openProbeStream, probeStreamStatus, subscribeProbeStatus } from '../../probeStream';
import { useSyncExternalStore } from 'react';
import { ScreenHeader } from '../ui/ScreenHeader';
import { PlaytestButton } from '../game/CapabilityStrip';
import { ProbeFrames, ProbeNote, probeNote, stageNoteStatus } from '../game/ProbeStage';
import { verdictLabel, verdictTone } from '../evidence/evidenceRows';
import { usePlaytest } from './usePlaytest';
import { livePanel, playtestPanels, playtestSummary, policyBlurb, type Panel, type PanelState } from './playtestPanels';
import type { Finding, PlaytestRun } from '../../types';

/**
 * Where leaving goes. The screen is opened from a project's game column, so
 * the project is what is waiting underneath; without one, the app's resting
 * surface is the conversation list.
 */
export function playtestBackLabel(projectName: string | null, projectPath: string | null): string {
  return projectPath !== null && projectName !== null && projectName !== '' ? projectName : 'Chats';
}

/** The word in a panel's corner, and which of the three tones it wears. */
export function stateChip(state: PanelState): { label: string; tone: 'live' | 'ok' | 'warn' | 'quiet' } {
  switch (state.kind) {
    case 'playing':
      return { label: 'Playing', tone: 'live' };
    case 'played':
      return { label: 'Played', tone: 'ok' };
    case 'skipped':
      return { label: 'Skipped', tone: 'warn' };
    case 'waiting':
      return { label: 'Waiting', tone: 'quiet' };
    case 'passed':
      return { label: 'Did not run', tone: 'warn' };
    default:
      return { label: 'Not asked', tone: 'quiet' };
  }
}

/** One run's outcome: the seed that produced it, and what it came to. */
function RunChip({ run }: { run: PlaytestRun }) {
  return (
    <span className={`playtest-run tone-${verdictTone(run.verdict)}`}>
      <span className="playtest-run-seed">seed {run.seed}</span>
      {verdictLabel(run.verdict)}
      <span className="playtest-run-frames">{run.frames} frames</span>
    </span>
  );
}

function FindingList({ findings }: { findings: readonly Finding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="playtest-findings">
      {findings.map((finding, index) => (
        <li key={`${finding.kind}-${index}`} className="playtest-finding">
          <span className="playtest-finding-summary">{finding.summary}</span>
          {finding.detail && <span className="playtest-finding-detail">{finding.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The live panel's picture. Mounted only for the one bot that has the browser,
 * and only ever one of them, which is the sweep's own shape.
 *
 * When there is no picture (the browser is still coming up, or there is no
 * usable one on this machine at all) this draws NO frame. A picture-shaped
 * black box with nothing in it reads as a video that failed, which is a worse
 * lie than the one the streaming work was done to fix. The bot is still
 * playing; the panel says where, in a line of text, using the same words the
 * game stage uses for the same situation.
 */
function LiveStage({ sweepRunning }: { sweepRunning: boolean }) {
  const status = useSyncExternalStore(subscribeProbeStatus, probeStreamStatus, probeStreamStatus);
  const note = stageNoteStatus(status, sweepRunning);
  if (note !== 'live') return <p className="playtest-line">{probeNote(note) ?? 'Playing somewhere off screen.'}</p>;
  return (
    <div className="playtest-stage">
      <ProbeFrames />
      <ProbeNote status="live" />
    </div>
  );
}

function PlaytestPanel({ panel, sweepRunning }: { panel: Panel; sweepRunning: boolean }) {
  const { state } = panel;
  const chip = stateChip(state);
  const blurb = policyBlurb(panel.policy);

  return (
    <li className={`playtest-panel is-${state.kind}`}>
      <div className="playtest-panel-head">
        <h2 className="playtest-panel-name">{panel.policy}</h2>
        <span className={`playtest-chip tone-${chip.tone}`}>
          {state.kind === 'playing' && <span className="playtest-chip-dot" aria-hidden="true" />}
          {chip.label}
        </span>
      </div>
      {blurb !== null && <p className="playtest-blurb">{blurb}</p>}

      {state.kind === 'playing' && (
        <>
          <LiveStage sweepRunning={sweepRunning} />
          {/* Which seed it is on, but ONLY once a run of its own has come
              back. Before that the sweep has said nothing about this bot, and
              a count would be the app's inference wearing the sweep's voice. */}
          <p className="playtest-line">
            {state.certain && state.runCount > 0
              ? `Run ${state.runIndex + 1} of ${state.runCount}${state.seed !== null ? `, seed ${state.seed}` : ''}.`
              : 'The sweep has not reported a finished run for this one yet.'}
          </p>
        </>
      )}

      {state.kind === 'played' && (
        <>
          <div className="playtest-runs">
            {state.runs.map((run) => (
              <RunChip key={run.seed} run={run} />
            ))}
          </div>
          {panel.findings.length === 0 ? (
            <p className="playtest-line">Nothing found.</p>
          ) : (
            <FindingList findings={panel.findings} />
          )}
        </>
      )}

      {state.kind === 'skipped' && (
        <>
          <p className="playtest-reason">{state.reason}</p>
          {/* Said out loud when the answer is a forecast rather than a record.
              It comes from the same capability check the sweep runs, on the
              same declared capabilities, so it is right about everything that
              check decides, and the report is still the thing that confirms
              it, so the screen does not pretend otherwise. */}
          {state.source === 'plan' && (
            <p className="playtest-line">
              Read from what this game declares, before the sweep reached it. The sweep&rsquo;s own record settles it at
              the end.
            </p>
          )}
        </>
      )}

      {state.kind === 'waiting' && <p className="playtest-line">Waiting for the browser. It plays after the ones above.</p>}

      {state.kind === 'passed' && (
        <p className="playtest-line">
          {sweepRunning
            ? 'The sweep went past this one without running it. It says why when it finishes.'
            : 'The sweep went past this one without running it, and left no reason.'}
        </p>
      )}

      {state.kind === 'unasked' && <p className="playtest-line">This playtest did not ask for it.</p>}
    </li>
  );
}

export function PlaytestScreen() {
  const closeScreen = useApp((s) => s.closeScreen);
  const projectName = useApp((s) => s.projectName);
  const projectPath = useApp((s) => s.projectPath);
  const gamePresent = useApp((s) => s.game.present);
  const sweepRunning = useApp((s) => s.sweep.running);
  const { view, tried } = usePlaytest(projectPath, sweepRunning);

  // The same socket the pane opens, on the same terms: only while a sweep is
  // up, and only for the folder it is running in. Both surfaces can want it at
  // once (the pane is still mounted behind this on a narrow layout), which is
  // why probeStream.ts counts its watchers rather than closing on the first.
  useEffect(() => {
    if (!sweepRunning || !projectPath) return;
    openProbeStream(projectPath);
    return () => closeProbeStream();
  }, [sweepRunning, projectPath]);

  const panels = playtestPanels(view);
  const live = livePanel(panels);

  return (
    <div className="screen playtest-screen">
      <ScreenHeader
        back={{ label: playtestBackLabel(projectName, projectPath), onBack: closeScreen }}
        actions={<PlaytestButton />}
      />

      <div className="screen-body">
        <div className="playtest-page">
          <header className="playtest-masthead">
            <h1 className="playtest-heading">Playtesters</h1>
            <p className="playtest-lede">
              Bots that play your game. They share one browser, so they take turns, in this order.
            </p>
          </header>

          {!tried ? null : view === null || view.sweep === null ? (
            <div className="playtest-blank">
              <p className="playtest-blank-lead">No playtest has run in this folder yet.</p>
              <p className="playtest-blank-hint">
                {view !== null && view.known.length > 0
                  ? `Hearth has ${view.known.length}: ${view.known.join(', ')}. `
                  : ''}
                {gamePresent
                  ? 'Press Playtest and each one gets a panel here, with what it found or the reason it could not play.'
                  : 'There is no game in this folder yet. Once there is one to run, each bot gets a panel here.'}
              </p>
            </div>
          ) : (
            <>
              <p className="playtest-summary">{playtestSummary(view, panels)}</p>

              {/* An ordered list, because the order is the fact: this is the
                  queue the sweep works through, top to bottom. */}
              <ol className="playtest-list">
                {panels.map((panel) => (
                  <PlaytestPanel key={panel.policy} panel={panel} sweepRunning={sweepRunning && live >= 0} />
                ))}
              </ol>

              {view.sweep.findings.length > 0 && (
                <section className="playtest-extra">
                  <h2 className="playtest-extra-title">Not from any one bot</h2>
                  <p className="playtest-line">
                    The sweep checks the controls before the first bot plays. This is what that turned up.
                  </p>
                  <FindingList findings={view.sweep.findings} />
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
