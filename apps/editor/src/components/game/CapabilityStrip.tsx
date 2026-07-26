/**
 * What Hearth can currently see of this game, along the pane's bottom edge.
 *
 * Any web game gives up preview, errors and screenshots for free. Entities and
 * events need the game to say something about itself, so they show as
 * available-but-off until it does — the strip is an honest capability
 * read-out, not a feature list.
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

export function CapabilityStrip() {
  const reported = useApp((s) => s.senses);
  const gamePresent = useApp((s) => s.game.present);
  const active = activeSenses(reported, gamePresent);

  return (
    <div className="capability-strip" role="group" aria-label="What Hearth can see">
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
  );
}
