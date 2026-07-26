/**
 * The app's one strip of chrome: which conversation is open, whether anything
 * is listening, and the two things that open over everything else (files and
 * settings).
 *
 * The folder — its name, its recents, closing it — moved to the sidebar, which
 * is where folders now live. What is left is state the sidebar cannot show:
 * the conversation you are IN, and whether typing into it will do anything.
 *
 * Deliberately thin — the conversation and the game are the app, and every
 * pixel this takes is one they don't get.
 */
import React from 'react';
import { anyChatProviderReady, useApp } from '../../store';
import { hearthNative } from '../../native';
import { Icon } from '../ui';
import { IconButton } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import type { ChatDriverKind } from '../../types';

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
 * What the app can currently do, as one short phrase. This is the top bar's
 * capability read-out: the honest answer to "is anything going to happen if I
 * type?", which is a different question from whether the socket is up.
 */
export function capabilityLabel(
  status: 'connected' | 'connecting' | 'disconnected',
  driver: ChatDriverKind | null,
  /**
   * Whether ANY agent could answer — a stored key, or a provider that is
   * signed in. Not just the Anthropic key: someone signed in with ChatGPT and
   * no key at all was being told "No agent connected" while the app was
   * perfectly able to answer them, which is the one thing this line exists to
   * get right.
   */
  ready: boolean,
): string {
  if (status !== 'connected') return connectionLabel(status);
  // Every real backend reads the same here on purpose: WHICH agent answered is
  // the conversation header's business, not the top bar's. This line answers
  // only "will anything happen if I type?".
  if (driver === 'agent-sdk' || driver === 'codex') return 'Agent connected';
  if (driver === 'stub') return 'No agent connected';
  return ready ? 'Ready' : 'No agent connected';
}

export function TopBar({ narrow }: { narrow: boolean }) {
  const projectPath = useApp((s) => s.projectPath);
  const hasFolder = projectPath !== null;
  const wsStatus = useApp((s) => s.wsStatus);
  const driver = useApp((s) => s.chatDriver);
  const ready = useApp((s) => anyChatProviderReady(s.settings, s.providers));
  const narrowTab = useApp((s) => s.narrowTab);
  const setNarrowTab = useApp((s) => s.setNarrowTab);
  const openCodePeek = useApp((s) => s.openCodePeek);
  const activeChatId = useApp((s) => s.activeChatId);
  const chats = useApp((s) => s.chats);
  const native = hearthNative();

  const capability = capabilityLabel(wsStatus, driver, ready);
  const chatTitle = chats.find((chat) => chat.id === activeChatId)?.title ?? 'New chat';

  // Home has nothing for this strip to name and nothing for it to open: no
  // conversation, no socket, no files, and settings are saved per folder. It
  // stays as the drag region and says nothing — an empty capability pill and a
  // Settings button that can't save would both be chrome about nothing.
  if (!hasFolder) {
    return (
      <header className="topbar is-empty">
        <span className="topbar-spacer" />
        {native && native.platform !== 'darwin' && <span className="topbar-window-controls" aria-hidden="true" />}
      </header>
    );
  }

  return (
    <header className="topbar">
      <Tooltip content={projectPath ?? ''}>
        <span className="topbar-name">{chatTitle}</span>
      </Tooltip>

      <span className={`topbar-capability status-${wsStatus}`}>
        <span className="capability-dot" aria-hidden="true" />
        {capability}
      </span>

      {narrow && (
        <div className="topbar-switch" role="tablist" aria-label="Layout">
          {(
            [
              ['chat', 'Conversation'],
              ['pane', 'Game'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="switch-tab"
              aria-selected={narrowTab === id}
              onClick={() => setNarrowTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <span className="topbar-spacer" />

      <IconButton icon="folder" label="Files" iconSize={15} onClick={() => openCodePeek()} />
      <IconButton
        icon="gear"
        label="Settings"
        iconSize={15}
        onClick={() => window.dispatchEvent(new CustomEvent('hearth:open-settings'))}
      />
      {/* Room for the window controls on platforms that overlay them. macOS
          draws them in the native title bar above this strip, so on that
          platform the reserve is zero. */}
      {native && native.platform !== 'darwin' && <span className="topbar-window-controls" aria-hidden="true" />}
    </header>
  );
}
