/**
 * The conversation column's one strip of chrome: the way back to the project,
 * which kind of conversation this is, who is answering, and — in terminal mode
 * — where the shell is running.
 *
 * Everything here is a read-out or a way out; it is deliberately thin, because
 * the column belongs to what is being said in it.
 *
 * There used to be a Chat / Terminal switch here, and it was a lie: a
 * conversation is one or the other for its whole life (server/chatStore.ts
 * writes `kind` once, at creation), so flipping the column moved you to a
 * different surface without moving you to a different conversation. The choice
 * is made where it belongs now — when a conversation is STARTED: New chat and
 * New terminal, in the sidebar and on a project's own screen. A terminal opens
 * empty in the project folder and types nothing; what runs in it is whatever
 * you run. What is left here is the read-out that switch was pretending to be.
 */
import React from 'react';
import { activeProvider, useModelChoice } from '../../chat/modelChoice';
import { useApp, type ConversationMode } from '../../store';
import type { AgentChoice, ChatDriverKind, ChatProviderStatus } from '../../types';
import { useAgentSocket } from '../agent/useAgentSocket';
import { Icon } from '../ui';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { terminalStatusLabel } from './TerminalPane';

/**
 * Who is answering, in the name a user would use for it, not the driver's.
 *
 * Resolved through `activeProvider`, the SAME function the composer's pill and
 * the sidebar's account row use, because these three sit on one screen and
 * used to disagree on it. This strip read `providers.active` on its own, which
 * is the server's copy of the folder's settings, while the pill read the
 * standing choice. Pick a GPT model and the pill said GPT-5.4 while the strip
 * two inches above it still said Claude, and both were reporting something
 * true. One answer, read once.
 *
 * `providers.active` is still consulted for the one thing only it knows:
 * whether ANY agent can answer. Null there means nothing is set up, and naming
 * the merely-selected agent in that state would promise a reply that is not
 * coming. A bound driver outranks it, since it is proof by demonstration.
 *
 * `driver` is wider than ChatDriverKind ON PURPOSE. Transcripts written by
 * builds that still had registered agents carry `custom` (see the note on
 * ChatDriverKind in types.ts), and narrowing those to "No agent" told the
 * reader of a real conversation that nobody had answered it. Somebody did:
 * an agent of their own, under a door this app no longer has. The label says
 * that much and no more — the registry is gone, so the name is not here to
 * repeat, and inventing one would be worse than the vagueness.
 */
export function providerLabel(
  providers: ChatProviderStatus | null,
  driver: ChatDriverKind | (string & {}) | null,
  choice: AgentChoice | null = null,
): string {
  const active = providers
    ? providers.active === null
      ? null
      : activeProvider(choice, providers)
    : (choice?.provider ?? null);
  if (active === 'anthropic') return 'Claude';
  if (active === 'openai') return 'ChatGPT';
  if (driver === 'agent-sdk') return 'Claude';
  if (driver === 'codex') return 'ChatGPT';
  // Any bound driver this build does not recognise was a user's own agent,
  // recorded by a build that still let one register. Historical fact, honest
  // tense: it answered then, and it cannot be started again now.
  if (driver !== null && driver !== 'stub') return 'Custom agent (retired)';
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

/**
 * The way out of a conversation, back to the project it belongs to.
 *
 * A conversation is somewhere you go INTO — from the project's own screen,
 * from the rail — and until now the only way out was to find the project again
 * in the rail. The label is the project's name rather than "Back", for the
 * same reason a screen's header carries one: a way out is only useful if it
 * says where it comes out.
 *
 * It wears `.screen-back` (ui/ScreenHeader, styles/app/screen.css) rather than
 * inventing a second look. This strip is not a ScreenHeader — it is a mode
 * switch, so it has no three-slot grid to sit in — but the CONTROL is the same
 * control, and the app should have one back affordance, not two that nearly
 * match. `.conversation-back` adjusts only what this strip demands; see the
 * note in chat.css.
 */
function BackToProject() {
  const projectName = useApp((s) => s.projectName);
  const hasProject = useApp((s) => s.projectPath !== null);
  const showProject = useApp((s) => s.showProject);

  // No open project, no destination. Home's composer and a conversation with
  // no folder behind it must not sprout a control that leads nowhere.
  if (!hasProject) return null;

  // The name is set alongside the path on every open; the fallback is for the
  // instant between the two, and says the kind of place rather than guessing.
  const label = projectName ?? 'Project';

  return (
    <button
      type="button"
      className="screen-back conversation-back"
      // The visible label is the name on its own; a screen reader hearing only
      // "Ember" would not know it is a way out. Spoken name contains the
      // visible one, so voice control still finds it by what is printed.
      aria-label={`Back to ${label}`}
      onClick={showProject}
    >
      <Icon name="chevron" size={13} />
      <span className="conversation-back-name">{label}</span>
    </button>
  );
}

/**
 * What kind of conversation this is, in one word.
 *
 * A read-out, not a control, and it takes the slot the switch used to hold:
 * the fact is still worth stating (a shell and a transcript are different
 * enough that you want to know which one you are in before you type), but it
 * is a fact about the conversation rather than a setting on it. To have the
 * other kind, start one.
 */
export function conversationKindLabel(mode: ConversationMode): string {
  return mode === 'terminal' ? 'Terminal' : 'Chat';
}

export function ConversationHead() {
  const mode = useApp((s) => s.conversationMode);
  const providers = useApp((s) => s.providers);
  const driver = useApp((s) => s.chatDriver);
  const choice = useModelChoice();
  return (
    <div className="conversation-head">
      {/* Leaving first, on the left, the way it reads on every screen. */}
      <BackToProject />
      {/* Wears the same quiet label treatment as the read-outs beside it —
          this strip has one register, and everything in it is either a fact or
          a way out. */}
      <span className="conversation-provider conversation-kind">{conversationKindLabel(mode)}</span>
      {/* Chat mode's other read-out: which agent would answer. */}
      {mode === 'chat' && <span className="conversation-provider">{providerLabel(providers, driver, choice)}</span>}
      {mode === 'terminal' && <TerminalContext />}
    </div>
  );
}
