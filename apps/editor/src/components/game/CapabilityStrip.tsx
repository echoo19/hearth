/**
 * The pane's one action, along its bottom edge: play the game yourself.
 *
 * A Playtest button sat beside it for a while and has gone. Handing the
 * controls to the probe is something the agent does on its own account, from
 * the CLI, so there is nothing here for a user to press: no button, no
 * progress, no rail underneath waiting to be read.
 *
 * The chip row that used to name what Hearth could see has gone the same way.
 * It was a feature list wearing a status line's clothes: nothing was ever done
 * in response to it, and it competed for the eye with the one thing here that
 * is actually an action.
 */
import React from 'react';
import { useApp } from '../../store';
import { gameUrl } from '../../api';
import { IconButton } from '../ui/Button';

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
    </div>
  );
}
