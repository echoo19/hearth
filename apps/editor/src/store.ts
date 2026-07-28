/**
 * App state. One zustand store covering the five things the app is:
 *
 *   1. an open folder (and the socket to its server),
 *   2. a conversation,
 *   3. a game pane,
 *   4. an evidence feed,
 *   5. the small amount of pane/drawer state the shell needs.
 *
 * Everything live — conversation events, evidence, terminal bytes, external
 * file changes — arrives on ONE WebSocket per folder, multiplexed by frame
 * type (see server/ws.ts). The terminal's own buffer deliberately lives
 * outside this store (components/agent/useAgentSocket.ts) so it survives the
 * conversation column switching away from terminal mode.
 */
import { create } from 'zustand';
import {
  apiAppSettings,
  apiChatProviders,
  apiCreateWorkspace,
  apiDeleteChat,
  apiEvidenceHistory,
  apiGameStatus,
  apiListChats,
  apiMeta,
  apiOpenAiLogin,
  apiOpenWorkspace,
  apiPersonalization,
  apiPlaytestView,
  apiProbeStatus,
  apiRecentChats,
  apiRenameChat,
  apiSavePersonalization,
  apiStartSweep,
  projectFileUrl,
  type Personalization,
  type PersonalizationInfo,
} from './api';
import { attachmentPayload, type PendingAttachment } from './chat/attachments';
import type {
  AgentCliInfo,
  AppSettingsInfo,
  ApprovalDecision,
  ChatAttachmentView,
  ChatDriverKind,
  ChatEvent,
  ChatKind,
  ChatMessage,
  ChatPart,
  ChatProviderStatus,
  ChatRecord,
  ChatSummary,
  ConsoleEntry,
  ConsoleLevel,
  ConsoleSource,
  EvidenceEvent,
  FileChangeEntry,
  GameStatus,
  JournalEntry,
  PlaytestView,
  RecentChatEntry,
  Sense,
  ServerMeta,
  StoredAttachment,
  UpdateReadyInfo,
  WorkspaceInfo,
} from './types';
import type { WsFrame } from '../server/ws';
import { agentForTurn, getModelChoice } from './chat/modelChoice';
import { hearthNative } from './native';
import { showToast } from './toast';
import {
  ensureAgentPtySessionId,
  getAgentSessionSummary,
  ingestPtyAttach,
  ingestPtyFrame,
  markAgentCli,
  markAgentDisconnected,
  markAgentStarted,
  planTerminalLaunch,
  resetAgentSocket,
  type AgentStatus,
} from './components/agent/useAgentSocket';

/** Which surface the right-hand stack is showing. */
export type PaneTab = 'game' | 'console';

/**
 * A message someone typed while the agent was still answering the last one.
 *
 * It is the same payload `sendChat` takes, held rather than dropped. Note the
 * attachments keep their base64 `data`: the composer's object URLs are revoked
 * the moment its tray lets go, so anything queued has to carry its own bytes.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: readonly PendingAttachment[];
}

/**
 * What the conversation column IS right now. Both are first-class ways to talk
 * to an agent: `chat` is the built-in driver (Agent SDK or the stub), `terminal`
 * is the user's own CLI agent — `claude`, `codex`, anything — in a real shell in
 * the project folder. The terminal is not a fallback; it is the other half of
 * the same column.
 *
 * The same vocabulary as a conversation record's `kind` (server/chatStore.ts),
 * and no longer an independent choice: the open conversation's kind is what
 * the column shows, because a conversation cannot change kind. What used to be
 * a switch inside a conversation is now a choice made when one is started.
 */
export type ConversationMode = ChatKind;

/** Below this width the game pane can't hold its own column and becomes a tab. */
export const NARROW_BREAKPOINT_PX = 900;

export interface AppState {
  meta: ServerMeta | null;

  // --- Folder ---------------------------------------------------------------
  projectPath: string | null;
  projectName: string | null;
  isHearthProject: boolean;
  wsStatus: 'connected' | 'connecting' | 'disconnected';

  // --- Conversation ---------------------------------------------------------
  messages: ChatMessage[];
  /** True from send until the turn's `done`/`error` — gates the composer. */
  chatBusy: boolean;
  /**
   * Messages typed while a turn was running, oldest first. They are not on the
   * wire and not in the transcript yet — they are held here until the turn
   * they interrupted is over. Empty almost always.
   */
  queued: QueuedMessage[];
  /** Which backend answered, once the server has bound one. */
  chatDriver: ChatDriverKind | null;
  chatError: string | null;
  settings: AppSettingsInfo | null;
  /**
   * What could answer a turn in this folder — a key, a signed-in Codex, or
   * nothing. Null until the first read; refreshed whenever the server says it
   * changed (a login completing, a key being saved).
   */
  providers: ChatProviderStatus | null;
  /** Every conversation this folder holds, newest activity first. */
  chats: ChatSummary[];
  /** Which one the window is looking at. */
  activeChatId: string | null;
  /**
   * Every conversation on this machine, across folders — what the rail's
   * Recents list shows. Global on purpose: a chat is the unit of work, and
   * which folder it happens to live in is a detail the user shouldn't have to
   * reopen a project to remember.
   */
  recentChats: RecentChatEntry[];

  // --- Game pane ------------------------------------------------------------
  game: GameStatus;
  senses: Sense[];
  /** The last sweep found a probe shim, so the deeper senses are real. */
  shimDetected: boolean;
  /** Bumped whenever the game's files change, so the iframe reloads. */
  gameNonce: number;

  // --- Playtest -------------------------------------------------------------
  /**
   * The running sweep, as the Playtest button reports it. `done`/`total` come
   * from the evidence feed itself (one run-finished per completed run), so the
   * progress a user sees is the same evidence the rail is filling with.
   */
  sweep: { running: boolean; done: number; total: number | null; error: string | null };
  /**
   * The newest sweep, one row per playtester: what each bot did, and the
   * reason the ones that could not play give. Read from the files the sweep
   * writes rather than from the journal, because a skip reason exists only in
   * the report and a running sweep's forecast only in the runner.
   *
   * Null until something reads it. It also carries the only honest denominator
   * the Playtest button has: see plannedRuns below.
   */
  playtest: PlaytestView | null;

  // --- Evidence -------------------------------------------------------------
  evidence: EvidenceEvent[];
  evidenceOpen: boolean;

  // --- Console --------------------------------------------------------------
  consoleEntries: ConsoleEntry[];
  consoleUnread: number;
  consoleAtBottom: boolean;

  // --- Shell ----------------------------------------------------------------
  /** Left rail collapsed to icons. Persisted — it is a workspace preference. */
  sidebarCollapsed: boolean;
  /** Chat or terminal in the conversation column. Persisted per folder. */
  conversationMode: ConversationMode;
  /**
   * Whether `conversationMode` is settled — a stored preference was found, or
   * the user picked one. While false the first settings read still gets to
   * choose the mode (chat with a key, terminal without). Once true, nothing
   * moves the column out from under the user.
   */
  conversationModePinned: boolean;
  paneTab: PaneTab;
  /**
   * Whether the playtest column has the right half of the window. False is the
   * resting state: a conversation with nothing to play beside it should be a
   * conversation, full width, the way every other chat app looks.
   */
  paneOpen: boolean;
  /**
   * The open folder's own answer to that, or null while it has never given
   * one. Distinct from `paneOpen` because the two disagree on purpose: a new
   * conversation closes the column without forgetting that this folder likes
   * it open, so the next game to appear brings it back.
   */
  paneChoice: boolean | null;
  /** Narrow layout only: the conversation and the pane stack become tabs. */
  narrowTab: 'chat' | 'pane';
  codePeek: { open: boolean; path: string | null };
  /**
   * The new-chat surface is showing: greeting, composer, project selector.
   * Home and New chat are the same screen — the only difference is whether a
   * project happens to be open behind it.
   */
  composing: boolean;
  /**
   * Which project the next message starts in. A path, or null meaning "a new
   * one", which is created from the message itself when it is sent.
   */
  composeTarget: string | null;
  /**
   * The project's own screen is showing: its name, what it is for, its chats,
   * its instructions and its context — rather than any one conversation.
   *
   * This is what clicking a project in the rail lands on. A project holds MANY
   * conversations, and dropping straight into the most recent one made the
   * other twelve invisible and the project itself unaddressable.
   */
  projectView: boolean;
  /**
   * A full screen that sits over the work, rather than beside it. Skills is
   * the first: it is a library you browse and edit, which is a place, not a
   * question to answer and dismiss. A dialog would put a page-sized surface
   * behind a scrim and take the window's own back button away from it.
   *
   * `null` means the work itself — whatever `composing` / `projectView` and
   * the open project already decide between them. Leaving a screen restores
   * that arrangement untouched, which is why nothing else is stored here.
   */
  /**
   * `playtest` is the second: the bots that play your game, one panel each.
   * It is a place for the same reason Skills is — you sit and watch it — and
   * it does not replace the Playtest button, which still lives in the column.
   */
  screen: 'skills' | 'playtest' | null;
  /** Prompt carried across a folder open, consumed by the composer on mount. */
  pendingPrompt: string | null;
  /**
   * A first message from Home is making a folder, opening it and sending —
   * three round trips behind one keystroke. Held so the home composer can
   * refuse a second submit rather than minting a second project.
   */
  homeBusy: boolean;
  /** Set when an update is downloaded and waiting for a relaunch. */
  updateReady: UpdateReadyInfo | null;
  /**
   * What to call the user and the instructions that apply to every game.
   * Null until Settings asks for it: this lives in `~/.hearth` and is read by
   * one pane, so paying for it on every boot would be paying for nothing.
   */
  personalization: PersonalizationInfo | null;

