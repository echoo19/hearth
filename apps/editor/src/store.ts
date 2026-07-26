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
  apiGameStatus,
  apiListChats,
  apiMeta,
  apiOpenAiLogin,
  apiOpenWorkspace,
  apiProbeStatus,
  apiRecentChats,
  apiRenameChat,
  apiStartSweep,
  projectFileUrl,
} from './api';
import { attachmentPayload, type PendingAttachment } from './chat/attachments';
import type {
  AppSettingsInfo,
  ApprovalDecision,
  ChatAttachmentView,
  ChatDriverKind,
  ChatEvent,
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
  RecentChatEntry,
  Sense,
  ServerMeta,
  StoredAttachment,
  UpdateReadyInfo,
  WorkspaceInfo,
} from './types';
import type { WsFrame } from '../server/ws';
import { getModelChoice } from './chat/modelChoice';
import { hearthNative } from './native';
import {
  ensureAgentPtySessionId,
  getAgentSessionSummary,
  ingestPtyAttach,
  ingestPtyFrame,
  markAgentDisconnected,
  markAgentStarted,
  resetAgentSocket,
  type AgentStatus,
} from './components/agent/useAgentSocket';

/** Which surface the right-hand stack is showing. */
export type PaneTab = 'game' | 'console';

/**
 * What the conversation column IS right now. Both are first-class ways to talk
 * to an agent: `chat` is the built-in driver (Agent SDK or the stub), `terminal`
 * is the user's own CLI agent — `claude`, `codex`, anything — in a real shell in
 * the project folder. The terminal is not a fallback; it is the other half of
 * the same column.
 */
export type ConversationMode = 'chat' | 'terminal';

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
  /** Narrow layout only: the conversation and the pane stack become tabs. */
  narrowTab: 'chat' | 'pane';
  codePeek: { open: boolean; path: string | null };
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
  /** Answer a blocking ask, and show the answer without waiting for the round trip. */
  approveChat(approvalId: string, decision: ApprovalDecision): void;
  refreshProviders(): Promise<void>;
  /** Begin the ChatGPT device flow and open the page it hands back. */
  startOpenAiLogin(): Promise<void>;
  /** Start a fresh conversation and switch to it. */
  newChat(): void;
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
  /** Play the game and stream what the probe finds into the evidence rail. */
  startSweep(): Promise<void>;
  setSidebarCollapsed(collapsed: boolean): void;
  /** Explicit pick — persisted for this folder and never re-derived after. */
  setConversationMode(mode: ConversationMode): void;
  setPaneTab(tab: PaneTab): void;
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

