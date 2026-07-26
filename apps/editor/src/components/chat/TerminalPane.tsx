/**
 * The conversation column, in terminal mode: a real shell in the project
 * folder, filling the column the way the transcript does in chat mode.
 *
 * This is a way to have the conversation, not an escape hatch from it —
 * whatever CLI agent the user prefers (`claude`, `codex`, anything) runs here,
 * in the right directory, with `hearth` on PATH, and everything downstream
 * (Playtest, the evidence rail, the game pane) works exactly the same.
 *
 * There is exactly ONE xterm instance in the app and it is this one: a second
 * view onto the same pty would double-render every byte. The pty itself
 * outlives this component (server-side, and buffered in useAgentSocket), and
 * the column keeps this component mounted once it has been shown, so flipping
 * back to chat hides a live session rather than killing it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../store';
import { Terminal } from '../agent/Terminal';
import { useAgentSocket, type AgentStatus } from '../agent/useAgentSocket';
import { IconButton } from '../ui/Button';

const HINT_KEY = 'hearth:terminalHintSeen';

/**
 * The first-run line. Shown once per install, because what it teaches — that
 * your own CLI agent is a first-class way to use Hearth — is learned once and
 * then permanently known.
 */
export const TERMINAL_HINT = 'Run claude, codex, or any CLI here — Playtest and evidence work the same.';

export function readTerminalHintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false; // private mode: showing the hint again is the kinder failure
  }
}

function writeTerminalHintSeen(): void {
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* private mode: the hint just comes back next time */
  }
}

/**
 * The session state as one short word for the column header. Only ever shown
 * when it is NOT simply running — a healthy shell says nothing, it just works.
 */
export function terminalStatusLabel(status: AgentStatus): string | null {
  switch (status) {
    case 'reconnecting':
      return 'Reconnecting';
    case 'exited':
      return 'Stopped';
    case 'idle':
      return 'Starting';
    default:
      return null;
  }
}

export function TerminalPane() {
  const { session, start, sendInput, sendResize } = useAgentSocket();
  const connected = useApp((s) => s.wsStatus === 'connected');
  const [hintSeen, setHintSeen] = useState(readTerminalHintSeen);

  // Start on first reveal, once there's a socket to start over. A session that
  // exited stays exited until the user restarts it — an auto-respawning shell
  // would hide a command that's failing on startup.
  useEffect(() => {
    if (connected && session.status === 'idle') start();
  }, [connected, session.status, start]);

  const dismissHint = useCallback(() => {
    writeTerminalHintSeen();
    setHintSeen(true);
  }, []);

  // Typing IS the acknowledgement — someone who has started using the shell has
  // read the line about it, and a hint that outlives its usefulness is clutter.
  const onData = useCallback(
    (data: string) => {
      dismissHint();
      sendInput(data);
    },
    [dismissHint, sendInput],
  );

  return (
    <div className="terminal-pane">
      {!hintSeen && (
        <p className="terminal-hint">
          <span className="terminal-hint-text">
            Run <code>claude</code>, <code>codex</code>, or any CLI here — Playtest and evidence work the same.
          </span>
          <IconButton
            bare
            icon="cross"
            label="Dismiss"
            iconSize={9}
            className="terminal-hint-dismiss"
            onClick={dismissHint}
          />
        </p>
      )}
      {session.status === 'idle' ? (
        <div className="terminal-idle">
          <p>{connected ? 'Starting a shell…' : 'Waiting for the connection.'}</p>
        </div>
      ) : (
        <Terminal onData={onData} onResize={sendResize} />
      )}
    </div>
  );
}
