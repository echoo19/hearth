/**
 * The pane's two actions, along its bottom edge: play the game yourself, or
 * hand it to the probe.
 *
 * These are different acts — who is holding the controls — so they are
 * different controls and share no glyph. Play is the quiet one: it just gets
 * you to the game the way a player would meet it. Playtest gives the controls
 * away to something that is not you, which is the app's other primary action
 * (the composer being the first), so it is the second and last ember-filled
 * control in the window. While it runs it reports how far it has got, counted
 * from the same evidence stream the rail is filling with — there is no
 * separate progress to disagree with.
 *
 * The chip row that used to name what Hearth could see has gone. It was a
 * feature list wearing a status line's clothes: nothing was ever done in
 * response to it, and it competed for the eye with the two things here that
 * are actually actions.
 *
 * A "Playtesters" link sat between them for a while and has gone the same way.
 * It was navigation with nothing behind it until a sweep had run, and it asked
 * to be read on every glance at the game to say something only worth reading
 * afterwards. The per-bot breakdown is now reached from the sweep it describes,
 * down in the rail, where the reader is already looking at that sweep.
 */
import React from 'react';
import { useApp } from '../../store';
import { gameUrl } from '../../api';
import { Icon } from '../ui';
import { IconButton } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

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
  if (!opts.gamePresent) return 'Nothing to play yet. There is no game in this project.';
  if (opts.running) return 'A playtest is running. Results land in Playtests below.';
  return null;
}

/**
 * The button itself, so the strip and the Playtesters screen press the same
 * one. Two buttons that started the same sweep would eventually stop agreeing
 * about what it says while it runs.
 */
export function PlaytestButton() {
  const game = useApp((s) => s.game);
  const sweep = useApp((s) => s.sweep);
  const startSweep = useApp((s) => s.startSweep);
  const blocked = playtestBlockReason({ gamePresent: game.present, running: sweep.running });

  return (
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
        {/* A robot head, never the play triangle. The whole difference
            between this button and the one beside it is who is holding the
            controls, and that has to be legible before the label is read. */}
        {sweep.running ? <span className="playtest-spinner" aria-hidden="true" /> : <Icon name="bot" size={13} />}
        {playtestLabel(sweep)}
      </button>
    </Tooltip>
  );
}

export function CapabilityStrip() {
  const projectPath = useApp((s) => s.projectPath);
  const game = useApp((s) => s.game);
  const gameNonce = useApp((s) => s.gameNonce);
  const gamePresent = game.present;
  // Everything the URL needs, or nothing: an entry-less or folder-less game is
  // showing an empty state anyway, so there is nowhere to send the player.
  const playUrl = gamePresent && game.entry && projectPath ? gameUrl(projectPath, game.entry, gameNonce) : null;

  return (
    <div className="capability-strip">
      {/* Play means play — the game in a plain browser window, at the same
          localhost URL the pane is already serving. The pane's own iframe is
          sandboxed and letterboxed onto a stage, which is right for watching
          and wrong for playing: this hands over real keyboard focus, real
          fullscreen, the page a player would actually get.

          A ghost icon rather than a second filled button: two ember controls
          side by side would mean the strip has no primary action at all.

          `aria-label` is passed explicitly to override IconButton's default of
          reusing the tooltip text — the accessible name stays short while the
          hint is free to explain why the control is unavailable. */}
      <IconButton
        icon="play"
        size="sm"
        side="top"
        className="play-btn"
        label={
          playUrl
            ? 'Play it yourself in a browser window.'
            : 'Nothing to play yet. There is no game in this project.'
        }
        aria-label="Play the game"
        aria-disabled={playUrl === null}
        onClick={() => {
          // noopener/noreferrer: the game is untrusted code from whatever the
          // agent wrote, and a handle back to this window is not something it
          // needs in order to be played.
          if (playUrl) window.open(playUrl, '_blank', 'noopener,noreferrer');
        }}
      />

      <PlaytestButton />
    </div>
  );
}
