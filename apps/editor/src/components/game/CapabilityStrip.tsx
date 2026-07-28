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
import { Icon } from '../ui';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

export function CapabilityStrip() {
  const projectPath = useApp((s) => s.projectPath);
  const game = useApp((s) => s.game);
  const gameNonce = useApp((s) => s.gameNonce);
  const gamePresent = game.present;
  // The loopback origin the game is served from, learned from /api/meta. Play
  // opens the same URL the pane frames, so it needs the same origin.
  const gameOrigin = useApp((s) => s.meta?.gameOrigin ?? null);
  // Everything the URL needs, or nothing: an entry-less, folder-less, or
  // originless game is showing an empty state anyway, so there is nowhere to
  // send the player.
  const playUrl =
    gamePresent && game.entry && projectPath && gameOrigin
      ? gameUrl(gameOrigin, projectPath, game.entry, gameNonce)
      : null;

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
      <Tooltip
        side="top"
        content={
          playUrl
            ? 'Play it yourself in a browser window.'
            : 'Nothing to play yet. There is no game in this project.'
        }
      >
        {/* Filled, and the only filled control on this side of the window.
            It was a ghost icon while Playtest was the ember one beside it, and
            two filled controls would have meant the pane had no primary action
            at all. Playtest has gone, so the weight is free and this is what it
            was being saved for.

            aria-disabled rather than `disabled`: a natively disabled button
            dispatches no pointer events, so the tooltip explaining WHY it is
            unavailable would never appear. */}
        <Button
          variant="primary"
          className="play-btn"
          aria-label="Play the game"
          aria-disabled={playUrl === null}
          onClick={() => {
            // noopener/noreferrer: the game is untrusted code from whatever the
            // agent wrote, and a handle back to this window is not something it
            // needs in order to be played.
            if (playUrl) window.open(playUrl, '_blank', 'noopener,noreferrer');
          }}
        >
          <Icon name="play" size={13} />
          Play
        </Button>
      </Tooltip>
    </div>
  );
}
