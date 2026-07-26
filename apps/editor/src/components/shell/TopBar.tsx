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
import { useApp } from '../../store';
import { hearthNative } from '../../native';
import { Icon } from '../ui';
import { IconButton } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

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
  driver: 'stub' | 'agent-sdk' | null,
  hasKey: boolean,
): string {
  if (status !== 'connected') return connectionLabel(status);
  if (driver === 'agent-sdk') return 'Agent connected';
  if (driver === 'stub') return 'No agent connected';
  return hasKey ? 'Ready' : 'No agent connected';
}

export function TopBar({ narrow }: { narrow: boolean }) {
  const projectPath = useApp((s) => s.projectPath);
  const wsStatus = useApp((s) => s.wsStatus);
  const driver = useApp((s) => s.chatDriver);
  const hasKey = useApp((s) => s.settings?.hasKey === true);
  const narrowTab = useApp((s) => s.narrowTab);
  const setNarrowTab = useApp((s) => s.setNarrowTab);
  const openCodePeek = useApp((s) => s.openCodePeek);
  const activeChatId = useApp((s) => s.activeChatId);
  const chats = useApp((s) => s.chats);
  const native = hearthNative();

  const capability = capabilityLabel(wsStatus, driver, hasKey);
  const chatTitle = chats.find((chat) => chat.id === activeChatId)?.title ?? 'New chat';

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
