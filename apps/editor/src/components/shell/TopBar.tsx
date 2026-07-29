/**
 * The app's one strip of chrome: which conversation is open, whether anything
 * is listening, and whether the game is beside it.
 *
 * The folder — its name, its recents, closing it — moved to the sidebar, which
 * is where folders now live. What is left is state the sidebar cannot show:
 * the conversation you are IN, and whether typing into it will do anything.
 *
 * There is no Files button. A file browser is not something anyone opens for
 * its own sake — every time it is genuinely wanted, it is wanted for a
 * specific file, and those all have their own way in (a file-change card, a
 * tool row, a console link, ⌘P).
 *
 * Deliberately thin — the conversation and the game are the app, and every
 * pixel this takes is one they don't get.
 */
import React, { useEffect, useState } from 'react';
import { anyChatProviderReady, globalPlace, useApp } from '../../store';
import { hearthNative } from '../../native';
import { IconButton } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { Tooltip } from '../ui/Tooltip';
import type { ChatDriverKind } from '../../types';

/**
 * How long a connection may be away before the strip mentions it. Long enough
 * that a reconnect nobody noticed stays unmentioned, short enough that someone
 * staring at a dead app is not left guessing.
 */
const RECONNECT_GRACE_MS = 1600;

/** Human label for the connection state, used as the dot's accessible name. */
export function connectionLabel(status: 'connected' | 'connecting' | 'disconnected'): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    default:
      return 'Disconnected';
  }
}

/**
 * What the app has to say about itself right now — which, when everything is
 * working, is nothing.
 *
 * This used to read "Ready" or "Agent connected" whenever things were fine.
 * That is the app congratulating itself for functioning, and it backfires: a
 * tool that keeps announcing it is connected invites the reader to wonder how
 * often it isn't. A localhost socket that is up is not news. Silence is the
 * correct resting state, and it makes the two states that ARE news impossible
 * to miss.
 *
 * `slow` is what stops the strip flickering on every reconnect. A socket that
 * drops and comes back inside a second is not something the reader has to
 * know about — narrating it would recreate exactly the problem this removes.
 * Only a wait long enough to be felt gets a word.
 *
 * Returns null when there is nothing worth saying.
 */
export function capabilityLabel(
  status: 'connected' | 'connecting' | 'disconnected',
  driver: ChatDriverKind | null,
  /**
   * Whether ANY agent could answer — a stored key, or a provider that is
   * signed in. Not just the Anthropic key: someone signed in with ChatGPT and
   * no key at all was being told "No agent connected" while the app was
   * perfectly able to answer them.
   */
  ready: boolean,
  /** The connection has been down long enough to be worth reporting. */
  slow = false,
): string | null {
  if (status !== 'connected') return slow ? connectionLabel(status) : null;
  // Connected, but nothing on the other end that could answer a turn. This one
  // stays: it is the difference between "typing will work" and "typing will
  // do nothing", and it is the reader's to fix.
  if (driver === 'stub') return 'No agent connected';
  if (driver === 'agent-sdk' || driver === 'codex') return null;
  return ready ? null : 'No agent connected';
}

/**
 * True once the connection has been unavailable for `graceMs` without
 * recovering. Resets the moment it comes back, so a blip never gets a word.
 */
export function useSlowConnection(
  status: 'connected' | 'connecting' | 'disconnected',
  graceMs = RECONNECT_GRACE_MS,
): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (status === 'connected') {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), graceMs);
    return () => clearTimeout(timer);
  }, [status, graceMs]);
  return slow;
}

