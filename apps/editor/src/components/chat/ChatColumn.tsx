/**
 * The primary column: the conversation, and the box you type in. Nothing
 * else — every other surface in the app is downstream of what gets said here.
 */
import React from 'react';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

export function ChatColumn() {
  return (
    <section className="chat-column" aria-label="Conversation">
      <MessageList />
      <Composer />
    </section>
  );
}
