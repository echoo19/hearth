/**
 * The conversation column's one strip of chrome: who is answering, and — in
 * terminal mode — where the shell is running.
 *
 * Choosing BETWEEN the two kinds of conversation is not done here: that pill
 * lives in the sidebar, next to everything else that decides what the main
 * area shows. What is left is a read-out, and it is deliberately thin — the
 * column belongs to what is being said in it.
 */
import React from 'react';
import { useApp } from '../../store';
import type { ChatDriverKind, ChatProviderStatus } from '../../types';
import { useAgentSocket } from '../agent/useAgentSocket';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { terminalStatusLabel } from './TerminalPane';

/**
 * Who is answering, in the name a user would use for it — not the driver's.
 * The server's `active` provider is the truth when it has been read; a bound
 * driver is the fallback, since it is proof by demonstration.
 */
export function providerLabel(providers: ChatProviderStatus | null, driver: ChatDriverKind | null): string {
  const active = providers?.active ?? null;
  if (active === 'anthropic') return 'Claude';
  if (active === 'openai') return 'ChatGPT';
  if (driver === 'agent-sdk') return 'Claude';
  if (driver === 'codex') return 'ChatGPT';
  return 'No agent';
}

/**
 * Terminal mode's contextual read-out: the folder the shell is in, how the
 * session is doing, and the one control that matters (stop it / start it
 * again). The folder name rather than the path — the path is a tooltip away,
 * and the name is the answer to "where am I?".
 */
function TerminalContext() {
  const { session, start, stop } = useAgentSocket();
  const connected = useApp((s) => s.wsStatus === 'connected');
  const projectName = useApp((s) => s.projectName);
  const projectPath = useApp((s) => s.projectPath);

  const live = session.status === 'running' || session.status === 'reconnecting';
  const status = terminalStatusLabel(session.status);

  return (
    <>
      <Tooltip content={projectPath ?? ''}>
        <span className={`terminal-cwd status-${session.status}`}>
          <span className="terminal-dot" aria-hidden="true" />
          <span className="terminal-cwd-name">{projectName ?? 'shell'}</span>
        </span>
      </Tooltip>
      {status && <span className="terminal-cwd-status">{status}</span>}
      {live ? (
        <Button size="sm" variant="ghost" onClick={stop}>
          Stop
        </Button>
      ) : (
        <Button size="sm" variant="ghost" disabled={!connected} onClick={() => start()}>
          Start
        </Button>
      )}
    </>
  );
}

export function ConversationHead() {
  const mode = useApp((s) => s.conversationMode);
  const providers = useApp((s) => s.providers);
  const driver = useApp((s) => s.chatDriver);

  return (
    <div className="conversation-head">
      {/* Chat mode's one read-out: which agent would answer. Same quiet
          register as the terminal's status — a label, not a control. */}
      {mode === 'chat' && <span className="conversation-provider">{providerLabel(providers, driver)}</span>}
      {mode === 'terminal' && <TerminalContext />}
    </div>
  );
}
