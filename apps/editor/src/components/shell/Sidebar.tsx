/**
 * The left rail: what you've said, where you're saying it, and what this
 * Hearth can reach.
 *
 * Lists in the order they matter. Conversations in this folder come first —
 * they are the work — the folder itself sits underneath, because changing
 * folders is rare and reading back a conversation is not, and the harness
 * folds (Connectors, Skills — see harness/HarnessSections.tsx) sit last and
 * closed-able, because they are settings you visit, not work you do.
 *
 * Deliberately quiet: no counts, no badges, no icons per row. The only colour
 * is the mark at the top and whatever the active row needs to look active.
 * Collapsed, it keeps its actions and drops its lists, which is the honest
 * reduction — a list of conversations has nothing useful to say at 60px.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../../store';
import { apiRecentWorkspaces } from '../../api';
import type { ChatSummary, RecentWorkspace } from '../../types';
import { hearthNative } from '../../native';
import { HarnessSections } from '../../harness/HarnessSections';
import { ConfirmDialog, Icon } from '../ui';
import { IconButton } from '../ui/Button';
import { MenuButton } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';

/** Expanded / collapsed rail widths, mirrored in styles/app/sidebar.css. */
export const SIDEBAR_WIDTH_PX = 260;
export const SIDEBAR_RAIL_PX = 60;

/**
 * How long ago, in the fewest words that stay true. Pure so the thresholds are
 * testable without a clock: a list of conversations is scanned, not read, and
 * "3d" carries the whole answer.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * One conversation. The row is the button; rename happens in place (an input
 * where the title was) rather than in a dialog, because renaming a thing you
 * can see is not a decision that needs a modal.
 */
function ChatRow({
  chat,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  chat: ChatSummary;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  function commit(): void {
    setRenaming(false);
    const next = draft.trim();
    if (next !== '' && next !== chat.title) onRename(next);
    else setDraft(chat.title);
  }

  if (renaming) {
    return (
      <div className="chat-row is-renaming">
        <input
          ref={inputRef}
          className="input chat-rename"
          value={draft}
          aria-label="Conversation name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(chat.title);
              setRenaming(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`chat-row${active ? ' is-active' : ''}`}>
      <button type="button" className="chat-open" aria-current={active ? 'true' : undefined} onClick={onOpen}>
        <span className="chat-title">{chat.title}</span>
        <span className="chat-when">{relativeTime(chat.updatedAt)}</span>
      </button>
      <span className="chat-actions">
        <MenuButton
          label={`Conversation options — ${chat.title}`}
          align="right"
          triggerClassName="chat-more"
          trigger={<Icon name="overflow" />}
          items={[
            {
              label: 'Rename',
              icon: 'pencil',
              onSelect: () => {
                setDraft(chat.title);
                setRenaming(true);
              },
            },
            { label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete },
          ]}
        />
      </span>
    </div>
  );
}

export function Sidebar() {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const setCollapsed = useApp((s) => s.setSidebarCollapsed);
  const chats = useApp((s) => s.chats);
  const activeChatId = useApp((s) => s.activeChatId);
  const newChat = useApp((s) => s.newChat);
  const openChat = useApp((s) => s.openChat);
  const renameChat = useApp((s) => s.renameChat);
  const deleteChat = useApp((s) => s.deleteChat);
  const projectName = useApp((s) => s.projectName);
  const projectPath = useApp((s) => s.projectPath);
  const openWorkspace = useApp((s) => s.openWorkspace);
  const closeWorkspace = useApp((s) => s.closeWorkspace);
  const native = hearthNative();
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [pendingDelete, setPendingDelete] = useState<ChatSummary | null>(null);

  // Recents change when a folder is opened, which is exactly when this
  // component's project changes — so that is the only thing worth re-reading on.
  useEffect(() => {
    void apiRecentWorkspaces().then(setRecents);
  }, [projectPath]);

  const others = recents.filter((recent) => recent.path !== projectPath && recent.exists).slice(0, 4);

  return (
    <nav className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Conversations and folders">
      <div className="sidebar-head">
        <span className="sidebar-mark" aria-hidden="true">
          <Icon name="flame" size={16} />
        </span>
        <span className="sidebar-wordmark">Hearth</span>
        <IconButton
          icon="chevron"
          className={`sidebar-toggle${collapsed ? ' is-collapsed' : ''}`}
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          iconSize={13}
          onClick={() => setCollapsed(!collapsed)}
        />
      </div>

      <div className="sidebar-actions">
        {/* Collapsed, the glyph is all there is, so it needs the hint. Expanded,
            the label IS the hint and a tooltip would just repeat it. */}
        {collapsed ? (
          <IconButton bare icon="plus" label="New chat" side="right" iconSize={13} className="sidebar-new" onClick={newChat} />
        ) : (
          <button type="button" className="sidebar-new" onClick={newChat}>
            <span className="sidebar-new-glyph" aria-hidden="true">
              <Icon name="plus" size={13} />
            </span>
            <span className="sidebar-label">New chat</span>
          </button>
        )}
      </div>

      <div className="sidebar-scroll">
        <section className="sidebar-section" aria-label="Conversations">
          <h2 className="sidebar-section-title">Chats</h2>
          {chats.length === 0 ? (
            <p className="sidebar-empty">Nothing yet. Say something and it lands here.</p>
          ) : (
            <div className="chat-list">
              {chats.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  active={chat.id === activeChatId}
                  onOpen={() => openChat(chat.id)}
                  onRename={(title) => void renameChat(chat.id, title)}
                  onDelete={() => setPendingDelete(chat)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="sidebar-section" aria-label="Projects">
          <h2 className="sidebar-section-title">Projects</h2>
          <div className="folder-list">
            {projectPath && (
              <Tooltip content={projectPath}>
                <span className="folder-row is-current">
                  <span className="folder-name">{projectName}</span>
                  <span className="folder-note">open</span>
                </span>
              </Tooltip>
            )}
            {others.map((recent) => (
              <Tooltip key={recent.path} content={recent.path}>
                <button type="button" className="folder-row" onClick={() => void openWorkspace(recent.path)}>
                  <span className="folder-name">{recent.name}</span>
                </button>
              </Tooltip>
            ))}
            {native && (
              <button type="button" className="folder-row is-action" onClick={() => void pickAndOpen()}>
                <span className="folder-name">Open folder…</span>
              </button>
            )}
            {projectPath && (
              <button type="button" className="folder-row is-action" onClick={closeWorkspace}>
                <span className="folder-name">Close folder</span>
              </button>
            )}
          </div>
        </section>

        {/* What this Hearth can reach, and what it knows how to do. Secondary
            to the two lists above and folded away by whoever doesn't need it. */}
        <HarnessSections projectPath={projectPath} />
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete conversation"
        body={
          pendingDelete
            ? `“${pendingDelete.title}” and everything in it will be removed from this folder. This can't be undone.`
            : ''
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const chat = pendingDelete;
          setPendingDelete(null);
          if (chat) void deleteChat(chat.id);
        }}
      />
    </nav>
  );

  async function pickAndOpen(): Promise<void> {
    const picked = await native?.pickDirectory();
    if (picked) await openWorkspace(picked);
  }
}
