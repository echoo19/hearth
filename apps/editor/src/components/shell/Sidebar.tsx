/**
 * The left rail: how you start something, what you've said, where you said it,
 * and who this Hearth is signed in as.
 *
 * Top to bottom, in the order the day goes: a drag strip (which on macOS is
 * also where the traffic lights live), the Chat/Terminal switch, the two acts
 * that begin work — New chat, Open folder — then the lists you come back to
 * (Projects, then every conversation on the machine), then the harness folds,
 * and pinned at the bottom the two things that are about the app rather than
 * the work: an update waiting to install, and the account.
 *
 * Recents is GLOBAL. A conversation is the unit of work and which folder it
 * happens to live in is a detail; making someone reopen a project to remember
 * what they called something is the behaviour this list exists to delete.
 *
 * Collapsed it keeps its actions and drops its lists — the honest reduction, a
 * list of conversations has nothing useful to say at 60px.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../store';
import { apiRecentWorkspaces } from '../../api';
import type { ChatProviderStatus, RecentChatEntry, RecentWorkspace } from '../../types';
import { hearthNative } from '../../native';
import { HarnessSections } from '../../harness/HarnessSections';
import { SkillsSection } from '../../skills/SkillsSection';
import { ConfirmDialog, Icon } from '../ui';
import { IconButton } from '../ui/Button';
import { MenuButton, type MenuItem } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { useOpenFolder, useOpenFolderRequests } from './useOpenFolder';

/** Expanded / collapsed rail widths, mirrored in styles/app/sidebar.css. */
export const SIDEBAR_WIDTH_PX = 260;
export const SIDEBAR_RAIL_PX = 60;

/** How many other folders the Projects list shows before it stops. */
const MAX_OTHER_PROJECTS = 5;
/** How many conversations Recents shows unfiltered. */
const MAX_RECENT_CHATS = 20;

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
 * The search field's rule: case-insensitive substring, and an empty query
 * matches everything. Pure — the filter is the one part of search worth
 * pinning, and it must never quietly hide a row for a blank box.
 */
export function matchesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return text.toLowerCase().includes(needle);
}

/**
 * What Recents actually shows: the server's global list, with the open
 * folder's own conversations folded in.
 *
 * The fold-in is not redundancy. The global list is a snapshot taken on a
 * schedule, while the open folder's list arrives live on the socket — so a
 * chat created ten seconds ago exists only in the second one, and a rail that
 * waited for the next global read would look broken. Same id wins from the
 * folder (it is the fresher copy). Newest first, pure, no clock.
 */
