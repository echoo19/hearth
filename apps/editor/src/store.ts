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
 * outside this store (components/agent/useAgentSocket.ts) so it survives its
 * tab being hidden.
 */
import { create } from 'zustand';
import { apiAppSettings, apiGameStatus, apiMeta, apiOpenWorkspace, apiProbeStatus } from './api';
import type {
  AppSettingsInfo,
  ChatDriverKind,
  ChatEvent,
  ChatMessage,
  ChatPart,
  ConsoleEntry,
  ConsoleLevel,
  ConsoleSource,
  EvidenceEvent,
  GameStatus,
  JournalEntry,
  Sense,
  ServerMeta,
  WorkspaceInfo,
} from './types';
import type { WsFrame } from '../server/ws';
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
export type PaneTab = 'game' | 'terminal' | 'console';

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

  // --- Game pane ------------------------------------------------------------
  game: GameStatus;
  senses: Sense[];
  /** Bumped whenever the game's files change, so the iframe reloads. */
  gameNonce: number;

  // --- Evidence -------------------------------------------------------------
  evidence: EvidenceEvent[];
  evidenceOpen: boolean;

  // --- Console --------------------------------------------------------------
  consoleEntries: ConsoleEntry[];
  consoleUnread: number;
  consoleAtBottom: boolean;

  // --- Shell ----------------------------------------------------------------
  paneTab: PaneTab;
  /** Narrow layout only: the conversation and the pane stack become tabs. */
  narrowTab: 'chat' | 'pane';
  codePeek: { open: boolean; path: string | null };
  /** Prompt handed over from the launcher, consumed by the composer on mount. */
  pendingPrompt: string | null;

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
  sendChat(text: string): void;
  cancelChat(): void;
  consumePendingPrompt(): string | null;
  refreshGame(): Promise<void>;
  refreshSettings(): Promise<void>;
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
const WS_BACKOFF_INITIAL_MS = 1000;
const WS_BACKOFF_MAX_MS = 5000;
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

// ---------------------------------------------------------------------------
// Conversation reducer — pure, so the streaming assembly is unit-testable
// without a socket or a React tree.
// ---------------------------------------------------------------------------

export function makeUserMessage(text: string): ChatMessage {
  return { id: `m${++messageId}`, role: 'user', parts: [{ kind: 'text', text }], streaming: false };
}

export function makeAgentMessage(): ChatMessage {
  return { id: `m${++messageId}`, role: 'agent', parts: [], streaming: true };
}

/**
 * Fold one ChatEvent into the message list. Text deltas extend the trailing
 * text part (or open one), so a run of deltas is one paragraph rather than a
 * thousand fragments; a tool call closes the current text part, which is what
 * makes chips land inline where they actually happened.
 *
 * Returns the same array identity when nothing applies, so React skips work.
 */
export function applyChatEvent(messages: ChatMessage[], event: ChatEvent): ChatMessage[] {
  const lastIndex = messages.length - 1;
  const last = lastIndex >= 0 ? messages[lastIndex] : null;
  if (!last || last.role !== 'agent' || !last.streaming) return messages;

  const replace = (parts: ChatPart[], streaming = true): ChatMessage[] => {
    const next = messages.slice();
    next[lastIndex] = { ...last, parts, streaming };
    return next;
  };

  switch (event.type) {
    case 'text-delta': {
      const parts = last.parts.slice();
      const tail = parts[parts.length - 1];
      if (tail && tail.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: tail.text + event.text };
      else parts.push({ kind: 'text', text: event.text });
      return replace(parts);
    }
    case 'tool-start':
      return replace([
        ...last.parts,
        { kind: 'tool', id: event.id, name: event.name, detail: event.detail, state: 'running' },
      ]);
    case 'tool-end':
      return replace(
        last.parts.map((part) =>
          part.kind === 'tool' && part.id === event.id
            ? { ...part, state: event.ok ? 'ok' : 'error', detail: event.detail ?? part.detail }
            : part,
        ),
      );
    case 'done':
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
        set((state) => ({ evidence: [...state.evidence, ...frame.events].slice(-MAX_EVIDENCE) }));
        return;
      case 'chat-ready':
        set({ chatDriver: frame.driver });
        return;
      case 'chat-event': {
        const event = frame.event;
        set((state) => ({ messages: applyChatEvent(state.messages, event) }));
        if (event.type === 'done') set({ chatBusy: false });
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

    game: EMPTY_GAME,
    senses: [],
    gameNonce: 0,

    evidence: [],
    evidenceOpen: true,

    consoleEntries: [],
    consoleUnread: 0,
    consoleAtBottom: true,

    paneTab: 'game',
    narrowTab: 'chat',
    codePeek: { open: false, path: null },
    pendingPrompt: null,

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
      try {
        localStorage.setItem(LAST_WORKSPACE_KEY, info.path);
      } catch {
        /* private mode */
      }
      set({
        projectPath: info.path,
        projectName: info.name,
        isHearthProject: info.isHearthProject,
        messages: [],
        chatBusy: false,
        chatDriver: null,
        chatError: null,
        evidence: [],
        journalFeed: [],
        game: EMPTY_GAME,
        senses: [],
        gameNonce: 0,
        paneTab: 'game',
        narrowTab: 'chat',
        codePeek: { open: false, path: null },
        pendingPrompt: prompt?.trim() ? prompt.trim() : null,
      });
      connectWs(info.path);
      await Promise.all([get().refreshGame(), get().refreshSettings()]);
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
        evidence: [],
        journalFeed: [],
        game: EMPTY_GAME,
        senses: [],
        codePeek: { open: false, path: null },
        pendingPrompt: null,
      });
    },

    sendChat(text) {
      const trimmed = text.trim();
      if (trimmed === '' || get().chatBusy) return;
      if (!get().sendFrame({ type: 'chat-send', text: trimmed })) {
        get().log('error', 'app', 'Not connected — wait a moment and send again.');
        return;
      }
      set((state) => ({
        messages: [...state.messages, makeUserMessage(trimmed), makeAgentMessage()],
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

    consumePendingPrompt() {
      const pending = get().pendingPrompt;
      if (pending) set({ pendingPrompt: null });
      return pending;
    },

    async refreshGame() {
      const project = get().projectPath;
      if (!project) return;
      const [status, senses] = await Promise.all([apiGameStatus(project), apiProbeStatus(project)]);
      if (get().projectPath !== project) return; // folder changed mid-flight
      if (senses.length > 0) set({ senses });
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
      if (get().projectPath === project) set({ settings });
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