export function TopBar({ narrow, paneOpen = false }: { narrow: boolean; paneOpen?: boolean }) {
  const projectPath = useApp((s) => s.projectPath);
  const hasFolder = projectPath !== null;
  const wsStatus = useApp((s) => s.wsStatus);
  const driver = useApp((s) => s.chatDriver);
  const ready = useApp((s) => anyChatProviderReady(s.settings, s.providers));
  const narrowTab = useApp((s) => s.narrowTab);
  const setNarrowTab = useApp((s) => s.setNarrowTab);
  const setPaneOpen = useApp((s) => s.setPaneOpen);
  const activeChatId = useApp((s) => s.activeChatId);
  const composing = useApp((s) => s.composing);
  const projectView = useApp((s) => s.projectView);
  const chats = useApp((s) => s.chats);
  // Where the app is standing, the one answer the whole window shares. See
  // `globalPlace`: New chat, Skills and Tester belong to the person, not to
  // the folder that is still open underneath them.
  const place = useApp((s) => globalPlace(s));
  const native = hearthNative();

  const slow = useSlowConnection(wsStatus);
  const capability = capabilityLabel(wsStatus, driver, ready, slow);
  // While the blank surface is up there is no conversation to name yet, and
  // naming the last one makes the strip look like it never left it.
  const chatTitle = projectView
    ? // The project's own screen already carries its name, twice the size and
      // with its mark beside it. Repeating it up here would be chrome about
      // something the eye has already landed on.
      ''
    : composing
      ? 'New chat'
      : (chats.find((chat) => chat.id === activeChatId)?.title ?? 'New chat');

  // Home has nothing for this strip to name and nothing for it to open: no
  // conversation, no socket, no files. It stays as the drag region and says
  // nothing — an empty capability pill would be chrome about nothing.
  //
  // Skills and Tester are the same case for a different reason. They take the
  // whole working area and carry their own header, so everything this strip
  // has to offer is about a surface that is not on screen: it named the
  // conversation underneath — the header saying one thing while the body
  // showed another — and its controls moved a column nobody could see.
  if (!hasFolder || place === 'skills' || place === 'tester') {
    return (
      <header className="topbar is-empty">
        <span className="topbar-spacer" />
        {native && native.platform !== 'darwin' && <span className="topbar-window-controls" aria-hidden="true" />}
      </header>
    );
  }

  return (
    <header className="topbar">
      {chatTitle !== '' && (
        <Tooltip content={projectPath ?? ''}>
          <span className="topbar-name">{chatTitle}</span>
        </Tooltip>
      )}

      {/* Absent entirely when there is nothing wrong. An empty pill sitting
          there would be the same claim in a quieter voice, and it would still
          take the space that the conversation's own name should have. */}
      {capability !== null && (
        <span className={`topbar-capability status-${wsStatus}`} role="status">
          <span className="capability-dot" aria-hidden="true" />
          {capability}
        </span>
      )}

      {/* Both of these move the playtest column, and the blank new-chat
          surface does not have one: it takes the whole working area the same
          way a screen does. They used to be offered anyway, so pressing Show
          playtest on New chat set a flag and changed nothing on screen. */}
      {narrow && paneOpen && place === null && (
        <Switch
          label="Conversation or game"
          className="topbar-switch"
          value={narrowTab}
          onChange={setNarrowTab}
          options={[
            { id: 'chat', label: 'Conversation' },
            { id: 'pane', label: 'Game' },
          ]}
        />
      )}

      <span className="topbar-spacer" />

      {/* The one control for the playtest column. It reads as a toggle rather
          than as a link to a place, because that is what it is — the column is
          part of this window, not somewhere else. */}
      {place === null && (
        <IconButton
          // Not `play`. This shows and hides a column; it does not start
          // anything. `play` means "run my game" on the capability strip and
          // "have the tester play a session" on the tester, and one glyph
          // cannot mean a verb in two places and a layout toggle in a third.
          icon="column"
          label={paneOpen ? 'Hide playtest' : 'Show playtest'}
          iconSize={13}
          aria-pressed={paneOpen}
          onClick={() => setPaneOpen(!paneOpen)}
        />
      )}
      {/* There is no Settings button here. Settings belong to the account, and
          the account row at the foot of the sidebar already opens them (along
          with ⌘,) — a second door to the same room only makes the reader
          wonder whether the two lead somewhere different. */}
      {/* Room for the window controls on platforms that overlay them. macOS
          draws them in the native title bar above this strip, so on that
          platform the reserve is zero. */}
      {native && native.platform !== 'darwin' && <span className="topbar-window-controls" aria-hidden="true" />}
    </header>
  );
}