export function mergeRecentChats(
  global: readonly RecentChatEntry[],
  folderChats: readonly { id: string; title: string; updatedAt: string }[],
  project: { path: string; name: string } | null,
): RecentChatEntry[] {
  const merged = new Map<string, RecentChatEntry>();
  for (const entry of global) merged.set(entry.id, entry);
  if (project) {
    for (const chat of folderChats) {
      merged.set(chat.id, { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, project });
    }
  }
  return [...merged.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Who the account row says you are. Pure: three fields, no guessing. */
export function accountIdentity(providers: ChatProviderStatus | null): {
  initials: string;
  name: string;
  status: string;
} {
  const openai = providers?.openai;
  const email = openai?.loggedIn ? openai.email : null;
  const local = email?.split('@')[0] ?? null;
  const status = openai?.loggedIn
    ? (openai.planType ?? 'Signed in')
    : providers?.anthropic.hasKey
      ? 'API key'
      : 'Not signed in';
  return {
    initials: (local?.[0] ?? 'H').toUpperCase(),
    name: local ?? 'Hearth',
    status,
  };
}

/**
 * One conversation. The row is the button; rename happens in place (an input
 * where the title was) rather than in a dialog, because renaming a thing you
 * can see is not a decision that needs a modal.
 *
 * A chat in a folder that isn't open offers no rename or delete: both write to
 * that folder's own index, and pretending otherwise would be the lie. Open it
 * and the actions are there.
 */
function ChatRow({
  entry,
  active,
  local,
  onOpen,
  onRename,
  onDelete,
}: {
  entry: RecentChatEntry;
  active: boolean;
  /** The chat lives in the folder that is currently open. */
  local: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(entry.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  function commit(): void {
    setRenaming(false);
    const next = draft.trim();
    if (next !== '' && next !== entry.title) onRename(next);
    else setDraft(entry.title);
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
              setDraft(entry.title);
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
        <span className="chat-title">{entry.title}</span>
        <span className="chat-when">{relativeTime(entry.updatedAt)}</span>
      </button>
      {local && (
        <span className="chat-actions">
          <MenuButton
            label={`Conversation options — ${entry.title}`}
            align="right"
            triggerClassName="chat-more"
            trigger={<Icon name="overflow" />}
            items={[
              {
                label: 'Rename',
                icon: 'pencil',
                onSelect: () => {
                  setDraft(entry.title);
                  setRenaming(true);
                },
              },
              { label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete },
            ]}
          />
        </span>
      )}
    </div>
  );
}

/** One nav row: an icon and a label, the same shape for every act. */
function NavRow({
  icon,
  label,
  collapsed,
  onClick,
}: {
  icon: string;
  label: string;
  collapsed: boolean;
  onClick: () => void;
}) {
  if (collapsed) {
    return <IconButton bare icon={icon} label={label} side="right" iconSize={14} className="nav-row is-icon" onClick={onClick} />;
  }
  return (
    <button type="button" className="nav-row" onClick={onClick}>
      <span className="nav-glyph" aria-hidden="true">
        <Icon name={icon} size={14} />
      </span>
      <span className="nav-label">{label}</span>
    </button>
  );
}

/**
 * The Chat / Terminal switch. It lives here rather than over the conversation
 * because it is a property of the whole window, and because the conversation's
 * own header should be about the conversation.
 *
 * Terminal without a folder is `aria-disabled`, not `disabled`: a real
 * `disabled` button takes no pointer or focus events, and the tooltip saying
 * WHY would never show — which is the whole reason it is here.
 */
function ModeSwitch() {
  const mode = useApp((s) => s.conversationMode);
  const setMode = useApp((s) => s.setConversationMode);
  const hasFolder = useApp((s) => s.projectPath !== null);

  const terminal = (
    <button
      type="button"
      role="tab"
      className="switch-tab"
      aria-selected={mode === 'terminal'}
      aria-disabled={hasFolder ? undefined : true}
      onClick={() => hasFolder && setMode('terminal')}
    >
      Terminal
    </button>
  );

  return (
    <div className="sidebar-switch" role="tablist" aria-label="Conversation mode">
      <button
        type="button"
        role="tab"
        className="switch-tab"
        aria-selected={mode === 'chat'}
        onClick={() => setMode('chat')}
      >
        Chat
      </button>
      {hasFolder ? terminal : <Tooltip content="Open a folder to use the terminal">{terminal}</Tooltip>}
    </div>
  );
}

/**
 * An update is downloaded and waiting. A card rather than a row: it is not
 * navigation, it is the one thing in the rail that asks for something.
 */
function UpdateBanner() {
  const updateReady = useApp((s) => s.updateReady);
  const relaunch = useApp((s) => s.relaunchToUpdate);
  if (!updateReady) return null;
  return (
    <div className="update-card">
      <span className="update-mark" aria-hidden="true">
        <Icon name="flame" size={14} />
      </span>
      <span className="update-text">
        <span className="update-lead">Relaunch to update</span>
        <span className="update-version">v{updateReady.version}</span>
      </span>
      <IconButton
        icon="chevron"
        label="Relaunch now"
        iconSize={13}
        className="update-go"
        onClick={() => void relaunch()}
      />
    </div>
  );
}

/** The account row: who is answering turns, and the ways to change that. */
function AccountRow({ collapsed }: { collapsed: boolean }) {
  const providers = useApp((s) => s.providers);
  const startOpenAiLogin = useApp((s) => s.startOpenAiLogin);
  const hasFolder = useApp((s) => s.projectPath !== null);
  const native = hearthNative();
  const identity = accountIdentity(providers);

  const items: MenuItem[] = [
    {
      label: 'Settings…',
      icon: 'gear',
      // A key is saved into the open folder's .hearth/app.json — with no
      // folder there is nowhere for the dialog to write, so it says that
      // rather than opening and silently refusing to save.
      disabled: !hasFolder,
      disabledReason: 'Open a folder — a key is saved per folder.',
      onSelect: () => window.dispatchEvent(new CustomEvent('hearth:open-settings')),
    },
  ];
  // Only offered where it can actually run: the flow shells out to the codex
  // binary, so without one installed this is a dead item.
  if (providers?.openai.installed && !providers.openai.loggedIn) {
    items.push({ label: 'Sign in to ChatGPT', icon: 'upload', onSelect: () => void startOpenAiLogin() });
  }
  if (native?.checkForUpdates) {
    items.push({ separator: true });
    items.push({ label: 'Check for updates…', icon: 'restart', onSelect: () => void native.checkForUpdates?.() });
  }

  return (
    <MenuButton
      label={`Account — ${identity.name}, ${identity.status}`}
      align="left"
      triggerClassName={`account-row${collapsed ? ' is-collapsed' : ''}`}
      items={items}
      trigger={
        <>
          <span className="account-avatar" aria-hidden="true">
            {identity.initials}
          </span>
          {!collapsed && (
            <>
              <span className="account-text">
                <span className="account-name">{identity.name}</span>
                <span className="account-status">{identity.status}</span>
              </span>
              <span className="account-chevron" aria-hidden="true">
                <Icon name="chevron" size={11} />
              </span>
            </>
          )}
        </>
      }
    />
  );
}

export function Sidebar() {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const setCollapsed = useApp((s) => s.setSidebarCollapsed);
  const chats = useApp((s) => s.chats);
  const recentChats = useApp((s) => s.recentChats);
  const activeChatId = useApp((s) => s.activeChatId);
  const newChat = useApp((s) => s.newChat);
  const openRecentChat = useApp((s) => s.openRecentChat);
  const renameChat = useApp((s) => s.renameChat);
  const deleteChat = useApp((s) => s.deleteChat);
  const projectName = useApp((s) => s.projectName);
  const projectPath = useApp((s) => s.projectPath);
  const openWorkspace = useApp((s) => s.openWorkspace);
  const closeWorkspace = useApp((s) => s.closeWorkspace);
  const native = hearthNative();
  const openFolder = useOpenFolder();
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [pendingDelete, setPendingDelete] = useState<RecentChatEntry | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // The rail is the one component always mounted, so it is the one that serves
  // the composer's "Open folder…" request.
  useOpenFolderRequests();

  // Recents change when a folder is opened, which is exactly when this
  // component's project changes — so that is the only thing worth re-reading on.
  useEffect(() => {
    void apiRecentWorkspaces().then(setRecents);
  }, [projectPath]);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  const project = useMemo(
    () => (projectPath ? { path: projectPath, name: projectName ?? projectPath } : null),
    [projectPath, projectName],
  );

  const conversations = useMemo(
    () => mergeRecentChats(recentChats, chats, project).filter((entry) => matchesQuery(entry.title, query)),
    [recentChats, chats, project, query],
  );

  const otherProjects = recents
    .filter((recent) => recent.path !== projectPath && recent.exists && matchesQuery(recent.name, query))
    .slice(0, MAX_OTHER_PROJECTS);

  const shown = query.trim() === '' ? conversations.slice(0, MAX_RECENT_CHATS) : conversations;

  return (
    <nav
      className={`sidebar${collapsed ? ' is-collapsed' : ''}`}
      aria-label="Conversations and folders"
      data-platform={native?.platform ?? 'web'}
    >
      {/* Drag strip. On macOS the window is frameless and the traffic lights
          are drawn INTO this area, so it also reserves the room they need;
          everywhere else it is just the grab handle. Children opt back out of
          dragging or they can't be clicked. */}
      <div className="sidebar-titlebar">
        {!collapsed && (
          <span className="sidebar-titlebar-actions">
            <IconButton
              icon="search"
              label={searching ? 'Hide search' : 'Search'}
              iconSize={13}
              className="titlebar-btn"
              onClick={() => {
                setSearching((open) => !open);
                if (searching) setQuery('');
              }}
            />
            <IconButton
              icon="chevron"
              className="titlebar-btn sidebar-toggle"
              label="Collapse sidebar"
              iconSize={13}
              onClick={() => setCollapsed(true)}
            />
          </span>
        )}
      </div>

      {collapsed && (
        <div className="sidebar-nav">
          <IconButton
            bare
            icon="chevron"
            label="Expand sidebar"
            side="right"
            iconSize={13}
            className="nav-row is-icon sidebar-expand"
            onClick={() => setCollapsed(false)}
          />
        </div>
      )}

      {!collapsed && searching && (
        <div className="sidebar-search">
          <input
            ref={searchRef}
            className="input"
            value={query}
            placeholder="Search chats and folders"
            aria-label="Search chats and folders"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.stopPropagation();
              setQuery('');
              setSearching(false);
            }}
          />
        </div>
      )}

      {!collapsed && (
        <div className="sidebar-modes">
          <ModeSwitch />
        </div>
      )}

      <div className="sidebar-nav">
        <NavRow icon="plus" label="New chat" collapsed={collapsed} onClick={newChat} />
        <NavRow icon="folder" label="Open folder…" collapsed={collapsed} onClick={() => void openFolder()} />
      </div>

      <div className="sidebar-scroll">
        <section className="sidebar-section" aria-label="Projects">
          <h2 className="sidebar-section-title">Projects</h2>
          <div className="folder-list">
            {projectPath && matchesQuery(projectName ?? projectPath, query) && (
              <div className="folder-row is-current">
                <Tooltip content={projectPath}>
                  <span className="folder-name">{projectName}</span>
                </Tooltip>
                <span className="folder-note">open</span>
                <span className="folder-actions">
                  <MenuButton
                    label={`Folder options — ${projectName ?? projectPath}`}
                    align="right"
                    triggerClassName="chat-more"
                    trigger={<Icon name="overflow" />}
                    items={[
                      ...(native
                        ? [
                            {
                              label: 'Reveal in Finder',
                              icon: 'folder',
                              onSelect: () => void native.revealInFolder(projectPath),
                            } as MenuItem,
                          ]
                        : []),
                      { label: 'Close folder', icon: 'close', onSelect: closeWorkspace },
                    ]}
                  />
                </span>
              </div>
            )}
            {otherProjects.map((recent) => (
              <div key={recent.path} className="folder-row">
                <Tooltip content={recent.path}>
                  <button type="button" className="folder-open" onClick={() => void openWorkspace(recent.path)}>
                    <span className="folder-name">{recent.name}</span>
                  </button>
                </Tooltip>
                {native && (
                  <span className="folder-actions">
                    <MenuButton
                      label={`Folder options — ${recent.name}`}
                      align="right"
                      triggerClassName="chat-more"
                      trigger={<Icon name="overflow" />}
                      items={[
                        { label: 'Reveal in Finder', icon: 'folder', onSelect: () => void native.revealInFolder(recent.path) },
                      ]}
                    />
                  </span>
                )}
              </div>
            ))}
            {!projectPath && otherProjects.length === 0 && (
              <p className="sidebar-empty">Folders you open show up here.</p>
            )}
          </div>
        </section>

        <section className="sidebar-section" aria-label="Recents">
          <h2 className="sidebar-section-title">Recents</h2>
          {shown.length === 0 ? (
            <p className="sidebar-empty">
              {query.trim() === '' ? 'Nothing yet. Say something and it lands here.' : 'Nothing matches that.'}
            </p>
          ) : (
            <div className="chat-list">
              {shown.map((entry) => (
                <ChatRow
                  key={entry.id}
                  entry={entry}
                  active={entry.id === activeChatId && entry.project.path === projectPath}
                  local={entry.project.path === projectPath}
                  onOpen={() => void openRecentChat(entry)}
                  onRename={(title) => void renameChat(entry.id, title)}
                  onDelete={() => setPendingDelete(entry)}
                />
              ))}
            </div>
          )}
        </section>

        {/* What this Hearth can reach, and what it knows how to do. Secondary
            to the two lists above and folded away by whoever doesn't need it. */}
        <HarnessSections projectPath={projectPath} />
        {/* Not inside HarnessSections: a skill belongs to the person, not to
            the folder, so it is listed with or without one open. */}
        <SkillsSection />
      </div>

      <div className="sidebar-foot">
        <UpdateBanner />
        <AccountRow collapsed={collapsed} />
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete conversation"
        body={
          pendingDelete
            ? `“${pendingDelete.title}” and everything in it will be removed from ${pendingDelete.project.name}. This can't be undone.`
            : ''
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const entry = pendingDelete;
          setPendingDelete(null);
          if (entry) void deleteChat(entry.id);
        }}
      />
    </nav>
  );
}
