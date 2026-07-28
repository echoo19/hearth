/**
 * A project's own screen.
 *
 * This is what clicking a project lands on, and it exists because a project is
 * not a conversation. It holds many — dropping straight into the most recent
 * one made the other twelve invisible and left the project itself with nowhere
 * to be addressed: no name to edit, no instructions, no context, no way back.
 *
 * Left is the work: what this game is, a composer that starts the next
 * conversation in it, and every conversation it already has. Right is what the
 * agent brings to all of them — standing instructions, and the files it should
 * have read. The split is the point: the left column changes every session,
 * the right column is the thing that makes the left column good.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { conversationKind, useApp } from '../../store';
import { Composer } from '../chat/Composer';
import { ProjectMark } from '../../projects/ProjectMark';
// The rail lists conversations too, and the two lists must mark a chat and a
// terminal session the same way or the mark teaches nothing.
import { CONVERSATION_KIND_ICON, CONVERSATION_KIND_LABEL, relativeTime } from '../shell/Sidebar';
import { Icon } from '../ui';
import { IconButton } from '../ui/Button';
import { MenuButton } from '../ui/Menu';
import { ProjectInstructions } from './ProjectInstructions';
import { ProjectContext } from './ProjectContext';
import type { ChatSummary, RecentWorkspace } from '../../types';

/**
 * Which conversations belong to which kind. Terminal sessions and chats are
 * both conversations with an agent, but they are not the same kind of record
 * and a single flat list makes you read every title to find the one you meant.
 *
 * Pure, and it reads the record's own `kind` — this used to read a field the
 * summary did not have, through a cast that hid it, which is why the Terminal
 * group was permanently empty. A record written before kinds existed answers
 * 'chat' (see conversationKind), so nothing is ever dropped.
 */
export function groupChats(chats: readonly ChatSummary[]): {
  chat: ChatSummary[];
  terminal: ChatSummary[];
} {
  const groups: { chat: ChatSummary[]; terminal: ChatSummary[] } = { chat: [], terminal: [] };
  for (const chat of chats) groups[conversationKind(chat)].push(chat);
  return groups;
}

/**
 * One conversation in the project's list.
 *
 * The glyph says which kind it is at a glance; the group heading above says it
 * in words, and the glyph carries its own name for anyone not reading the
 * page in order.
 */
function ChatLine({ chat, onOpen }: { chat: ChatSummary; onOpen: () => void }) {
  const kind = conversationKind(chat);
  return (
    <button type="button" className="proj-chat" onClick={onOpen}>
      <span className="proj-chat-glyph" role="img" aria-label={CONVERSATION_KIND_LABEL[kind]}>
        <Icon name={CONVERSATION_KIND_ICON[kind]} size={13} />
      </span>
      <span className="proj-chat-title">{chat.title}</span>
      <span className="proj-chat-when">{relativeTime(chat.updatedAt)}</span>
    </button>
  );
}

export function ProjectHome() {
  const projectPath = useApp((s) => s.projectPath);
  const projectName = useApp((s) => s.projectName);
  const chats = useApp((s) => s.chats);
  const openChat = useApp((s) => s.openChat);
  const closeWorkspace = useApp((s) => s.closeWorkspace);
  const setComposeTarget = useApp((s) => s.setComposeTarget);
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);

  // The mark and the description come from the projects list rather than being
  // fetched again here — the rail has already read it, and two reads would
  // disagree for a moment every time one of them changed.
  useEffect(() => {
    void import('../../api').then(({ apiRecentWorkspaces }) => void apiRecentWorkspaces().then(setRecents));
  }, [projectPath]);

  // Everything this screen sends starts a conversation HERE.
  useEffect(() => {
    if (projectPath) setComposeTarget(projectPath);
  }, [projectPath, setComposeTarget]);

  const project = recents.find((row) => row.path === projectPath) ?? null;
  const groups = useMemo(() => groupChats(chats), [chats]);

  if (!projectPath) return null;

  return (
    <main className="proj" aria-label={projectName ?? 'Project'}>
      <div className="proj-scroll">
        <div className="proj-grid">
          <div className="proj-main">
            {/* There is no breadcrumb, on purpose. A "Projects /" crumb used to
                sit here, and clicking it called closeWorkspace() — which does
                not go to a list of projects (the app has no such screen; the
                rail IS the list) but shuts this one, drops its socket and
                leaves you on the blank composer. A control that names a place
                the app doesn't have and then does something else is worse than
                no control. Closing is a real act and keeps its own name, in the
                menu on the right of this header. */}
            <header className="proj-head">
              <ProjectMark path={projectPath} identity={project?.identity} size={22} className="proj-mark" />
              <h1 className="proj-title">{projectName}</h1>
              <span className="proj-head-actions">
                <MenuButton
                  label={projectName ? `Project options for ${projectName}` : 'Project options'}
                  align="right"
                  triggerClassName="chat-more"
                  trigger={<Icon name="overflow" />}
                  items={[{ label: 'Close project', icon: 'close', onSelect: closeWorkspace }]}
                />
              </span>
            </header>

            <Composer variant="project" />

            <section className="proj-list" aria-label="Conversations">
              {chats.length === 0 ? (
                <p className="proj-empty">
                  No conversations yet. Say what you want to make and the first one starts here.
                </p>
              ) : (
                <>
                  {groups.chat.length > 0 && (
                    <>
                      <h2 className="proj-list-title">Chats</h2>
                      {groups.chat.map((chat) => (
                        <ChatLine key={chat.id} chat={chat} onOpen={() => openChat(chat.id)} />
                      ))}
                    </>
                  )}
                  {/* Only shown once one exists — an empty "Terminal" heading
                      on every project would be a promise about a thing nobody
                      here has used. */}
                  {groups.terminal.length > 0 && (
                    <>
                      <h2 className="proj-list-title">Terminal</h2>
                      {groups.terminal.map((chat) => (
                        <ChatLine key={chat.id} chat={chat} onOpen={() => openChat(chat.id)} />
                      ))}
                    </>
                  )}
                </>
              )}
            </section>
          </div>

          <aside className="proj-side" aria-label="What the agent brings">
            <ProjectInstructions projectPath={projectPath} />
            <ProjectContext projectPath={projectPath} />
          </aside>
        </div>
      </div>
    </main>
  );
}