  /**
   * External changes (a CLI/agent mutating a Hearth project) as they land.
   * Nothing renders these today; they exist because the socket already
   * carries them and they are the cheapest "something on disk moved" signal.
   */
  journalFeed: JournalEntry[];

  /** Terminal session status, mirrored from useAgentSocket's external store. */
  agentStatus: AgentStatus;

  // --- Actions --------------------------------------------------------------
  loadMeta(): Promise<void>;
  openWorkspace(path: string, prompt?: string): Promise<{ ok: boolean; error?: string }>;
  closeWorkspace(): void;
  /** Send a turn. `attachments` are files the composer's tray was holding. */
  sendChat(text: string, attachments?: readonly PendingAttachment[]): void;
  /** End the turn AND the session — the conversation's agent is torn down. */
  cancelChat(): void;
  /** Stop the running turn but keep the session, so the next message continues. */
  interruptChat(): void;
  /** Take a message back out of the queue before it is ever sent. */
  unqueueChat(id: string): void;
  /**
   * Apply one frame from the folder's socket. The socket's own `onmessage`
   * is a JSON.parse and a call to this, so everything the server can tell the
   * app arrives through here — which is also what makes the whole inbound half
   * reachable from a test without a live server.
   */
  receiveFrame(frame: WsFrame): void;
  /** Answer a blocking ask, and show the answer without waiting for the round trip. */
  approveChat(approvalId: string, decision: ApprovalDecision): void;
  refreshProviders(): Promise<void>;
  /** Begin the ChatGPT device flow and open the page it hands back. */
  startOpenAiLogin(): Promise<void>;
  /**
   * Start a fresh conversation in the open folder and switch to it. A folder
   * is required — see `newProject` for the other half of that rule.
   */
  newChat(): void;
  /**
   * Begin a new game. There is no name field: Hearth's projects are made by
   * describing one, so this returns to the surface where the first message
   * creates the folder (see `startFromHome`). Leaving the current folder IS
   * the act — a new project is a different folder by definition.
   */
  newProject(): void;
  /** Switch to an existing conversation, replaying it from disk. */
  openChat(chatId: string): void;
  renameChat(chatId: string, title: string): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  refreshChats(): Promise<void>;
  /** Re-read the global conversation list (all folders). Safe to over-call. */
  refreshRecentChats(): Promise<void>;
  /** Open a conversation from the global list, changing folders if it needs to. */
  openRecentChat(entry: RecentChatEntry): Promise<void>;
  /**
   * The first sentence, with no folder open: make one from the prompt, open
   * it, start a conversation, and send. The whole point of Home — a project
   * is a consequence of talking, not a prerequisite for it.
   */
  startFromHome(text: string, attachments?: readonly PendingAttachment[]): Promise<{ ok: boolean; error?: string }>;
  /** Subscribe to the main process's update-ready signal. Returns unsubscribe. */
  watchUpdates(): () => void;
  /** Quit and install the downloaded update (the rail's banner button). */
  relaunchToUpdate(): Promise<void>;
  consumePendingPrompt(): string | null;
  refreshGame(): Promise<void>;
  refreshSettings(): Promise<void>;
  /** Read `~/.hearth`'s name and standing instructions. Safe to call twice. */
  loadPersonalization(): Promise<void>;
  /**
   * Change one or both. Omit a field to leave it alone; an empty string
   * clears it. Answers false when the write did not land, which is the only
   * thing the pane has to be able to say out loud.
   */
  savePersonalization(patch: Partial<Personalization>): Promise<boolean>;
  /** Play the game and stream what the probe finds into the evidence rail. */
  startSweep(): Promise<void>;
  /** Re-read the playtest view for the open folder. */
  refreshPlaytest(): Promise<void>;
  /**
   * Fill the evidence rail from the folder's journal.
   *
   * Playtests belong to the folder, not to this window's socket, so the rail
   * is loaded from disk on open and the live channel appends to it. Without
   * this a second window, or a socket that reconnected while another still
   * held the channel, shows nothing for a folder full of them.
   */
  refreshEvidence(): Promise<void>;
  setSidebarCollapsed(collapsed: boolean): void;
  /**
   * Ask for a kind of conversation, and persist it for this folder.
   *
   * A conversation's kind is fixed when it is created, so this is no longer a
   * switch: asking for the other kind while one is open STARTS a new
   * conversation of that kind. With nothing open — Home, the blank composer —
   * there is no record to contradict, and it simply aims the column.
   */
  setConversationMode(mode: ConversationMode): void;
  /**
   * Have the conversation in the terminal, with this CLI running in it: switch
   * modes, make sure there is a shell, and type the command into it. Refusals
   * (nothing installed, no folder, an agent already in there) go to the
   * Console and change nothing — see planTerminalLaunch for which is which.
   */
  startTerminalCli(cli: AgentCliInfo): void;
  setPaneTab(tab: PaneTab): void;
  /** Show or hide the playtest column. An explicit pick, remembered per folder. */
  setPaneOpen(open: boolean): void;
  /** Aim the new-chat composer at a project, or at one that doesn't exist yet. */
  setComposeTarget(path: string | null): void;
  /** Open a project and land on its own screen rather than in a conversation. */
  openProject(path: string): Promise<void>;
  /** Come back up from a conversation to the project it belongs to. */
  showProject(): void;
  /** Open a full screen over the work. */
  openScreen(screen: 'skills' | 'playtest'): void;
  /** Leave it. The work underneath is exactly as it was left. */
  closeScreen(): void;
  setNarrowTab(tab: 'chat' | 'pane'): void;
  setEvidenceOpen(open: boolean): void;
  openCodePeek(path?: string): void;
  closeCodePeek(): void;
  log(level: ConsoleLevel, source: ConsoleSource, message: string, link?: ConsoleEntry['link']): void;
  clearConsole(): void;
  setConsoleAtBottom(atBottom: boolean): void;
  /** Sends a frame over the shared socket; false when it isn't connected. */
  sendFrame(frame: WsFrame): boolean;
}

const MAX_CONSOLE = 500;
const MAX_JOURNAL_FEED = 200;
const MAX_EVIDENCE = 400;
const LAST_WORKSPACE_KEY = 'hearth:lastWorkspace';
const SIDEBAR_KEY = 'hearth:sidebarCollapsed';
const CONVERSATION_MODE_PREFIX = 'hearth:conversationMode:';
const PANE_OPEN_PREFIX = 'hearth:pane:';
const WS_BACKOFF_INITIAL_MS = 1000;
const WS_BACKOFF_MAX_MS = 5000;
/** Coalescing window for the global Recents read — see scheduleRecentChats. */
const RECENT_CHATS_DEBOUNCE_MS = 400;
/** How long Home's first message waits for the new folder's socket. */
const CONNECT_WAIT_MS = 8000;
/** How often the game pane re-checks whether a game exists / changed. */
export const GAME_POLL_MS = 1500;

let entryId = 0;
let messageId = 0;

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function makeEntry(level: ConsoleLevel, source: ConsoleSource, message: string, link?: ConsoleEntry['link']): ConsoleEntry {
  return { id: ++entryId, time: timestamp(), level, source, message, link };
}

let queuedId = 0;

const EMPTY_GAME: GameStatus = { present: false, entry: null, mtime: 0 };
const IDLE_SWEEP = { running: false, done: 0, total: null, error: null } as const;

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false; // private mode: expanded is the better default
  }
}

// ---------------------------------------------------------------------------
// Conversation mode — per folder, because which agent you talk to is a property
// of the project, not of the app. Same storage mechanism as the sidebar
// preference, keyed by the folder's root path.
// ---------------------------------------------------------------------------

export function conversationModeStorageKey(projectPath: string): string {
  return `${CONVERSATION_MODE_PREFIX}${projectPath}`;
}

/**
 * What kind of conversation a record is, for anything that has to draw it.
 *
 * One rule in one place, because three surfaces ask it (the rail, the project
 * screen, the column) and they must never disagree. A record with no answer is
 * a chat: conversations written before kinds existed were all chats, and the
 * index says so too (server/chatStore.ts, parseChatIndex).
 */
export function conversationKind(chat: { kind?: ChatKind }): ChatKind {
  return chat.kind === 'terminal' ? 'terminal' : 'chat';
}

/**
 * Where a folder with no stored preference lands on its FIRST run: the chat if
 * anything can answer it, the terminal if nothing can. Pure — this is the whole
 * "sensible default" rule, checkable without a store.
 */
export function defaultConversationMode(canChat: boolean): ConversationMode {
  return canChat ? 'chat' : 'terminal';
}

/**
 * Whether ANY backend could answer a chat turn. An Anthropic key is not the
 * only door: a signed-in Codex (or a stored OpenAI key) answers just as well,
 * and a folder that lands in the terminal despite one reads as broken.
 */
export function anyChatProviderReady(settings: AppSettingsInfo | null, providers: ChatProviderStatus | null): boolean {
  if (settings?.hasKey) return true;
  if (!providers) return false;
  return providers.anthropic.hasKey || providers.openai.loggedIn || providers.openai.hasKey;
}

