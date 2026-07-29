/**
 * The left rail: how you start something, what you've made, what you've said,
 * and who this Hearth is signed in as.
 *
 * Top to bottom: a drag strip (which on macOS is also where the traffic lights
 * live), two general acts — New chat, Skills — then the two lists the app is
 * actually about, Projects and Chats, then what this machine can reach, and
 * pinned at the bottom an update waiting to install and the account.
 *
 * A project is a game is a folder, and the user only ever sees the first of
 * those three words. Every project carries a mark — a glyph in its own colour,
 * derived from its path until someone picks otherwise — because a list of six
 * games is otherwise six near-identical strings. Starting another one is
 * offered on that list's own heading rather than as a third general act: it
 * belongs to Projects, and the two acts above stay two.
 *
 * Chats is GLOBAL, which is why each row wears its project's mark: a
 * conversation is the unit of work and which game it belongs to is the first
 * thing you need to know about it, but not a reason to make you go and look.
 *
 * Collapsed it keeps its actions and drops its lists — the honest reduction, a
 * list of conversations has nothing useful to say at 60px.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { conversationKind, globalPlace, useApp } from '../../store';
import { apiRecentWorkspaces, apiSetProjectIdentity } from '../../api';
import type { ChatKind, ChatProviderStatus, ProjectIdentity, RecentChatEntry, RecentWorkspace } from '../../types';
import { hearthNative } from '../../native';
import { ProjectMark } from '../../projects/ProjectMark';
import { IdentityPicker } from '../../projects/IdentityPicker';
import { ConfirmDialog, Icon } from '../ui';
import { IconButton } from '../ui/Button';
import { MenuButton, type MenuItem } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { useOpenFolderRequests } from './useOpenFolder';
import { FOCUS_SEARCH_EVENT } from './ShortcutLayer';
import { SHORTCUTS, shortcutLabel } from '../../shortcuts';

/** Expanded / collapsed rail widths, mirrored in styles/app/sidebar.css. */
export const SIDEBAR_WIDTH_PX = 260;
export const SIDEBAR_RAIL_PX = 60;

/** How many projects the list shows before it stops, beyond the open one. */
const MAX_PROJECTS = 8;

/**
 * What to spread onto a region that is hidden right now: out of the tab order,
 * out of the accessibility tree, and unclickable, in one attribute.
 *
 * Written as an object because React 18's JSX types predate `inert`. The empty
 * string is the attribute's canonical present form; a boolean `true` would be
 * serialised as `inert="true"` and a boolean `false` as `inert="false"`, which
 * HTML reads as present either way.
 */
const INERT = { inert: '', 'aria-hidden': true } as unknown as React.HTMLAttributes<HTMLDivElement>;

/**
 * Hold a list still across re-reads.
 *
 * The server orders recents by last opened, so every time a project is opened
 * the whole list comes back in a different order. That is the right answer for
 * a "recent folders" menu and the wrong one for a rail you navigate by
 * position: a list that reshuffles every time you use it is a list you have to
 * re-read every time you use it.
 *
 * So the order settles the first time the rail sees a project and stays. Rows
 * already known keep the positions they had; anything genuinely new goes to
 * the front, where a project you just made is where you would look for it.
 * Rows that have gone are simply absent.
 *
 * Pure, so the rule is testable without a rail.
 */
export function stableOrder<T extends { path: string }>(rows: readonly T[], previous: readonly string[]): T[] {
  const rank = new Map(previous.map((path, index) => [path, index]));
  const known = rows.filter((row) => rank.has(row.path)).sort((a, b) => rank.get(a.path)! - rank.get(b.path)!);
  const fresh = rows.filter((row) => !rank.has(row.path));
  return [...fresh, ...known];
}
/** How many conversations the Chats list shows unfiltered. */
const MAX_RECENT_CHATS = 20;

/**
 * How a conversation's kind is drawn, wherever conversations are listed — the
 * rail's Chats list and the project screen's own list both import these, so a
 * terminal session looks the same in both places.
 *
 * `compose` (a pencil over a page) is the mark this app already uses for
 * "start writing", on the New chat row directly above the list; `script` (two
 * angle brackets) is what a shell looks like at 11px, and reusing it keeps the
 * icon set at one vocabulary rather than adding a near-duplicate.
 *
 * The label is not decoration: an icon on its own says nothing to a screen
 * reader, so every place these are used gives the glyph this name.
 */
export const CONVERSATION_KIND_ICON: Record<ChatKind, string> = {
  chat: 'compose',
  terminal: 'script',
};

