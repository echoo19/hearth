/**
 * The embedded shell, in the folder the agent is working in.
 *
 * It is the escape hatch and the bring-your-own-agent path at once: whatever
 * CLI the user prefers runs here, in the right directory, with `hearth` on
 * PATH. The pty itself outlives this component (server-side, and buffered in
 * useAgentSocket), so switching tabs never kills a running session.
 */
import React, { useEffect } from 'react';
import { useApp } from '../../store';
import { Terminal } from '../agent/Terminal';
import { useAgentSocket } from '../agent/useAgentSocket';
import { Button } from '../ui/Button';

export function TerminalTab() {
  const { session, start, stop, sendInput, sendResize } = useAgentSocket();
  const connected = useApp((s) => s.wsStatus === 'connected');

  // Start on first reveal, once there's a socket to start over. A session that
  // exited stays exited until the user restarts it — an auto-respawning shell
  // would hide a command that's failing on startup.
  useEffect(() => {
    if (connected && session.status === 'idle') start();
  }, [connected, session.status, start]);

  const live = session.status === 'running' || session.status === 'reconnecting';

  return (
    <div className="terminal-tab">
      <div className="terminal-bar">
        <span className={`terminal-status status-${session.status}`}>
          {session.status === 'reconnecting' ? 'Reconnecting' : session.status === 'running' ? 'Shell' : 'Stopped'}
        </span>
        <span className="terminal-bar-spacer" />
        {live ? (
          <Button size="sm" variant="ghost" onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={!connected} onClick={() => start()}>
            Start
          </Button>
        )}
      </div>
      {session.status === 'idle' ? (
        <div className="terminal-idle">
          <p>{connected ? 'Starting a shell…' : 'Waiting for the connection.'}</p>
        </div>
      ) : (
        <Terminal onData={sendInput} onResize={sendResize} />
      )}
    </div>
  );
}
