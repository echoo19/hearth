/**
 * The conversation column's one strip of chrome: which kind of conversation
 * this is, and — in terminal mode — where it is running.
 *
 * The segmented control is the same primitive as the narrow-layout switch in
 * the top bar (`.switch-tab`), deliberately: this is a choice between two views
 * of one thing, which is what that control already means in this app. Nothing
 * else earns a place here — the column belongs to what is being said in it.
 */
import React from 'react';
import { useApp, type ConversationMode } from '../../store';
import type { ChatDriverKind, ChatProviderStatus } from '../../types';
import { useAgentSocket } from '../agent/useAgentSocket';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { terminalStatusLabel } from './TerminalPane';

const MODES: { id: ConversationMode; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
];

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
  const setMode = useApp((s) => s.setConversationMode);
  const providers = useApp((s) => s.providers);
  const driver = useApp((s) => s.chatDriver);

  return (
    <div className="conversation-head">
      <div className="conversation-switch" role="tablist" aria-label="Conversation mode">
        {MODES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="switch-tab"
            aria-selected={mode === entry.id}
            onClick={() => setMode(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <span className="conversation-head-spacer" />

      {/* Chat mode's one read-out: which agent would answer. Same quiet
          register as the terminal's status — a label, not a control. */}
      {mode === 'chat' && <span className="conversation-provider">{providerLabel(providers, driver)}</span>}
      {mode === 'terminal' && <TerminalContext />}
    </div>
  );
}