export const CONVERSATION_KIND_LABEL: Record<ChatKind, string> = {
  chat: 'Chat',
  terminal: 'Terminal session',
};

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
  folderChats: readonly { id: string; title: string; updatedAt: string; kind?: ChatKind }[],
  project: { path: string; name: string } | null,
): RecentChatEntry[] {
  const merged = new Map<string, RecentChatEntry>();
  for (const entry of global) merged.set(entry.id, entry);
  if (project) {
    for (const chat of folderChats) {
      // The kind rides along with the fresher copy for the same reason the
      // title does: a terminal session started ten seconds ago must not sit in
      // the list looking like a chat until the next global read.
      merged.set(chat.id, {
        id: chat.id,
        title: chat.title,
        kind: conversationKind(chat),
        updatedAt: chat.updatedAt,
        project,
      });
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
 * Two marks lead the row, in this order: which game it belongs to, then
 * whether it is a chat or a terminal session. They sit together as one cluster
 * with the title starting after both, rather than one at each end — this list
 * is dense and scanned down its left edge, so the answers to "whose is it" and
 * "what is it" should arrive in the same glance, and the title's left edge
 * stays put whichever kind the row is.
 *
 * A chat in a folder that isn't open offers no rename or delete: both write to
 * that folder's own index, and pretending otherwise would be the lie. Open it
 * and the actions are there.
 */
function ChatRow({
  entry,
  active,
  local,
  identity,
  onOpen,
  onRename,
  onDelete,
}: {
  entry: RecentChatEntry;
  active: boolean;
  /** The chat lives in the project that is currently open. */
  local: boolean;
  /** What its project looks like, so the row can say which game it belongs to. */
  identity?: ProjectIdentity | null;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(entry.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const kind = conversationKind(entry);

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
        <span className="chat-marks">
          {/* The chat list spans every project on the machine, so without this
              the row cannot answer the first question anyone asks of it: which
              game is this one about. */}
          <ProjectMark path={entry.project.path} identity={identity} size={11} className="chat-mark" />
          {/* And the second question: is this something I said, or a shell I
              left running. Named, not just drawn — the list has no headings to
              carry the distinction the way the project screen's does. */}
          <span className="chat-kind" role="img" aria-label={CONVERSATION_KIND_LABEL[kind]}>
            <Icon name={CONVERSATION_KIND_ICON[kind]} size={11} />
          </span>
        </span>
        <span className="chat-title">{entry.title}</span>
        <span className="chat-when">{relativeTime(entry.updatedAt)}</span>
      </button>
      {local && (
        <span className="chat-actions">
          <MenuButton
            label={`Conversation options for ${entry.title}`}
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

/**
 * One project. A mark, a name, and the menu that changes both.
 *
 * The mark is the row's whole reason for existing in this shape: six games in
 * a list are six near-identical strings, and what makes one findable at a
 * glance is colour and silhouette, not the third word of its name.
 *
 * Customising happens inside the row's own menu rather than behind a dialog —
 * it is a small reversible visual choice, and it should be made while looking
 * at the list it changes.
 */
function ProjectRow({
  project,
  open,
  hasOpen,
  native,
  onOpen,
  onClose,
  onIdentity,
}: {
  project: RecentWorkspace;
  /** This project is where the app is standing. Drawn and announced. */
  open: boolean;
  /** This project's folder is the open one, wherever the app is standing. */
  hasOpen: boolean;
  native: ReturnType<typeof hearthNative>;
  onOpen: () => void;
  onClose: () => void;
  onIdentity: (patch: { icon?: string; color?: string }) => void;
}) {
  const items: MenuItem[] = [
    {
      label: 'Appearance',
      icon: 'star',
      // A flyout, not a dialog and not an inline panel: the menu stays up, so
      // the row being recoloured — and the rest of the list it has to be
      // distinct within — are both still on screen while you try colours.
      submenu: <IdentityPicker path={project.path} identity={project.identity} onChange={onIdentity} />,
      onSelect: () => {},
    },
    ...(native
      ? [{ label: 'Reveal in Finder', icon: 'folder', onSelect: () => void native.revealInFolder(project.path) } as MenuItem]
      : []),
    ...(hasOpen ? [{ label: 'Close project', icon: 'close', onSelect: onClose } as MenuItem] : []),
  ];

  return (
    <div className={`project-row${open ? ' is-open' : ''}`}>
      <Tooltip content={project.path}>
        <button
          type="button"
          className="project-open"
          aria-current={open ? 'true' : undefined}
          onClick={onOpen}
        >
          <ProjectMark path={project.path} identity={project.identity} />
          <span className="project-name">{project.name}</span>
        </button>
      </Tooltip>
      <span className="project-actions">
        <MenuButton
          label={`Project options for ${project.name}`}
          align="right"
          triggerClassName="chat-more"
          trigger={<Icon name="overflow" />}
          items={items}
        />
      </span>
    </div>
  );
}


/**
 * One nav row: an icon and a label, the same shape for every act.
 *
 * `disabledReason` uses `aria-disabled` rather than `disabled` for the same
 * reason ModeSwitch does: a really-disabled button takes no pointer or focus
 * events, so the tooltip explaining WHY would never appear — which is the only
 * thing that makes an unavailable row better than a missing one.
 */
function NavRow({
  icon,
  label,
  collapsed,
  active = false,
  disabledReason,
  onClick,
}: {
  icon: string;
  label: string;
  collapsed: boolean;
  /**
   * You are standing on this screen. These rows carried no active state at
   * all, which is why the rail could not answer "where am I" on Skills: the
   * highlight in screenshots was `:hover` and vanished the moment the pointer
   * moved. `aria-current="page"` rather than `"true"` because these ARE pages.
   */
  active?: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  const disabled = disabledReason !== undefined;
  const row = collapsed ? (
    <IconButton
      bare
      icon={icon}
      label={disabledReason ?? label}
      side="right"
      iconSize={16}
      className={`nav-row is-icon${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onClick()}
    />
  ) : (
    <button
      type="button"
      className={`nav-row${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onClick()}
    >
      <span className="nav-glyph" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="nav-label">{label}</span>
    </button>
  );
  // Collapsed rows are IconButtons, which carry their own tooltip already.
  return disabled && !collapsed ? <Tooltip content={disabledReason}>{row}</Tooltip> : row;
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
  const identity = accountIdentity(providers);

  const items: MenuItem[] = [
    {
      label: 'Settings…',
      // Never gated. It used to require an open project, from when this dialog
      // was nothing but the two API-key fields that save into the folder's own
      // .hearth/app.json. Settings is now a panel of panes — what to call you,
      // what this copy has made, where things live — and none of that is about
      // a project, so refusing to open it left the reader clicking a menu item
      // that did nothing. The one pane that genuinely needs a folder says so
      // itself, in the pane, where the reason is next to the thing it stops.
      icon: 'gear',
      onSelect: () => window.dispatchEvent(new CustomEvent('hearth:open-settings')),
    },
  ];
  // Only offered where it can actually run: the flow shells out to the codex
  // binary, so without one installed this is a dead item.
  if (providers?.openai.installed && !providers.openai.loggedIn) {
    items.push({ label: 'Sign in to ChatGPT', icon: 'upload', onSelect: () => void startOpenAiLogin() });
  }
  // Checking for updates lives in Settings → General, beside the version it
  // reports on. It was here when there was nowhere else to put it.

  return (
    <MenuButton
      label={`Account: ${identity.name}, ${identity.status}`}
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
  const recentChatsLoaded = useApp((s) => s.recentChatsLoaded);
  const activeChatId = useApp((s) => s.activeChatId);
  const newChat = useApp((s) => s.newChat);
  const openRecentChat = useApp((s) => s.openRecentChat);
  const renameChat = useApp((s) => s.renameChat);
  const deleteChat = useApp((s) => s.deleteChat);
  const projectName = useApp((s) => s.projectName);
  const projectPath = useApp((s) => s.projectPath);
  const openWorkspace = useApp((s) => s.openWorkspace);
  const openProject = useApp((s) => s.openProject);
  const openScreen = useApp((s) => s.openScreen);
  const closeWorkspace = useApp((s) => s.closeWorkspace);
  const askProjectName = useApp((s) => s.askProjectName);
  // Where the app is standing. New chat, Skills and Tester belong to the
  // person, not to a game, so while one of them fills the window NOTHING in
  // the lists below is current — the folder is still open underneath, but it
  // is not where you are. See `globalPlace`.
  const place = useApp((s) => globalPlace(s));
  const inProject = place === null;
  const native = hearthNative();
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [pendingDelete, setPendingDelete] = useState<RecentChatEntry | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // The order the rail is currently showing projects in, so the next read of
  // recents can be laid back over it instead of replacing it. A ref rather
  // than state: writing it must never be the thing that causes a render.
  const order = useRef<string[]>([]);

  // The rail is the one component always mounted, so it is the one that serves
  // the composer's "Open folder…" request.
  useOpenFolderRequests();

  // Recents change when a folder is opened, which is exactly when this
  // component's project changes — so that is the only thing worth re-reading on.
  useEffect(() => {
    void apiRecentWorkspaces().then(setRecents);
  }, [projectPath]);

  // Bumped by the shortcut to mean "put the caret in the field", whether or not
  // anything else about the rail changed. See the effect below.
  const [focusSearch, setFocusSearch] = useState(0);

  // The field is rendered only under `!collapsed && searching`, so the caret
  // goes to it after the render that puts it on screen, never from the
  // handler that asked, where it does not exist yet.
  //
  // `focusSearch` is in the deps because the two state values are not enough.
  // The shortcut pressed while search is already open makes setSearching(true)
  // a no-op, so nothing here changes, the effect never re-runs, and the
  // shortcut appeared to do nothing at all: document.activeElement stayed on
  // BODY and what was typed went nowhere. The bump is the ask itself, and it is
  // always new.
  useEffect(() => {
    if (collapsed || !searching) return;
    const box = searchRef.current;
    if (!box) return;
    box.focus();
    // Selected as well as focused: a second press means "search for something
    // else", so whatever is in there is ready to be typed over.
    box.select();
  }, [collapsed, searching, focusSearch]);

  // The search shortcut. It has to open the rail as well as the field: search
  // is hidden behind a toggle, and on a collapsed rail there is nothing on
  // screen to type into.
  useEffect(() => {
    const onFocusSearch = (): void => {
      setCollapsed(false);
      setSearching(true);
      setFocusSearch((n) => n + 1);
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, onFocusSearch);
  }, [setCollapsed]);

  const project = useMemo(
    () => (projectPath ? { path: projectPath, name: projectName ?? projectPath } : null),
    [projectPath, projectName],
  );

  const conversations = useMemo(
    () => mergeRecentChats(recentChats, chats, project).filter((entry) => matchesQuery(entry.title, query)),
    [recentChats, chats, project, query],
  );

  /**
   * Every project this rail has seen, in an order that does not move.
   *
   * The server sorts recents by last opened, and this list used to hoist the
   * open one to the top on top of that, so a click did two things at once: it
   * selected a project AND rewrote the list under the pointer. Clicking the
   * fourth row moved it to the first and shifted the three above it down, so
   * the row you had just aimed at was somewhere else by the time you let go.
   *
   * The remembered order covers every project rather than the filtered view.
   * A search that hides half the rail must not make the hidden half look new
   * when the query is cleared.
   */
  const ordered = useMemo(
    () => stableOrder(recents.filter((recent) => recent.exists), order.current),
    // `order` is this memo's memory of what it last produced, not an input
    // that should re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recents],
  );
  order.current = ordered.map((project) => project.path);

  /**
   * What the rail shows: the remembered order, filtered, capped. The open
   * project is added back when the cap would have hidden it — it is the one
   * row that has to be on screen, and appending it is the only position that
   * does not push everything else around.
   */
  const projects = useMemo(() => {
    const matching = ordered.filter((project) => matchesQuery(project.name, query));
    const capped = matching.slice(0, MAX_PROJECTS);
    if (projectPath === null || capped.some((project) => project.path === projectPath)) return capped;
    const open = matching.find((project) => project.path === projectPath);
    return open ? [...capped, open] : capped;
  }, [ordered, query, projectPath]);

  /** What a project stored, by path — how a chat row finds its own mark. */
  const identityOf = useMemo(() => {
    const byPath = new Map(recents.map((recent) => [recent.path, recent.identity]));
    return (path: string): ProjectIdentity | undefined => byPath.get(path);
  }, [recents]);

  // Optimistic: the swatch has to fill the moment it is clicked, and the list
  // is re-read afterwards so a write that failed corrects itself.
  async function setIdentity(path: string, patch: { icon?: string; color?: string }): Promise<void> {
    setRecents((current) =>
      current.map((row) => (row.path === path ? { ...row, identity: { ...row.identity, ...patch } } : row)),
    );
    await apiSetProjectIdentity(path, patch);
    setRecents(await apiRecentWorkspaces());
  }

  const shown = query.trim() === '' ? conversations.slice(0, MAX_RECENT_CHATS) : conversations;

  return (
    <nav
      className={`sidebar${collapsed ? ' is-collapsed' : ''}`}
      aria-label="Projects and chats"
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
              // How anyone finds out the shortcut exists. Written for the
              // machine it is read on, so a Windows user is told Ctrl.
              shortcut={searching ? undefined : shortcutLabel(SHORTCUTS.search)}
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
            placeholder="Search projects and chats"
            aria-label="Search projects and chats"
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

      {/* Two general acts, the way every chat app opens: start something, and
          the one library that is about you rather than about a project. What
          the app can reach lives further down; what it is doing lives in the
          column to the right. */}
      <div className="sidebar-nav">
        <NavRow
          icon="compose"
          label="New chat"
          collapsed={collapsed}
          active={place === 'new-chat'}
          onClick={newChat}
        />
        <NavRow
          icon="sparkle"
          label="Skills"
          collapsed={collapsed}
          active={place === 'skills'}
          onClick={() => openScreen('skills')}
        />
        {/* Always offered, never gated on an open folder. A playtest belongs
            to a game, but the HISTORY of playtests belongs to you: it spans
            every game, it outlives any one session, and hiding the row until
            something was open meant the only way to reach yesterday's run was
            to first guess which project it came from. The screen names the
            game it is aiming at, so nothing here has to be inferred. */}
        <NavRow
          icon="bot"
          label="Tester"
          collapsed={collapsed}
          active={place === 'tester'}
          onClick={() => openScreen('tester')}
        />
      </div>

      {/* Collapsed, this whole region is fully hidden (sidebar.css), and hidden
          has to mean hidden to the keyboard and to a screen reader too, not
          only to the eye. Without this the rail kept ~32 unreachable buttons in
          the tab order: four Tabs off "Expand sidebar" put focus on a project
          row drawn outside the 60px rail, and the hidden container scrolled to
          chase it. */}
      <div className="sidebar-scroll" {...(collapsed ? INERT : {})}>
        <section className="sidebar-section" aria-label="Projects">
          {/* The heading is where making another one belongs — beside the list
              it joins, not competing with New chat above. Quiet like every
              other control in the rail: it surfaces on hover of the section
              and on focus, and the ellipsis says a question comes next. */}
          <div className="sidebar-section-head">
            <h2 className="sidebar-section-title">Projects</h2>
            <IconButton
              bare
              icon="plus"
              label="New project…"
              side="right"
              iconSize={13}
              className="section-add"
              // Creating lands you in the project, not in a list with a new
              // row: the folder exists, it is empty, and the only useful next
              // thing is to say what the game is. `openProject` is exactly
              // that landing. Dismissing the question does nothing at all.
              onClick={() => {
                void askProjectName('').then((path) => {
                  if (path !== null) void openProject(path);
                });
              }}
            />
          </div>
          <div className="project-list">
            {projects.length === 0 ? (
              <p className="sidebar-empty">
                {query.trim() === ''
                  ? 'Every game you make is a project. Describe one to begin.'
                  : 'No projects match that.'}
              </p>
            ) : (
              projects.map((project) => (
                <ProjectRow
                  key={project.path}
                  project={project}
                  // Open AND current. On a global screen the folder is still
                  // open — the socket is up and the game is running — but you
                  // are not in it, so no row is marked. `open` is what draws
                  // and announces the highlight; `hasOpen` below is what still
                  // offers "Close project" for the folder that really is open.
                  open={inProject && project.path === projectPath}
                  hasOpen={project.path === projectPath}
                  native={native}
                  onOpen={() => void openProject(project.path)}
                  onClose={closeWorkspace}
                  onIdentity={(patch) => void setIdentity(project.path, patch)}
                />
              ))
            )}
          </div>
        </section>

        <section className="sidebar-section" aria-label="Chats">
          <h2 className="sidebar-section-title">Chats</h2>
          {shown.length === 0 ? (
            <p className="sidebar-empty">
              {query.trim() !== ''
                ? 'No chats match that.'
                : recentChatsLoaded
                  ? 'Nothing yet. Say something and it lands here.'
                  : // Not read yet is not the same as nothing. This said
                    // "Nothing yet" for the length of the round trip, in front
                    // of a machine with a hundred conversations on it.
                    'Looking…'}
            </p>
          ) : (
            <div className="chat-list">
              {shown.map((entry) => (
                <ChatRow
                  key={entry.id}
                  entry={entry}
                  // A conversation is only current when you are reading it. On
                  // New chat, Skills or Tester it is merely the one the server
                  // still has open, and marking it told a screen reader you
                  // were in a conversation that was not on the screen.
                  active={inProject && entry.id === activeChatId && entry.project.path === projectPath}
                  local={entry.project.path === projectPath}
                  identity={identityOf(entry.project.path)}
                  onOpen={() => void openRecentChat(entry)}
                  onRename={(title) => void renameChat(entry.id, title)}
                  onDelete={() => setPendingDelete(entry)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Connectors used to sit here. It is out of the rail until it does
            something: every row either ran already (Web games, Playtesting) or
            said "soon", and adding one recorded a name that nothing would read,
            so the section spent permanent rail space describing capability the
            app does not have yet. HarnessSections and its store are intact and
            still covered by tests, ready to come back when a connector can
            actually be connected. */}
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
