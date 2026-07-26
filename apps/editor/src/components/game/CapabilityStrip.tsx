/**
 * What Hearth can currently see of this game, and the one thing it can do with
 * it — along the pane's bottom edge.
 *
 * Any web game gives up preview, errors and screenshots for free. Entities,
 * events and scenes need the game to say something about itself, so they show
 * as available-but-off until the probe finds it does: the strip is an honest
 * capability read-out, not a feature list.
 *
 * Playtest is the app's other primary action (the composer being the first),
 * so it is the second and last ember-filled control in the window. While it
 * runs it reports how far it has got, counted from the same evidence stream
 * the rail is filling with — there is no separate progress to disagree with.
 */
import React from 'react';
import { useApp } from '../../store';
import type { Sense } from '../../types';
import { Tooltip } from '../ui/Tooltip';

interface SenseSpec {
  id: Sense;
  label: string;
  /** Why this sense is on, or what it would take to turn it on. */
  hint: string;
}

/** Every sense the strip can show, in the order it shows them. */
export const SENSES: SenseSpec[] = [
  { id: 'preview', label: 'Preview', hint: 'The game is running here.' },
  { id: 'errors', label: 'Errors', hint: 'Crashes and console errors are captured while it runs.' },
  { id: 'screenshots', label: 'Shots', hint: 'Frames can be captured from the running game.' },
  { id: 'entities', label: 'Entities', hint: 'Needs the game to expose its objects.' },
  { id: 'events', label: 'Events', hint: 'Needs the game to report what happens.' },
  { id: 'scenes', label: 'Scenes', hint: 'Needs the game to report which scene it is in.' },
];

/**
 * Senses a plain web game gives up with no cooperation at all. Reported by the
 * server too, but pinned here so the strip is never empty while the first
 * status request is in flight.
 */
export const ZERO_COOPERATION_SENSES: Sense[] = ['preview', 'errors', 'screenshots'];

/** Which senses to light, given what the server reported and whether a game exists. */
export function activeSenses(reported: Sense[], gamePresent: boolean): Set<Sense> {
  if (!gamePresent) return new Set();
  return new Set<Sense>([...ZERO_COOPERATION_SENSES, ...reported]);
}

/**
 * What the Playtest button says. Pure, so the progress contract is testable:
 * it must never claim a denominator it doesn't have yet (the sweep declares
 * one on its first journal line, not on the button press).
 */
export function playtestLabel(sweep: { running: boolean; done: number; total: number | null }): string {
  if (!sweep.running) return 'Playtest';
  if (sweep.total && sweep.total > 0) return `Playing ${Math.min(sweep.done, sweep.total)}/${sweep.total}`;
  return 'Playing…';
}

/** Why Playtest can't run right now, or null when it can. */
export function playtestBlockReason(opts: { gamePresent: boolean; running: boolean }): string | null {
  if (!opts.gamePresent) return 'Nothing to play yet — there is no game in this folder.';
  if (opts.running) return 'A playtest is running. Results land in Playtests below.';
  return null;
}

export function CapabilityStrip() {
  const reported = useApp((s) => s.senses);
  const gamePresent = useApp((s) => s.game.present);
  const sweep = useApp((s) => s.sweep);
  const startSweep = useApp((s) => s.startSweep);
  const active = activeSenses(reported, gamePresent);
  const blocked = playtestBlockReason({ gamePresent, running: sweep.running });

  return (
    <div className="capability-strip">
      {/* The read-out scrolls when the pane is narrow; the action never does.
          A primary action that can be scrolled out of reach is not one. */}
      <div className="capability-senses" role="group" aria-label="What Hearth can see">
        {SENSES.map((sense) => {
          const on = active.has(sense.id);
          return (
            <Tooltip key={sense.id} content={on ? sense.hint : `Not available. ${sense.hint}`} side="top">
              {/* Focusable so the hint is reachable by keyboard too — the chips
                  describe state, they don't do anything, so they are not
                  buttons. */}
              <span className={`sense-chip${on ? ' is-on' : ''}`} tabIndex={0}>
                <span className="sense-dot" aria-hidden="true" />
                {sense.label}
              </span>
            </Tooltip>
          );
        })}
      </div>

      <Tooltip content={blocked ?? 'Play the game many ways and write down what happened.'} side="top">
        {/* aria-disabled, not the `disabled` attribute: a natively disabled
            button dispatches no pointer events, so the tooltip explaining WHY
            it is unavailable would never show — the exact failure the Menu
            primitive's disabledReason path solves the same way. */}
        <button
          type="button"
          className={`playtest-btn${sweep.running ? ' is-running' : ''}`}
          aria-disabled={blocked !== null}
          onClick={() => {
            if (blocked === null) void startSweep();
          }}
        >
          {sweep.running ? (
            <span className="playtest-spinner" aria-hidden="true" />
          ) : (
            <span className="playtest-glyph" aria-hidden="true" />
          )}
          {playtestLabel(sweep)}
        </button>
      </Tooltip>
    </div>
  );
}