export function makeAgentMessage(): ChatMessage {
  return { id: `m${++messageId}`, role: 'agent', parts: [], streaming: true };
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
        parts[parts.length - 1] = { kind: 'reasoning', text: tail.text + event.text };
      } else {
        parts.push({ kind: 'reasoning', text: event.text });
      }
      return replace(parts);
    }
    case 'tool-begin':
      // A shell command is the one tool with a body worth keeping, so it opens
      // its own part with a capture buffer. Everything else is a chip.
      return replace([
        ...last.parts,
        event.kind === 'command'
          ? {
              kind: 'command',
              id: event.toolId,
              title: event.title,
              detail: event.detail,
              output: '',
              state: 'running',
              startedAt: now,
            }
          : { kind: 'tool', id: event.toolId, name: event.title, detail: event.detail, state: 'running' },
      ]);
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
      return replace([...last.parts, { kind: 'text', text: event.message }], false);
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
          evidence: [...state.evidence, ...frame.events].slice(-MAX_EVIDENCE),
          sweep: applySweepProgress(state.sweep, frame.events),
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
        set({
          activeChatId: frame.chat.id,
          messages: replayTranscript(frame.records, get().projectPath ?? ''),
          chatBusy: false,
          chatError: null,
        });
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

    evidence: [],
    evidenceOpen: true,

    consoleEntries: [],
    consoleUnread: 0,
    consoleAtBottom: true,

    sidebarCollapsed: readSidebarCollapsed(),
    conversationMode: 'chat',
    conversationModePinned: false,
    paneTab: 'game',
    narrowTab: 'chat',
    codePeek: { open: false, path: null },
    pendingPrompt: null,
    homeBusy: false,
    updateReady: null,

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
        evidence: [],
        journalFeed: [],
        game: EMPTY_GAME,
        senses: [],
        shimDetected: false,
        gameNonce: 0,
        sweep: { ...IDLE_SWEEP },
        conversationMode: storedMode ?? 'chat',
        conversationModePinned: storedMode !== null,
        paneTab: 'game',
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
      ]);
      // Land in the most recent conversation, or start the folder's first one.
      // Either way the window opens on a conversation, never on nothing.
      const chats = get().chats;
      if (get().projectPath === info.path) {
        if (chats.length > 0) get().openChat(chats[0].id);
        else get().newChat();
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
        evidence: [],
        journalFeed: [],
        game: EMPTY_GAME,
        senses: [],
        shimDetected: false,
        sweep: { ...IDLE_SWEEP },
        conversationMode: 'chat',
        conversationModePinned: false,
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
      if ((trimmed === '' && files.length === 0) || get().chatBusy) return;
      // Every turn carries who should answer it and how hard to think, rather
      // than the server remembering a setting: the selector can change between
      // two messages in the same conversation, and the turn is the unit that
      // choice applies to. Additive on the wire — a server that predates the
      // field ignores it, which is why it is omitted rather than sent as null.
      const agent = getModelChoice();
      if (
        !get().sendFrame({
          type: 'chat-send',
          text: trimmed,
          ...(agent ? { agent } : {}),
          ...(files.length > 0 ? { attachments: files.map(attachmentPayload) } : {}),
        })
      ) {
        get().log('error', 'app', 'Not connected — wait a moment and send again.');
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
        messages: [...state.messages, makeUserMessage(trimmed, shown), makeAgentMessage()],
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
        get().log('error', 'app', result.error ?? 'Could not start the ChatGPT sign-in.');
        return;
      }
      // The flow finishes in a real browser (it is an OAuth page, and Codex
      // owns the callback); the app hears about it as a `chat-providers`
      // broadcast rather than by polling.
      window.open(result.authUrl, '_blank', 'noopener,noreferrer');
    },

    newChat() {
      // Clear the surface immediately: pressing New chat must feel like a blank
      // page, not like waiting for the server to agree.
      set({ messages: [], chatBusy: false, chatError: null, activeChatId: null });
      requestChat({ type: 'chat-new' });
    },

    openChat(chatId) {
      if (get().activeChatId === chatId) return;
      set({ chatBusy: false, chatError: null });
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
        get().newChat();
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
          get().log('error', 'app', res.error ?? `Could not open ${entry.project.name}.`);
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
        const created = await apiCreateWorkspace(trimmed);
        if (!created.ok || !created.info) {
          return fail(created.error ?? 'Could not make a folder for that.');
        }
        // openWorkspace lands in the folder's newest conversation, or starts
        // one — a folder made a millisecond ago has none, so that is already
        // the blank chat this message belongs in.
        const opened = await get().openWorkspace(created.info.path);
        if (!opened.ok) {
          return fail(opened.error ?? 'Could not open the folder that was just made.');
        }
        // The first thing this folder ever did was receive a chat message, so
        // that is the mode it opens in — the settle heuristic must not park a
        // key-less folder in the terminal over the top of the words just sent.
        get().setConversationMode('chat');
        // The send needs the conversation the open just started, not merely
        // the socket. Wait for it; if it never comes, hand the words to the
        // composer instead of dropping them on the floor.
        if (!(await waitForChatSurface())) {
          set({ pendingPrompt: trimmed });
          return fail('The folder opened, but nothing is listening yet. Your message is in the composer.');
        }
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
      }
      if (!status) return;
      const previous = get().game;
      const changed = status.present !== previous.present || status.entry !== previous.entry || status.mtime !== previous.mtime;
      if (!changed) return;
      set((state) => ({
        game: status,
        // Only a game that was already on screen needs a reload nonce; the
        // first appearance mounts a fresh iframe anyway.
        gameNonce: previous.present && status.present ? state.gameNonce + 1 : state.gameNonce,
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

    setSidebarCollapsed(collapsed) {
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
      } catch {
        /* private mode: the preference just doesn't persist */
      }
      set({ sidebarCollapsed: collapsed });
    },

    setConversationMode(mode) {
      const project = get().projectPath;
      if (project) writeConversationMode(project, mode);
      set({ conversationMode: mode, conversationModePinned: true });
    },

    setPaneTab(tab) {
      set(tab === 'console' ? { paneTab: tab, consoleUnread: 0 } : { paneTab: tab });
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