/** The folder's stored preference, or null when it has never picked one. */
export function readConversationMode(projectPath: string): ConversationMode | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(conversationModeStorageKey(projectPath));
  } catch {
    return null; // private mode: fall back to the derived default
  }
  return raw === 'chat' || raw === 'terminal' ? raw : null;
}

function writeConversationMode(projectPath: string, mode: ConversationMode): void {
  try {
    localStorage.setItem(conversationModeStorageKey(projectPath), mode);
  } catch {
    /* private mode: the preference just doesn't persist */
  }
}

// ---------------------------------------------------------------------------
// The playtest column — per folder, for the same reason the mode is: whether
// you want half the window given to a running game is a fact about the project
// you are in, not about the app. A folder with no game in it yet has nothing to
// show there, so the column starts closed and opens itself the moment one
// appears (see refreshGame) — unless this folder has said otherwise.
// ---------------------------------------------------------------------------

export function paneOpenStorageKey(projectPath: string): string {
  return `${PANE_OPEN_PREFIX}${projectPath}`;
}

/** The folder's stored choice, or null when nobody has made one. */
export function readPaneOpen(projectPath: string): boolean | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(paneOpenStorageKey(projectPath));
  } catch {
    return null; // private mode: no choice on record
  }
  return raw === '1' ? true : raw === '0' ? false : null;
}

function writePaneOpen(projectPath: string, open: boolean): void {
  try {
    localStorage.setItem(paneOpenStorageKey(projectPath), open ? '1' : '0');
  } catch {
    /* private mode: the preference just doesn't persist */
  }
}

// ---------------------------------------------------------------------------
// Conversation reducer — pure, so the streaming assembly is unit-testable
// without a socket or a React tree.
// ---------------------------------------------------------------------------

export function makeUserMessage(text: string, attachments?: readonly ChatAttachmentView[]): ChatMessage {
  return {
    id: `m${++messageId}`,
    role: 'user',
    // A message that is only a picture has no text part: an empty paragraph
    // would render as a blank line under the thumbnail.
    parts: text === '' ? [] : [{ kind: 'text', text }],
    streaming: false,
    ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
  };
}

/**
 * `startedAt` is passed only by the live path. A replayed turn is assembled
 * from a file in a few milliseconds, and a stopwatch started there would be
 * timing the disk.
 */
export function makeAgentMessage(startedAt?: number): ChatMessage {
  return {
    id: `m${++messageId}`,
    role: 'agent',
    parts: [],
    streaming: true,
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

/**
 * Upgrade a v0 event to the canonical vocabulary. Old transcripts on disk were
 * written in the smaller union (`text-delta`, `tool-start`, `tool-end{ok}`,
 * `done`); rather than teach the fold two dialects, everything is translated
 * once here and the fold only ever sees one. Canonical events pass through
 * untouched, so this is a no-op for anything a current driver emits.
 *
 * `tool-end` legitimately has two shapes — the legacy one is keyed by `id`,
 * the canonical one by `toolId` — which is what the `'toolId' in event` narrow
 * is for.
 */
export function normalizeChatEvent(event: ChatEvent): ChatEvent {
  switch (event.type) {
    case 'text-delta':
      return { type: 'message-delta', text: event.text };
    case 'tool-start':
      // v0 had no tool taxonomy: everything becomes a generic chip, which is
      // exactly how it rendered when it was written.
      return { type: 'tool-begin', toolId: event.id, kind: 'other', title: event.name, detail: event.detail };
    case 'tool-end':
      return 'toolId' in event
        ? event
        : { type: 'tool-end', toolId: event.id, status: event.ok ? 'ok' : 'error', summary: event.detail };
    case 'done':
      return { type: 'turn-complete' };
    default:
      return event;
  }
}

/**
 * Ceiling on captured output held per command / per subagent, in characters.
 * A build log can run to megabytes and none of it is worth the memory once it
 * has scrolled past — the TAIL is what a reader wants, so the head is what
 * gets dropped.
 */
const MAX_CAPTURED_CHARS = 20000;

function clampCapture(text: string): string {
  return text.length <= MAX_CAPTURED_CHARS ? text : text.slice(text.length - MAX_CAPTURED_CHARS);
}

/**
 * Merge a second file-change report into the first. Keyed by path, first-seen
 * order, later report wins: a driver that re-reports a file (an edit followed
 * by the diff for it) must not double it in the list.
 */
function mergeFileChanges(existing: FileChangeEntry[], incoming: FileChangeEntry[]): FileChangeEntry[] {
  const merged = existing.slice();
  for (const file of incoming) {
    const at = merged.findIndex((entry) => entry.path === file.path);
    if (at >= 0) merged[at] = file;
    else merged.push(file);
  }
  return merged;
}

/**
 * Fold one ChatEvent into the message list. Prose deltas extend the trailing
 * text part (or open one), so a run of deltas is one paragraph rather than a
 * thousand fragments; anything else — a command, a file change, a subagent, an
 * ask — closes that paragraph, which is what makes activity land inline where
 * it actually happened.
 *
 * `now` is a parameter rather than a `Date.now()` call so the fold stays pure
 * and the one thing it times (how long a command ran) is testable.
 *
 * Returns the same array identity when nothing applies, so React skips work.
 */
/**
 * The prompt that started the turn currently being written, if it can still be
 * found. Used only to offer a retry after a failure, so an empty answer just
 * means the row shows no retry rather than anything going wrong.
 */
export function lastUserText(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text = message.parts
      .filter((part): part is Extract<ChatPart, { kind: 'text' }> => part.kind === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    return text === '' ? undefined : text;
  }
  return undefined;
}

export function applyChatEvent(
  messages: ChatMessage[],
  incoming: ChatEvent,
  now: number = Date.now(),
): ChatMessage[] {
  const lastIndex = messages.length - 1;
  const last = lastIndex >= 0 ? messages[lastIndex] : null;
  if (!last || last.role !== 'agent' || !last.streaming) return messages;

  const event = normalizeChatEvent(incoming);

  const replace = (parts: ChatPart[], streaming = true): ChatMessage[] => {
    const next = messages.slice();
    next[lastIndex] = { ...last, parts, streaming };
    return next;
  };

  switch (event.type) {
    case 'message-delta': {
      const parts = last.parts.slice();
      const tail = parts[parts.length - 1];
      if (tail && tail.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: tail.text + event.text };
      else parts.push({ kind: 'text', text: event.text });
      return replace(parts);
    }
    case 'reasoning-delta': {
      const parts = last.parts.slice();
      const tail = parts[parts.length - 1];
      if (tail && tail.kind === 'reasoning') {
        // Every delta moves the end of the thought, so the duration is right
        // the moment the last one lands — nothing has to close the part.
        parts[parts.length - 1] = {
          ...tail,
          text: tail.text + event.text,
          durationMs: tail.startedAt === undefined ? tail.durationMs : now - tail.startedAt,
        };
      } else {
        parts.push({ kind: 'reasoning', text: event.text, startedAt: now });
      }
      return replace(parts);
    }
    case 'tool-begin': {
      // A shell command is the one tool with a body worth keeping, so it opens
      // its own part with a capture buffer. A skill gets a row of its own
      // because it is a thing the user installed rather than a thing the agent
      // came with. Everything else is a chip.
      let opened: ChatPart;
      if (event.kind === 'command') {
        opened = {
          kind: 'command',
          id: event.toolId,
          title: event.title,
          detail: event.detail,
          output: '',
          state: 'running',
          startedAt: now,
        };
      } else if (event.kind === 'skill') {
        opened = { kind: 'skill', id: event.toolId, name: event.title, detail: event.detail, state: 'running' };
      } else {
        opened = { kind: 'tool', id: event.toolId, name: event.title, detail: event.detail, state: 'running' };
      }
      return replace([...last.parts, opened]);
    }
    case 'tool-output-delta':
      return replace(
        last.parts.map((part) =>
          part.kind === 'command' && part.id === event.toolId
            ? { ...part, output: clampCapture(part.output + event.chunk) }
            : part,
        ),
      );
    case 'tool-end': {
      // Only the canonical shape reaches here — normalizeChatEvent rewrote the
      // legacy one — but the union still carries both, so narrow before use.
      if (!('toolId' in event)) return messages;
      const settled = event.status === 'ok' ? 'ok' : 'error';
      return replace(
        last.parts.map((part) => {
          if (part.kind === 'command' && part.id === event.toolId) {
            return {
              ...part,
              state: settled,
              exitCode: event.exitCode ?? part.exitCode,
              durationMs: part.startedAt === undefined ? part.durationMs : now - part.startedAt,
              detail: event.summary ?? part.detail,
            };
          }
          if (part.kind === 'tool' && part.id === event.toolId) {
            return { ...part, state: settled, detail: event.summary ?? part.detail };
          }
          // The summary is deliberately dropped for a skill: what a Skill call
          // returns is the skill's own instructions, and pasting a whole
          // SKILL.md under the row would bury the one thing it exists to say.
          // The detail it keeps is what the skill was ASKED to do.
          if (part.kind === 'skill' && part.id === event.toolId) {
            return { ...part, state: settled };
          }
          return part;
        }),
      );
    }
    case 'file-change': {
      const toolId = event.toolId;
      const belongsToOpenCard =
        toolId !== undefined && last.parts.some((part) => part.kind === 'file-change' && part.id === toolId);
      if (belongsToOpenCard) {
        return replace(
          last.parts.map((part) =>
            part.kind === 'file-change' && part.id === toolId
              ? { ...part, files: mergeFileChanges(part.files, event.files) }
              : part,
          ),
        );
      }
      // No tool to hang it on: key the card by where it landed, which is
      // unique within the turn and stable across a replay of it.
      return replace([
        ...last.parts,
        { kind: 'file-change', id: toolId ?? `${last.id}:f${last.parts.length}`, files: event.files },
      ]);
    }
    case 'approval-request':
      return replace([
        ...last.parts,
        {
          kind: 'approval',
          id: event.approvalId,
          approvalKind: event.kind,
          title: event.title,
          detail: event.detail,
          decision: null,
        },
      ]);
    case 'approval-resolved':
      // The prompt becomes the record of what was allowed. Nothing is removed:
      // "I said yes to that" is part of the transcript.
      return replace(
        last.parts.map((part) =>
          part.kind === 'approval' && part.id === event.approvalId ? { ...part, decision: event.decision } : part,
        ),
      );
    case 'subagent-start':
      return replace([
        ...last.parts,
        { kind: 'subagent', id: event.agentId, role: event.role, title: event.title, text: '', state: 'running' },
      ]);
    case 'subagent-delta':
      return replace(
        last.parts.map((part) =>
          part.kind === 'subagent' && part.id === event.agentId
            ? { ...part, text: clampCapture(part.text + event.chunk) }
            : part,
        ),
      );
    case 'subagent-end':
      return replace(
        last.parts.map((part) =>
          part.kind === 'subagent' && part.id === event.agentId
            ? { ...part, state: event.status === 'ok' ? 'ok' : 'error', summary: event.summary ?? part.summary }
            : part,
        ),
      );
    case 'plan-update': {
      // One card per plan: a revision replaces the list in place, so the
      // transcript shows the plan as it stands rather than every draft of it.
      const parts = last.parts.slice();
      const at = parts.findIndex((part) => part.kind === 'plan' && part.id === event.planId);
      const card: ChatPart = { kind: 'plan', id: event.planId, text: event.text };
      if (at === -1) parts.push(card);
      else parts[at] = card;
      return replace(parts);
    }
    case 'image':
      return replace([
        ...last.parts,
        // Prefixed, not the bare toolId: a generated image arrives alongside
        // the tool row for the call that made it, and two parts sharing a
        // React key means the second one does not reliably render — which
        // would be the picture the whole feature exists to show.
        { kind: 'image', id: `img:${event.toolId}`, path: event.path, caption: event.caption },
      ]);
    case 'notice':
      return replace([...last.parts, { kind: 'notice', text: event.text }]);
    case 'turn-complete':
      // Drop a turn that produced nothing at all rather than leaving an empty
      // bubble behind.
      if (last.parts.length === 0) return messages.slice(0, lastIndex);
      return replace(last.parts, false);
    case 'error':
      // A failed turn is the app speaking, not the agent. Appended as a text
      // part this used to render in the agent's own voice and typography, so
      // "rate limit exceeded" or an expired login read as something the model
      // had chosen to say. It carries the prompt that was lost so the row can
      // offer to send it again.
      return replace(
        [...last.parts, { kind: 'notice', text: event.message, tone: 'error', retryText: lastUserText(messages) }],
        false,
      );
    default:
      return messages;
  }
}

/**
 * The ask the transcript is currently waiting on, or null. Approvals block, so
 * there is normally at most one — the OLDEST unanswered one wins, because a
 * driver that managed to stack two is still owed an answer to the first.
 * Pure: the keyboard contract (↵ allow, esc deny) is bound to this id alone.
 */
export function pendingApprovalId(messages: readonly ChatMessage[]): string | null {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === 'approval' && part.decision === null) return part.id;
    }
  }
  return null;
}

