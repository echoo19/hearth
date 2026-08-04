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
import { PublishDialog } from '../publish/PublishDialog';
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
  // Owned here rather than at the shell, unlike ProjectNamer: nothing else in
  // the app asks to publish, so there is no second caller for the two to drift
  // apart from. `.topbar > *` already opts every child out of the drag region,
  // so the dialog is clickable where it sits.
  const [publishOpen, setPublishOpen] = useState(false);

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
    // Skills and Tester have a header of their own directly under this, so the
    // strip collapses rather than stacking a second empty one over it. Home
    // has no such header, so it keeps the strip as its drag region.
    const screen = place === 'skills' || place === 'tester';
    return (
      <header className={screen ? 'topbar is-empty is-screen' : 'topbar is-empty'}>
        <span className="topbar-spacer" />
        {native && native.platform !== 'darwin' && <span className="topbar-window-controls" aria-hidden="true" />}
      </header>
    );
  }

  return (
    <header className="topbar">
      {/* The tooltip answers the question the hover asked, which it did not
          used to. What this strip truncates is the TITLE: `.topbar-name` caps
          at 34ch, and a generated title routinely runs past it (measured at a
          500px window, "Fix the double jump so it feels less floaty at the
          apex" wanted 300px and got 174, so 126px of it was behind the
          ellipsis). The tooltip said the project PATH, so the one gesture for
          reading the cut-off name answered with a filesystem location instead.

          Both, title first, rather than swapping one missing answer for
          another: the top bar is the only place in a conversation that states
          the path at all, and the separator is the one the window title
          already uses. */}
      {chatTitle !== '' && (
        <Tooltip content={projectPath === null ? chatTitle : `${chatTitle} · ${projectPath}`}>
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

      {/* Publishing is a thing you do to THIS folder's game, which is why it
          is up here with the rest of the project's chrome and not in Settings
          — Settings is the account, and the account is not what gets
          published. It sits inboard of the playtest toggle so that the toggle
          keeps the edge position it has always had; the frequent control does
          not move to make room for the rare one.

          Quiet, like everything else on this strip. A game worth publishing is
          published a handful of times, and a louder affordance would be
          spending the conversation's space on it every minute in between. */}
      <IconButton
        // `upload` rather than `export`: the export glyph is already the
        // Export-game action, and one picture meaning two verbs on one strip
        // is the confusion the `column` note below is about.
        icon="upload"
        label="Publish to the catalog"
        iconSize={13}
        onClick={() => setPublishOpen(true)}
      />
      <PublishDialog open={publishOpen} onClose={() => setPublishOpen(false)} />

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
