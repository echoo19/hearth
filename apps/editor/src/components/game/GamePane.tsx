/**
 * The always-on game pane: whatever web game currently lives in the folder,
 * running, in an iframe, all the time.
 *
 * It is a localhost preview that happens to be permanently a game — so it has
 * exactly two states (nothing yet, and running) and no controls of its own.
 * The server tells it where the entry document is and when the files last
 * changed; a changed timestamp reloads the frame.
 */
import React, { useEffect } from 'react';
import { useApp, GAME_POLL_MS } from '../../store';
import { gameUrl } from '../../api';
import { CapabilityStrip } from './CapabilityStrip';

/**
 * Nothing to show yet. A soft preview frame rather than an illustration: the
 * shape of what will appear, so the pane reads as waiting rather than broken.
 */
function GameEmptyState() {
  return (
    <div className="game-empty">
      <div className="game-empty-frame" aria-hidden="true" />
      <p className="game-empty-lead">No game to show yet</p>
      <p className="game-empty-hint">Ask for one. It appears here the moment there is something to run.</p>
    </div>
  );
}

export function GamePane() {
  const projectPath = useApp((s) => s.projectPath);
  const game = useApp((s) => s.game);
  const gameNonce = useApp((s) => s.gameNonce);
  const refreshGame = useApp((s) => s.refreshGame);

  // Poll rather than push: the agent writes files through whatever toolchain
  // it likes, so there is no reliable "I finished" signal to subscribe to. A
  // stat of one folder every 1.5s is cheap and always right.
  useEffect(() => {
    if (!projectPath) return;
    const id = window.setInterval(() => void refreshGame(), GAME_POLL_MS);
    return () => window.clearInterval(id);
  }, [projectPath, refreshGame]);

  return (
    <div className="game-pane">
      {game.present && game.entry && projectPath ? (
        <iframe
          className="game-frame"
          title="Game preview"
          // The nonce is part of the key AND the URL: remounting guarantees a
          // clean document even for a game that installed global state, and
          // the query defeats any cached bytes.
          key={`${game.entry}#${gameNonce}`}
          src={gameUrl(projectPath, game.entry, gameNonce)}
          sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups allow-same-origin"
        />
      ) : (
        <GameEmptyState />
      )}
      <CapabilityStrip />
    </div>
  );
}
