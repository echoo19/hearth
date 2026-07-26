/**
 * The primary column: the conversation. Nothing else — every other surface in
 * the app is downstream of what gets said here.
 *
 * The conversation is either a chat with the built-in agent or a real shell
 * running the user's own CLI agent, chosen from the header. Both layers sit in
 * the same grid cell and cross-fade; the terminal is mounted lazily (nobody
 * gets a shell spawned for them until they ask for one) and then kept mounted
 * forever, hidden with CSS rather than unmounted, so flipping back to chat
 * never kills a live pty or loses its scrollback.
 */
import React, { useEffect, useState } from 'react';
import { useApp } from '../../store';
import { ConversationHead } from './ConversationHead';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { TerminalPane } from './TerminalPane';

export function ChatColumn() {
  const mode = useApp((s) => s.conversationMode);
  // Once shown, always mounted: this latch is what makes a mode flip a hide
  // rather than a teardown.
  const [terminalShown, setTerminalShown] = useState(mode === 'terminal');

  useEffect(() => {
    if (mode === 'terminal') setTerminalShown(true);
  }, [mode]);

  return (
    <section className="chat-column" aria-label="Conversation" data-mode={mode}>
      <ConversationHead />
      <div className="conversation-stack">
        <div className="conversation-layer is-chat" data-active={mode === 'chat'} aria-hidden={mode !== 'chat'}>
          <MessageList />
          <Composer />
        </div>
        {terminalShown && (
          <div
            className="conversation-layer is-terminal"
            data-active={mode === 'terminal'}
            aria-hidden={mode !== 'terminal'}
          >
            <TerminalPane />
          </div>
        )}
      </div>
    </section>
  );
}