/**
 * Rebuild a conversation from its on-disk transcript. Replay goes through the
 * SAME fold as the live stream (`applyChatEvent`), so a reopened chat is
 * assembled by the rules that assembled it the first time — there is no second
 * renderer to drift.
 *
 * A transcript that ends mid-turn (the app quit while the agent was talking)
 * settles: history is not resumable, and a permanently "working" bubble would
 * be a lie.
 */
/**
 * Turn a transcript's saved attachments into something renderable. The bytes
 * are a file in the project, so the URL is the same read route the rest of the
 * app uses; a project we don't know (a bare replay in a test) yields nothing
 * rather than a broken image.
 */
export function replayAttachments(
  attachments: readonly StoredAttachment[] | undefined,
  project: string,
): ChatAttachmentView[] {
  if (!attachments || attachments.length === 0 || project === '') return [];
  return attachments.map((attachment) => ({
    name: attachment.name,
    mimeType: attachment.mimeType,
    relPath: attachment.relPath,
    url: projectFileUrl(project, attachment.relPath),
  }));
}

export function replayTranscript(records: readonly ChatRecord[], project = ''): ChatMessage[] {
  let messages: ChatMessage[] = [];
  for (const record of records) {
    if (record.role === 'user') {
      messages = [...messages, makeUserMessage(record.text, replayAttachments(record.attachments, project))];
      continue;
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'agent' || !last.streaming) messages = [...messages, makeAgentMessage()];
    messages = applyChatEvent(messages, record.event);
  }
  return messages.map((message) => (message.streaming ? { ...message, streaming: false } : message));
}

/**
 * Add evidence to what is already held, keyed on `seq`.
 *
 * Evidence arrives from two places now — a read of the folder's journal when
 * it opens, and the socket as the probe writes more — and they overlap by
 * design: the socket's watcher replays from the top of the file for whoever
 * starts it, so the first window would otherwise show every sweep twice. `seq`
 * is the journal's own line number and the only identity an event has, so it
 * is what decides whether something is new.
 *
 * Ordered by `seq` rather than by arrival, because a replay is history and
 * history is not news; capped at the newest `MAX_EVIDENCE`, which is the rail's
 * appetite, not the folder's.
 */
export function mergeEvidence(
  current: readonly EvidenceEvent[],
  incoming: readonly EvidenceEvent[],
): EvidenceEvent[] {
  if (incoming.length === 0) return current as EvidenceEvent[];
  const bySeq = new Map<number, EvidenceEvent>();
  for (const event of current) bySeq.set(event.seq, event);
  // Later wins: an event re-read from the file is the file's version of it,
  // and the file is the record.
  for (const event of incoming) bySeq.set(event.seq, event);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > MAX_EVIDENCE ? merged.slice(-MAX_EVIDENCE) : merged;
}

/**
 * Which of `incoming` this store has not already folded into sweep progress.
 *
 * Progress is a running total, so an event counted twice moves the counter
 * twice. History read on open must not count at all: a sweep that finished
 * last week is not one run of progress on this window's Playtest button.
 */
export function unseenEvidence(
  current: readonly EvidenceEvent[],
  incoming: readonly EvidenceEvent[],
): EvidenceEvent[] {
  if (current.length === 0) return [...incoming];
  const seen = new Set(current.map((event) => event.seq));
  return incoming.filter((event) => !seen.has(event.seq));
}

/**
 * Fold a batch of evidence events into playtest progress. `sweep-started`
 * declares the denominator (policies x seeds), each `run-finished` advances,
 * and `sweep-finished` ends it. Pure, so the button's state is testable
 * without a socket.
 */
export function applySweepProgress(
  current: AppState['sweep'],
  events: readonly EvidenceEvent[],
): AppState['sweep'] {
  let next = current;
  for (const event of events) {
    switch (event.kind) {
      case 'sweep-started':
        next = {
          running: true,
          done: 0,
          total: event.policies.length * event.seeds.length || null,
          error: null,
        };
        break;
      case 'run-finished':
        next = { ...next, running: true, done: next.done + 1 };
        break;
      case 'sweep-finished':
        next = { ...next, running: false };
        break;
      default:
        break;
    }
  }
  return next;
}

/**
 * How many runs the sweep on the browser will ACTUALLY do, or null when that
 * is not yet knowable.
 *
 * `sweep-started` declares policies x seeds, which is what was asked for. Bots
 * the game cannot support are skipped rather than run, so that number can
 * overstate the work by half, and a progress count whose denominator is never
 * reached is the kind of small lie that makes a person stop trusting the rest.
 * Only the runner's plan knows which ones were dropped, so only a read of the
 * playtest view can correct it.
 *
 * Pure, so the correction is testable without a sweep.
 */
export function plannedRuns(view: PlaytestView): number | null {
  const sweep = view.sweep;
  // A finished sweep's rows describe the LAST run, not the one starting up.
  if (!view.running || sweep === null || sweep.finished) return null;
  const runnable = sweep.policies.filter((policy) => policy.skipReason === null).length;
  return runnable > 0 && sweep.seeds.length > 0 ? runnable * sweep.seeds.length : null;
}

// ---------------------------------------------------------------------------

