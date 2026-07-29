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
import React, { useEffect } from 'react';
import { useApp } from '../../store';
import { hearthNative } from '../../native';
import { gameUrl } from '../../api';
import { Icon } from '../ui';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

/**
 * Silence the game.
 *
 * A game that loops music is a game playing music at you while you read the
 * agent's answer next to it, and the pane is on all the time. So the control
 * belongs here rather than in a settings screen: the moment it is wanted is
 * the moment the noise starts.
 *
 * It mutes the WINDOW, through Electron. That is not a shortcut, it is the
 * only thing that reaches: the game is served from a second loopback port so
 * it is deliberately cross-origin (see the sandbox note in GamePane), which
 * puts its document out of reach, and a game making its noise through WebAudio
 * has no media element to mute even in a frame you can touch. Chromium can
 * silence a whole webContents whatever the sound is made of, and the game is
 * the only thing in this window that makes one.
 *
 * Offered only where it works. Without the Electron preload there is no way to
 * mute a cross-origin frame at all, so the browser dev server shows no button
 * rather than one that lies.
 */
function MuteButton() {
  const muted = useApp((s) => s.gameMuted);
  const setGameMuted = useApp((s) => s.setGameMuted);
  const canMute = hearthNative()?.setAudioMuted !== undefined;

  // The stored preference is a fact about the person, but the mute itself is a
  // fact about a window that started unmuted. Re-asserted on mount, which is
  // also every time the pane is reopened, so a muted game cannot come back
  // making noise.
  useEffect(() => {
    if (canMute && muted) void hearthNative()?.setAudioMuted?.(true);
  }, [canMute, muted]);

  if (!canMute) return null;

  return (
    <Tooltip side="top" content={muted ? 'Unmute the game' : 'Mute the game'}>
      <button
        type="button"
        className="game-mute"
        // The state, not the action: a control that says "Mute" while the game
        // is already muted is a control you have to press to find out.
        aria-pressed={muted}
        aria-label={muted ? 'Game muted' : 'Game not muted'}
        onClick={() => setGameMuted(!muted)}
      >
        <Icon name={muted ? 'muted' : 'audio'} size={13} />
      </button>
    </Tooltip>
  );
}

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
      <MuteButton />
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