export const useApp = create<AppState>((set, get) => {
  // --- WebSocket ------------------------------------------------------------
  // One socket per open folder; reconnects with capped backoff and tears down
  // on close. `wsEpoch` invalidates handlers from a superseded attempt so a
  // stale reconnect can't resurrect a socket for a folder that's been closed.
  let ws: WebSocket | null = null;
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsBackoffMs = WS_BACKOFF_INITIAL_MS;
  let wsEpoch = 0;
  let wsAgentProject: string | null = null;
  let loadMetaPromise: Promise<void> | null = null;
  /**
   * Which conversation this window wants to be in, as a frame ready to resend.
   * A chat request made before the socket is open (opening a folder does
   * exactly that) — or one lost to a reconnect — is replayed on connect, so the
   * window never ends up watching a conversation the server isn't sending.
   */
  let chatIntent: Extract<WsFrame, { type: 'chat-open' } | { type: 'chat-new' }> | null = null;

  function requestChat(frame: Extract<WsFrame, { type: 'chat-open' } | { type: 'chat-new' }>): void {
    chatIntent = frame;
    get().sendFrame(frame);
  }

  /**
   * The global Recents list is a fan-out read across every recent folder, and
   * the things that invalidate it (a title landing, a turn finishing, a chat
   * being deleted) arrive in bursts. Coalesce them into one read.
   */
  /**
   * Resolve once this folder's socket is up, or false if it takes too long.
   * Only `startFromHome` needs this: every other send happens in a window that
   * has been connected for a while, but the first message of a brand-new
   * project races the connection it was just handed.
   */
  function waitForState(ready: (state: AppState) => boolean, timeoutMs: number): Promise<boolean> {
    if (ready(get())) return Promise.resolve(true);
    return new Promise((resolve) => {
      let unsubscribe: (() => void) | null = null;
      const timer = setTimeout(() => {
        unsubscribe?.();
        resolve(false);
      }, timeoutMs);
      unsubscribe = useApp.subscribe((state) => {
        if (!ready(state)) return;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(true);
      });
    });
  }

  /**
   * Resolve once the folder's socket is up AND a conversation is open in it.
   * The second half matters as much as the first: a send that beats the
   * `chat-opened` replay gets its optimistic bubble wiped by that replay, and
   * a send the server receives before the conversation binds would mint a
   * second chat for the same first message.
   */
  function waitForChatSurface(timeoutMs = CONNECT_WAIT_MS): Promise<boolean> {
    return waitForState((state) => state.wsStatus === 'connected' && state.activeChatId !== null, timeoutMs);
  }

  /**
   * First run for a folder: land in whichever half of the column can actually
   * answer. Needs BOTH reads (settings and providers) before it decides — a
   * key-less folder with a signed-in Codex must not get pinned to the terminal
   * by whichever read happens to land first.
   */
  /**
   * Show this half of the column, and remember it for the folder.
   *
   * The plumbing behind the mode, with no opinion about whether the move is
   * allowed — that opinion lives in `setConversationMode`, which is what the
   * UI calls. This one is used where the kind is already settled: opening a
   * conversation (the record says which), and starting a new chat.
   */
  function applyConversationMode(mode: ConversationMode): void {
    const project = get().projectPath;
    if (project) writeConversationMode(project, mode);
    set({ conversationMode: mode, conversationModePinned: true });
  }

  /** The conversation this window has open, as its record. Null on Home. */
  function activeConversation(): ChatSummary | null {
    const state = get();
    if (state.activeChatId === null) return null;
    return state.chats.find((chat) => chat.id === state.activeChatId) ?? null;
  }

  /**
   * Start a NEW conversation of this kind. The only way to get one, now that a
   * conversation's kind is fixed when it is created.
   *
   * A chat is not created here: the blank composer is where a chat begins and
   * the first message is what makes the record, which is why a project is
   * never littered with empty chats nobody said anything in. A terminal
   * session has no first message to wait for — the shell is the conversation —
   * so its record is asked for straight away.
   */
  function startConversationOfKind(kind: ConversationMode, title?: string): void {
    if (kind === 'chat') {
      get().newChat();
      return;
    }
    // The shell runs IN the project folder, so without one there is nothing to
    // start and nowhere to write the record.
    if (get().projectPath === null) return;
    // Same clearing as openChat: whatever was queued was meant for the
    // conversation being left, and must not land in this one.
    set({ composing: false, projectView: false, screen: null, chatBusy: false, chatError: null, queued: [] });
    applyConversationMode('terminal');
    requestChat({ type: 'chat-new', kind: 'terminal', ...(title === undefined ? {} : { title }) });
  }

  /**
   * Show a terminal conversation: the one that is already open if it is one,
   * a new one otherwise. Coming BACK to a running session must not mint a
   * second record for it.
   */
  function enterTerminalConversation(title?: string): void {
    const active = activeConversation();
    if (active !== null && conversationKind(active) === 'terminal') {
      applyConversationMode('terminal');
      return;
    }
    startConversationOfKind('terminal', title);
  }

  function maybeSettleConversationMode(): void {
    const state = get();
    if (state.conversationModePinned) return;
    if (state.settings === null || state.providers === null) return;
    set({
      conversationMode: defaultConversationMode(anyChatProviderReady(state.settings, state.providers)),
      conversationModePinned: true,
    });
  }

  let recentChatsTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRecentChats(): void {
    if (recentChatsTimer) return;
    recentChatsTimer = setTimeout(() => {
      recentChatsTimer = null;
      void get().refreshRecentChats();
    }, RECENT_CHATS_DEBOUNCE_MS);
  }

  /**
   * Send the next message someone typed while the agent was still answering.
   *
   * One at a time, and only ever through `sendChat`, so a queued turn is
   * indistinguishable from a typed one by the time it reaches the wire — it
   * carries the same model choice, the same attachments, and lands in the
   * transcript the same way. The rest of the queue stays put and goes on the
   * turn after that.
   *
   * Deliberately NOT called after an error or a dropped socket: firing the
   * next message into a conversation that just failed is how one bad turn
   * becomes three.
   */
  function drainQueue(): void {
    const [next, ...rest] = get().queued;
    if (!next) return;
    // A send into a dead socket fails with a log line and takes the message
    // with it, which is precisely the thing a queue exists to prevent. Leave
    // it where it is; the reconnect drains it (see the `chat-opened` case).
    if (get().wsStatus !== 'connected') return;
    set({ queued: rest });
    get().sendChat(next.text, next.attachments);
  }

  function wsUrl(project: string): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/ws?project=${encodeURIComponent(project)}`;
  }

  function teardownSocket(): void {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (ws) {
      const socket = ws;
      ws = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }

  function scheduleReconnect(project: string, epoch: number): void {
    const delay = wsBackoffMs;
    wsBackoffMs = Math.min(wsBackoffMs * 2, WS_BACKOFF_MAX_MS);
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      if (epoch !== wsEpoch) return;
      connectWs(project);
    }, delay);
  }

  function handleFrame(frame: WsFrame): void {
    switch (frame.type) {
      case 'journal':
        set((state) => ({ journalFeed: [...state.journalFeed, ...frame.entries].slice(-MAX_JOURNAL_FEED) }));
        return;
      case 'evidence':
        set((state) => ({
          evidence: mergeEvidence(state.evidence, frame.events),
          // Only what this window has not already seen. The watcher replays
          // the whole journal to the socket that starts it, and every one of
          // those lines is also in the history read on open, so counting them
          // again would run the progress bar through a sweep that finished
          // before the window existed.
          sweep: applySweepProgress(state.sweep, unseenEvidence(state.evidence, frame.events)),
        }));
        return;
      case 'chat-ready':
        set({ chatDriver: frame.driver });
        return;
      case 'chat-providers':
        // Pushed rather than polled: a ChatGPT login finishes in a browser
        // window this app doesn't own, and the dialog behind it has to notice.
        set({ providers: frame.status });
        return;
      case 'chat-list':
        set({ chats: frame.chats });
        // The index changed (a chat was created, renamed, retitled, deleted),
        // which is exactly what the global list is a view of.
        scheduleRecentChats();
        return;
      case 'chat-opened':
        // A `chat-new` that has landed becomes a plain "open this one" intent,
        // so a later reconnect resumes this chat instead of minting another.
        chatIntent = { type: 'chat-open', chatId: frame.chat.id };
        // The record decides what the column shows. This is the whole of the
        // rule "a conversation has a kind": whatever the window was showing a
        // moment ago, it now shows the thing that was opened.
        applyConversationMode(conversationKind(frame.chat));
        set({
          activeChatId: frame.chat.id,
          messages: replayTranscript(frame.records, get().projectPath ?? ''),
          chatBusy: false,
          chatError: null,
          // A conversation is open, so the blank composer has been answered.
          //
          // `projectView` is deliberately NOT cleared here. Opening a project
          // also opens its newest conversation underneath (that is what
          // connects the socket), and this frame arrives well after
          // `openProject` has said which screen it wants — clearing it here
          // made the project screen appear and then vanish. Leaving a
          // conversation for its project is an explicit act, so it is cleared
          // by the explicit actions instead: `openChat` and `newChat`.
          composing: false,
        });
        // Switching conversations empties the queue, so anything still in it
        // here survived a dropped socket rather than belonging to somewhere
        // else. The connection is back; send it.
        drainQueue();
        return;
      case 'chat-event': {
        // Normalize here as well as inside the fold, so the turn-ending rules
        // below are written once in the canonical vocabulary rather than once
        // per dialect.
        const event = normalizeChatEvent(frame.event);
        set((state) => ({ messages: applyChatEvent(state.messages, event) }));
        if (event.type === 'turn-complete') {
          set({ chatBusy: false });
          // A finished turn moves this chat to the top of every list it is in.
          scheduleRecentChats();
          drainQueue();
        }
        if (event.type === 'error') {
          set({ chatBusy: false, chatError: event.message });
          get().log('error', 'agent', event.message);
        }
        return;
      }
      case 'pty-data':
      case 'pty-exit':
      case 'pty-error':
        ingestPtyFrame(frame);
        return;
      case 'pty-attach':
        ingestPtyAttach(frame);
        return;
      default:
        return; // client -> server frames, and anything this build doesn't know
    }
  }

  function connectWs(project: string): void {
    const epoch = ++wsEpoch;
    teardownSocket();
    // A different folder must never inherit the previous one's terminal
    // session; a same-folder reconnect keeps it (the server-side pty survives
    // the drop detached and is reattached in onopen below).
    if (wsAgentProject !== project) {
      resetAgentSocket();
      wsAgentProject = project;
    }
    set({ wsStatus: 'connecting' });
    const socket = new WebSocket(wsUrl(project));
    ws = socket;

    socket.onopen = () => {
      if (epoch !== wsEpoch) return;
      wsBackoffMs = WS_BACKOFF_INITIAL_MS;
      set({ wsStatus: 'connected' });
      if (chatIntent) socket.send(JSON.stringify(chatIntent));
      if (getAgentSessionSummary().status === 'reconnecting') {
        socket.send(JSON.stringify({ type: 'pty-start', sessionId: ensureAgentPtySessionId() }));
        markAgentStarted('shell');
      }
    };
    socket.onmessage = (event) => {
      if (epoch !== wsEpoch) return;
      let frame: WsFrame;
      try {
        frame = JSON.parse(event.data as string) as WsFrame;
      } catch {
        return;
      }
      handleFrame(frame);
    };
    socket.onclose = () => {
      if (epoch !== wsEpoch) return;
      ws = null;
      set({ wsStatus: 'disconnected' });
      markAgentDisconnected();
      // A conversation does not survive a socket drop (the driver holds an
      // in-process agent), so an in-flight turn is over.
      if (get().chatBusy) {
        set((state) => ({
          chatBusy: false,
          messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        }));
      }
      scheduleReconnect(project, epoch);
    };
  }

  function disconnectWs(): void {
    wsEpoch++;
    wsBackoffMs = WS_BACKOFF_INITIAL_MS;
    chatIntent = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pty-stop' }));
      ws.send(JSON.stringify({ type: 'chat-cancel' }));
    }
    teardownSocket();
    set({ wsStatus: 'disconnected' });
    wsAgentProject = null;
    resetAgentSocket();
  }

  return {
    meta: null,
    projectPath: null,
    projectName: null,
    isHearthProject: false,
    wsStatus: 'disconnected',

    messages: [],
    chatBusy: false,
    queued: [],
    chatDriver: null,
    chatError: null,
    settings: null,
    providers: null,
    chats: [],
    activeChatId: null,
    recentChats: [],

    game: EMPTY_GAME,
    senses: [],
    shimDetected: false,
    gameNonce: 0,

    sweep: { ...IDLE_SWEEP },
    playtest: null,

    evidence: [],
    evidenceOpen: true,

    consoleEntries: [],
    consoleUnread: 0,
    consoleAtBottom: true,

    sidebarCollapsed: readSidebarCollapsed(),
    conversationMode: 'chat',
    conversationModePinned: false,
    paneTab: 'game',
    paneOpen: false,
    paneChoice: null,
    composing: false,
    composeTarget: null,
    projectView: false,
    screen: null,
    narrowTab: 'chat',
    codePeek: { open: false, path: null },
    pendingPrompt: null,
    homeBusy: false,
    updateReady: null,
    personalization: null,

    journalFeed: [],
    agentStatus: 'idle',

    async loadMeta() {
      if (loadMetaPromise) return loadMetaPromise;
      loadMetaPromise = (async () => {
        const meta = await apiMeta();
        if (meta) set({ meta });
        // Reopen the last folder after a reload (dev HMR, F5).
        if (!get().projectPath) {
          let last: string | null = null;
          try {
            last = localStorage.getItem(LAST_WORKSPACE_KEY);
          } catch {
            /* private mode */
          }
          if (last) await get().openWorkspace(last);
        }
      })();
      try {
        await loadMetaPromise;
      } finally {
        loadMetaPromise = null;
      }
    },

    async openWorkspace(path, prompt) {
      const res = await apiOpenWorkspace(path);
      if (!res.ok || !res.info) return { ok: false, error: res.error ?? 'Could not open that folder.' };
      const info: WorkspaceInfo = res.info;
      chatIntent = null;
      try {
        localStorage.setItem(LAST_WORKSPACE_KEY, info.path);
      } catch {
        /* private mode */
      }
      // A folder that has picked a mode before opens in it. One that hasn't
      // opens provisionally in chat and is settled by refreshSettings below,
      // which is the first moment anyone knows whether a key exists.
      const storedMode = readConversationMode(info.path);
      const storedPane = readPaneOpen(info.path);
      set({
        projectPath: info.path,
        projectName: info.name,
        isHearthProject: info.isHearthProject,
        messages: [],
        chatBusy: false,
        chatDriver: null,
        chatError: null,
        providers: null,
        chats: [],
        activeChatId: null,
        queued: [],
        evidence: [],
        journalFeed: [],
        game: EMPTY_GAME,
        senses: [],
        shimDetected: false,
        gameNonce: 0,
        sweep: { ...IDLE_SWEEP },
    playtest: null,
        conversationMode: storedMode ?? 'chat',
        conversationModePinned: storedMode !== null,
        paneTab: 'game',
        // Opening a folder never opens the playtest column by itself. Either
        // this folder asked for it, or a game shows up and it opens then.
        paneOpen: storedPane ?? false,
        paneChoice: storedPane,
        narrowTab: 'chat',
        codePeek: { open: false, path: null },
        pendingPrompt: prompt?.trim() ? prompt.trim() : null,
      });
      connectWs(info.path);
      await Promise.all([
        get().refreshGame(),
        get().refreshSettings(),
        get().refreshProviders(),
        get().refreshChats(),
        get().refreshRecentChats(),
        // The rail is about the folder, so it fills when the folder opens
        // rather than when a sweep happens to run in this window.
        get().refreshEvidence(),
      ]);
      // Land in the most recent conversation, or start the folder's first one.
      // Either way the window opens on a conversation, never on nothing.
      const chats = get().chats;
      if (get().projectPath === info.path) {
        // `chat-new` directly, not `newChat()`: that action shows the blank
        // NEW-CHAT SURFACE, which is a different thing from asking the server
        // for an empty conversation. Opening a project has to land on a real
        // one, or the socket has nothing to send into.
        if (chats.length > 0) get().openChat(chats[0].id);
        else requestChat({ type: 'chat-new' });
      }
      return { ok: true };
    },

    closeWorkspace() {
      try {
        localStorage.removeItem(LAST_WORKSPACE_KEY);
      } catch {
        /* ignore */
      }
      disconnectWs();
      set({
        projectPath: null,
        projectName: null,
        isHearthProject: false,
        messages: [],
        chatBusy: false,
        chatDriver: null,
        chatError: null,
        settings: null,
        providers: null,
        chats: [],
        activeChatId: null,
        queued: [],
        evidence: [],
        journalFeed: [],
        game: EMPTY_GAME,
        senses: [],
        shimDetected: false,
        sweep: { ...IDLE_SWEEP },
    playtest: null,
        conversationMode: 'chat',
        conversationModePinned: false,
        paneOpen: false,
        paneChoice: null,
        codePeek: { open: false, path: null },
        pendingPrompt: null,
      });
      // recentChats deliberately survives: it spans folders, and the rail is
      // the first thing a user looks at after closing one.
    },

    sendChat(text, attachments) {
      const trimmed = text.trim();
      const files = attachments ?? [];
      // A picture on its own is a message; nothing at all is not.
      if (trimmed === '' && files.length === 0) return;
      // A turn already running is not a reason to lose what someone typed.
      // The thought arrives while the agent is mid-answer — that is WHEN
      // people think of things — so it waits its turn instead of being
      // swallowed by a disabled box. Drained by `drainQueue` (see below).
      if (get().chatBusy) {
        set((state) => ({
          queued: [...state.queued, { id: `q${++queuedId}`, text: trimmed, attachments: files }],
        }));
        return;
      }
      // Every turn carries who should answer it and how hard to think, rather
      // than the server remembering a setting: the selector can change between
      // two messages in the same conversation, and the turn is the unit that
      // choice applies to. Additive on the wire — a server that predates the
      // field ignores it, which is why it is omitted rather than sent as null.
      // Reconciled against what the backends currently report they can run: a
      // stored effort the chosen model has stopped accepting is dropped rather
      // than failing the turn on a token picked for a different model. A choice
      // of null still sends no `agent` field at all.
      const agent = agentForTurn(getModelChoice(), get().providers);
      if (
        !get().sendFrame({
          type: 'chat-send',
          text: trimmed,
          ...(agent ? { agent } : {}),
          ...(files.length > 0 ? { attachments: files.map(attachmentPayload) } : {}),
        })
      ) {
        // Said out loud, not only to the console. The console panel lives
        // behind a tab in the game pane, so someone who pressed send and saw
        // nothing happen had no reason to go looking for the explanation.
        const note = 'Not connected. Wait a moment and send again.';
        get().log('error', 'app', note);
        showToast(note, 'error');
        return;
      }
      // The bubble shows the bytes the browser already has. When this chat is
      // reopened the same turn comes back from disk instead, through
      // replayAttachments — the reader can't tell the two apart.
      // A data URL, not the tray's object URL: the composer revokes those as
      // soon as it lets go, and a bubble must not depend on the box that sent
      // it still being alive.
      const shown = files.map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        url: `data:${file.mimeType};base64,${file.data}`,
      }));
      set((state) => ({
        messages: [...state.messages, makeUserMessage(trimmed, shown), makeAgentMessage(Date.now())],
        chatBusy: true,
        chatError: null,
      }));
    },

    cancelChat() {
      get().sendFrame({ type: 'chat-cancel' });
      set((state) => ({
        chatBusy: false,
        messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      }));
    },

    interruptChat() {
      // Stop is about THIS turn, not about the conversation: `chat-interrupt`
      // abandons the running turn and leaves the agent bound, so the next
      // message picks up with everything it already knows. (`chat-cancel`,
      // above, is the teardown — closing the folder, not pressing Stop.)
      get().sendFrame({ type: 'chat-interrupt' });
      // Settle the surface now rather than waiting for the server to confirm:
      // a Stop that leaves the composer locked reads as a Stop that failed.
      set((state) => ({
        chatBusy: false,
        messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      }));
      // "Stop, do this instead" is the whole reason someone queues a message
      // during a turn they can see going wrong. The agent is still bound, so
      // the next one continues the same conversation.
      drainQueue();
    },

    unqueueChat(id) {
      set((state) => ({ queued: state.queued.filter((message) => message.id !== id) }));
    },

    receiveFrame(frame) {
      handleFrame(frame);
    },

    approveChat(approvalId, decision) {
      get().sendFrame({ type: 'chat-approval', approvalId, decision });
      // Optimistic, and safe to be: the server echoes `approval-resolved` with
      // the same decision, which lands on an already-resolved part as a no-op.
      set((state) => ({
        messages: state.messages.map((message) =>
          message.parts.some((part) => part.kind === 'approval' && part.id === approvalId && part.decision === null)
            ? {
                ...message,
                parts: message.parts.map((part) =>
                  part.kind === 'approval' && part.id === approvalId ? { ...part, decision } : part,
                ),
              }
            : message,
        ),
      }));
    },

    async refreshProviders() {
      const project = get().projectPath;
      if (!project) return;
      const providers = await apiChatProviders(project);
      if (get().projectPath !== project) return; // folder changed mid-flight
      set({ providers });
      maybeSettleConversationMode();
    },

    async startOpenAiLogin() {
      const project = get().projectPath;
      if (!project) return;
      const result = await apiOpenAiLogin(project);
      if (!result.ok || !result.authUrl) {
        const note = result.error ?? 'Could not start the ChatGPT sign-in.';
        get().log('error', 'app', note);
        showToast(note, 'error');
        return;
      }
      // The flow finishes in a real browser (it is an OAuth page, and Codex
      // owns the callback); the app hears about it as a `chat-providers`
      // broadcast rather than by polling.
      window.open(result.authUrl, '_blank', 'noopener,noreferrer');
    },

    newProject() {
      if (get().projectPath === null) return; // already there
      get().closeWorkspace();
    },

    newChat() {
      // New chat does not create anything. It shows the same blank surface
      // Home shows — a greeting, a composer, and a project to aim it at —
      // because "what am I working on" is the same question whether or not a
      // project is already open. The conversation is created by the message.
      //
      // The playtest column goes with it: the last conversation's game sitting
      // beside a blank page is the old page refusing to leave. `paneChoice` is
      // untouched, so a project that likes the column open gets it back.
      set({
        composing: true,
        projectView: false,
        screen: null,
        composeTarget: get().projectPath,
        messages: [],
        chatBusy: false,
        chatError: null,
        paneOpen: false,
        queued: [],
      });
      // A new chat is a chat. Leaving the column in the terminal would show a
      // shell to someone who just asked for a blank page to write on.
      applyConversationMode('chat');
    },

    setComposeTarget(path) {
      set({ composeTarget: path });
    },

    async openProject(path) {
      // Land on the project, not in one of its conversations. `openWorkspace`
      // still opens the newest chat behind this — that is what connects the
      // socket and populates the lists — but the screen shown on top is the
      // project's own, which is the thing that was clicked.
      set({ projectView: true, composing: false, screen: null });
      if (get().projectPath !== path) await get().openWorkspace(path);
      // openWorkspace lands in a conversation and clears projectView with it,
      // so the intent is re-asserted once the round trip is done.
      if (get().projectPath === path) set({ projectView: true, composing: false });
    },

    showProject() {
      set({ projectView: true, composing: false, screen: null });
    },

    openScreen(screen) {
      set({ screen });
    },

    closeScreen() {
      set({ screen: null });
    },

    openChat(chatId) {
      // Asking for a conversation is asking to leave the project screen, even
      // when that conversation is already the active one underneath it.
      set({ projectView: false, screen: null });
      if (get().activeChatId === chatId) return;
      // Anything still queued was meant for the conversation being left.
      set({ chatBusy: false, chatError: null, queued: [] });
      requestChat({ type: 'chat-open', chatId });
    },

    async renameChat(chatId, title) {
      const project = get().projectPath;
      if (!project) return;
      const chats = await apiRenameChat(project, chatId, title);
      if (chats && get().projectPath === project) set({ chats });
    },

    async deleteChat(chatId) {
      const project = get().projectPath;
      if (!project) return;
      const chats = await apiDeleteChat(project, chatId);
      if (!chats || get().projectPath !== project) return;
      set({ chats });
      // Deleting the conversation you are reading leaves nowhere to be: land in
      // the next one, or start a fresh one.
      if (get().activeChatId !== chatId) return;
      if (chats.length > 0) {
        set({ activeChatId: null });
        get().openChat(chats[0].id);
      } else {
        // The project still exists and is still open; it just has no
        // conversations left, so it needs a real empty one rather than the
        // blank surface that asks which project to use.
        set({ messages: [], activeChatId: null });
        requestChat({ type: 'chat-new' });
      }
    },

    async refreshChats() {
      const project = get().projectPath;
      if (!project) return;
      const chats = await apiListChats(project);
      if (get().projectPath === project) set({ chats });
    },

    async refreshRecentChats() {
      // No project guard: this list spans folders and is the only thing the
      // rail has to show before one is open.
      set({ recentChats: await apiRecentChats() });
    },

    async openRecentChat(entry) {
      if (get().projectPath !== entry.project.path) {
        const res = await get().openWorkspace(entry.project.path);
        // A folder that has moved or been deleted takes its conversations with
        // it; say so once rather than opening an empty transcript.
        if (!res.ok) {
          const note = res.error ?? `Could not open ${entry.project.name}.`;
          get().log('error', 'app', note);
          showToast(note, 'error');
          return;
        }
      }
      get().openChat(entry.id);
    },

    async startFromHome(text, attachments) {
      const trimmed = text.trim();
      const files = attachments ?? [];
      if ((trimmed === '' && files.length === 0) || get().homeBusy) return { ok: false };
      set({ homeBusy: true, chatError: null });
      // Failures land in chatError as well as the return value: whoever called
      // this may be a composer that doesn't render one, and a first message
      // that silently goes nowhere is the worst thing this path can do.
      const fail = (error: string): { ok: false; error: string } => {
        set({ chatError: error });
        return { ok: false, error };
      };
      try {
        // Aimed at a project that already exists: open it if it isn't open,
        // then start a fresh conversation in it. Aimed at nothing: the message
        // names the project, and creating it is the first thing that happens.
        const target = get().composeTarget;
        let root = target;
        if (root === null) {
          const created = await apiCreateWorkspace(trimmed);
          if (!created.ok || !created.info) {
            return fail(created.error ?? 'Could not start a project for that.');
          }
          root = created.info.path;
        }
        if (get().projectPath !== root) {
          const opened = await get().openWorkspace(root);
          if (!opened.ok) {
            return fail(opened.error ?? 'Could not open that project.');
          }
        } else {
          // Already here, so the only thing missing is somewhere to put the
          // message: a project sitting on a finished conversation must not
          // have this one appended to it.
          requestChat({ type: 'chat-new' });
        }
        // The first thing this folder ever did was receive a chat message, so
        // that is the mode it opens in — the settle heuristic must not park a
        // key-less folder in the terminal over the top of the words just sent.
        // The conversation asked for above is a chat, so this only has to move
        // the column; asking through setConversationMode would try to start a
        // second one.
        applyConversationMode('chat');
        // The send needs the conversation the open just started, not merely
        // the socket. Wait for it; if it never comes, hand the words to the
        // composer instead of dropping them on the floor.
        if (!(await waitForChatSurface())) {
          set({ pendingPrompt: trimmed });
          return fail('The project opened, but nothing is listening yet. Your message is in the composer.');
        }
        set({ composing: false });
        get().sendChat(trimmed, files);
        return { ok: true };
      } finally {
        set({ homeBusy: false });
      }
    },

    watchUpdates() {
      const native = hearthNative();
      // Optional on the preload: a renderer that has updated ahead of its
      // preload (which is exactly the post-update boot) must not throw here.
      if (!native?.onUpdateReady) return () => {};
      return native.onUpdateReady((info) => set({ updateReady: info }));
    },

    async relaunchToUpdate() {
      await hearthNative()?.relaunchToUpdate?.();
    },

    consumePendingPrompt() {
      const pending = get().pendingPrompt;
      if (pending) set({ pendingPrompt: null });
      return pending;
    },

    async refreshGame() {
      const project = get().projectPath;
      if (!project) return;
      const [status, probe] = await Promise.all([apiGameStatus(project), apiProbeStatus(project)]);
      if (get().projectPath !== project) return; // folder changed mid-flight
      if (probe) {
        set((state) => ({
          senses: probe.senses,
          shimDetected: probe.shimDetected,
          // The server is the authority on whether a sweep is running: a reload
          // mid-sweep must still show the spinner, and a sweep that died
          // without writing a `sweep-finished` line must still release it.
          sweep: probe.playing === state.sweep.running ? state.sweep : { ...state.sweep, running: probe.playing },
        }));
        // Only while one is running, and only from the poll that is already
        // happening: this is what corrects the button's denominator once the
        // runner knows which bots the game cannot support. The screen does its
        // own faster read; this is for the window that never opens it.
        if (probe.playing) void get().refreshPlaytest();
      }
      if (!status) return;
      const previous = get().game;
      const changed = status.present !== previous.present || status.entry !== previous.entry || status.mtime !== previous.mtime;
      if (!changed) return;
      // A game arriving where there was none is the one moment the playtest
      // column earns half the window, so that is when it lets itself in — once,
      // and never against a folder that has closed it.
      const appeared = status.present && !previous.present;
      set((state) => ({
        game: status,
        // Only a game that was already on screen needs a reload nonce; the
        // first appearance mounts a fresh iframe anyway.
        gameNonce: previous.present && status.present ? state.gameNonce + 1 : state.gameNonce,
        paneOpen: appeared && state.paneChoice !== false ? true : state.paneOpen,
      }));
    },

    async refreshSettings() {
      const project = get().projectPath;
      if (!project) return;
      const settings = await apiAppSettings(project);
      if (get().projectPath !== project) return;
      set({ settings });
      maybeSettleConversationMode();
    },

    async loadPersonalization() {
      const info = await apiPersonalization();
      // A failed read leaves whatever is already loaded in place. Blanking it
      // would look exactly like the user's own text having been lost.
      if (info) set({ personalization: info });
    },

    async savePersonalization(patch) {
      const info = await apiSavePersonalization(patch);
      if (!info) return false;
      set({ personalization: info });
      return true;
    },

    async startSweep() {
      const project = get().projectPath;
      if (!project || get().sweep.running) return;
      // Optimistic: the button must react to the press, not to the round trip.
      // `total` stays null until sweep-started declares it.
      set({ sweep: { running: true, done: 0, total: null, error: null } });
      const result = await apiStartSweep(project);
      if (get().projectPath !== project) return;
      if (result.ok) {
        set((state) => ({ sweep: { ...state.sweep, total: result.total ?? state.sweep.total } }));
        return;
      }
      // A 409 means one is already running — the spinner is telling the truth,
      // so leave it up rather than flashing an error at a working feature.
      if (result.busy) return;
      set({ sweep: { ...IDLE_SWEEP, error: result.error ?? 'The playtest could not start.' } });
      get().log('error', 'app', result.error ?? 'The playtest could not start.');
    },

    async refreshPlaytest() {
      const project = get().projectPath;
      if (!project) {
        set({ playtest: null });
        return;
      }
      const view = await apiPlaytestView(project);
      // A failed read leaves the last good answer up: blanking it would look
      // exactly like "no playtest has ever run here", which is a claim a
      // dropped request has no business making.
      if (view === null || get().projectPath !== project) return;
      const total = plannedRuns(view);
      set((state) => ({
        playtest: view,
        sweep: total !== null && total !== state.sweep.total ? { ...state.sweep, total } : state.sweep,
      }));
    },

    async refreshEvidence() {
      const project = get().projectPath;
      if (!project) return;
      const events = await apiEvidenceHistory(project);
      if (events.length === 0 || get().projectPath !== project) return;
      // Merged, not assigned: the socket may already have delivered some of
      // this, and a sweep running right now is writing more of it while this
      // request is in the air.
      set((state) => ({ evidence: mergeEvidence(state.evidence, events) }));
    },

    setSidebarCollapsed(collapsed) {
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
      } catch {
        /* private mode: the preference just doesn't persist */
      }
      set({ sidebarCollapsed: collapsed });
    },

    setConversationMode(mode) {
      // The shell runs in the project folder. The switch this replaced said so
      // by disabling its Terminal tab without one; the refusal has to live
      // here now, or aiming the column at Home lands on a terminal that cannot
      // start and cannot explain itself.
      if (mode === 'terminal' && get().projectPath === null) return;
      const active = activeConversation();
      // Nothing open to contradict (Home, a window that has not landed in a
      // conversation yet), or the open one is already the kind being asked
      // for: this is just aiming the column, which is what it always was.
      if (active === null || conversationKind(active) === mode) {
        applyConversationMode(mode);
        return;
      }
      // Asking for the other kind while a conversation is open is not a switch
      // any more — the record cannot change what it is. Starting another one is
      // the honest answer, and it is the same act the composer's Terminal rows
      // perform.
      startConversationOfKind(mode);
    },

    /**
     * Picking a terminal option in the composer, all the way through.
     *
     * The shell is spawned exactly as the Start button spawns it, and the
     * command is TYPED into it rather than replacing it: when the agent exits
     * the user is left at a working prompt instead of a dead session, and the
     * reattach path (ws.ts keeps the pty alive across a dropped socket) needs
     * to know nothing about any of this.
     *
     * The keystrokes go out immediately after pty-start. That is safe by the
     * server's own contract: input arriving before the pty has spawned is
     * queued on the session and flushed once it has (`pendingInput` in ws.ts).
     * Nothing is re-sent afterwards, and the reconnect path in connectWs()
     * sends pty-start alone — so a socket drop reattaches to the agent that is
     * already there rather than starting a second one inside it.
     */
    startTerminalCli(cli) {
      const state = get();
      const session = getAgentSessionSummary();
      const plan = planTerminalLaunch({
        cli,
        status: session.status,
        launched: session.cli,
        connected: state.wsStatus === 'connected',
        hasProject: state.projectPath !== null,
      });
      if (plan.action === 'blocked') {
        // The picker disables these rows and shows the same sentence, so this
        // is the backstop for a click against a stale menu.
        get().log('error', 'app', plan.reason);
        return;
      }
      if (plan.action === 'show') {
        enterTerminalConversation(cli.label);
        return;
      }
      const down = 'Terminal: the connection is down. Wait a moment and try again.';
      if (plan.action === 'start') {
        if (!get().sendFrame({ type: 'pty-start', sessionId: ensureAgentPtySessionId() })) {
          get().log('error', 'app', down);
          return;
        }
        // Marked running before the mode flips, because TerminalPane starts a
        // shell of its own when it mounts onto an idle session — and a second
        // pty-start would supersede this one, taking the queued command with it.
        markAgentStarted('shell');
      }
      if (!get().sendFrame({ type: 'pty-input', data: plan.input })) {
        get().log('error', 'app', down);
        return;
      }
      markAgentCli({ id: cli.id, label: cli.label });
      // The session gets a conversation of its own, named after the CLI, so it
      // is listed and reopenable like everything else the user has made.
      enterTerminalConversation(cli.label);
    },

    setPaneTab(tab) {
      set(tab === 'console' ? { paneTab: tab, consoleUnread: 0 } : { paneTab: tab });
    },

    setPaneOpen(open) {
      const project = get().projectPath;
      if (project) writePaneOpen(project, open);
      // Closing the column in the narrow layout would otherwise leave the
      // window on a tab that no longer exists.
      set(open ? { paneOpen: true, paneChoice: true } : { paneOpen: false, paneChoice: false, narrowTab: 'chat' });
    },

    setNarrowTab(tab) {
      set({ narrowTab: tab });
    },

    setEvidenceOpen(open) {
      set({ evidenceOpen: open });
    },

    openCodePeek(path) {
      set((state) => ({ codePeek: { open: true, path: path ?? state.codePeek.path } }));
    },

    closeCodePeek() {
      set((state) => ({ codePeek: { open: false, path: state.codePeek.path } }));
    },

    log(level, source, message, link) {
      set((state) => ({
        consoleEntries: [...state.consoleEntries.slice(-MAX_CONSOLE + 1), makeEntry(level, source, message, link)],
        // An error is unread when the reader can't see the live tail: the
        // Console tab isn't showing, or it is but they've scrolled up.
        consoleUnread:
          level === 'error' && (state.paneTab !== 'console' || !state.consoleAtBottom)
            ? state.consoleUnread + 1
            : state.consoleUnread,
      }));
    },

    clearConsole() {
      set({ consoleEntries: [], consoleUnread: 0 });
    },

    setConsoleAtBottom(atBottom) {
      set((state) => ({
        consoleAtBottom: atBottom,
        consoleUnread: atBottom && state.paneTab === 'console' ? 0 : state.consoleUnread,
      }));
    },

    sendFrame(frame) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },
  };
});

/**
 * Back-compat alias. The terminal layer (useAgentSocket.ts) mirrors its status
 * into this store and is shared verbatim with the previous shell.
 */
export const useEditor = useApp;
export type EditorStore = AppState;
