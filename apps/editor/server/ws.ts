/**
 * The editor's WebSocket channel, mounted at /api/ws alongside the /api/*
 * HTTP routes (see projectServer.ts). It carries several kinds of frames over
 * the same socket:
 *
 *  - journal: external-change awareness (a CLI/MCP agent mutating the
 *    project makes the editor notice and refresh). Broadcast to every
 *    socket subscribed to that project root.
 *  - pty-*: the embedded project shell spawned via PtyManager. A terminal is per-client,
 *    not broadcast: pty-data/pty-exit/pty-error only ever go back over the
 *    same socket whose pty-start spawned (or reattached) that connection's pty.
 *  - chat-*: the conversation. A socket is looking at exactly one chat, and a
 *    live ChatDriver is keyed by (root, chatId) — see chat.ts and
 *    chatStore.ts — so two windows on one conversation share its agent, and a
 *    driver only dies when the last of them leaves. Deliberately independent
 *    of the pty channel: a chat failure must never take the terminal down, and
 *    vice versa.
 *
 *    Every turn and tool event is appended to `.hearth/chats/<id>.jsonl` as it
 *    streams, so HISTORY survives anything (a socket drop, a quit, a crash)
 *    even though the live driver does not. Opening a chat replays that file;
 *    the next send binds a fresh backend.
 *
 * One socket subscribes to exactly one project (?project=<absolute path> on
 * the upgrade request). Sockets sharing a project root share a single
 * journalWatcher; the watcher is torn down once the last socket for that
 * root disconnects, and all watchers (and all live ptys) are torn down when
 * the http server closes.
 *
 * Pty lifetime is decoupled from socket lifetime: a pty-start carrying a
 * sessionId token survives its socket dropping (sleep/wake, network blips) —
 * the session detaches, buffers output, and a later pty-start with the same
 * token reattaches to it with a pty-attach replay (tmux-style). Explicit
 * teardown (pty-stop, a superseding pty-start on the same socket, server
 * close) still kills, and a linger timeout reaps abandoned detached ptys.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import path from 'node:path';
import { type JournalEntry, type DesktopPlatform, type DesktopBuildResult } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { startJournalWatcher } from './journalWatcher.js';
import {
  createChatDriver,
  endsTurn,
  parseAgentOptions,
  readAppSettings,
  resolveClaudeExecutable,
  StubDriver,
  type AgentToolAccess,
  type AgentTurnOptions,
  type ApprovalDecision,
  type ChatDriver,
  type ChatDriverKind,
  type ChatEvent,
  type ChatProvider,
  type SlashCommandInfo,
} from './chat.js';
import { resolveCodexBinary } from './chatDrivers/codex.js';
import { codexPermissionParams } from './chatDrivers/codexWire.js';
import { readPermissionMode, type PermissionMode } from './permissionMode.js';
import { providerBus, type ChatProviderStatus } from './chatProviders.js';
import {
  parseAttachmentInputs,
  parseStagedAttachmentInputs,
  saveAttachments,
  storedAttachment,
  type ChatAttachment,
} from './chatAttachments.js';
import {
  appendChatRecord,
  createChat,
  getChat,
  listChats,
  markChatUsed,
  prunePendingChats,
  readTranscript,
  safeChatId,
  setChatClaudeSessionId,
  setChatProvider,
  setChatThreadId,
  type ChatKind,
  type ChatRecord,
  type ChatSummary,
} from './chatStore.js';
import {
  appendEngineerRecord,
  readDevTeamState,
  readEngineerRecords,
  writeDevTeamState,
  type DevTeamSnapshot,
} from './devTeamStore.js';
import { DevTeamRuntime, type DevTeamEngineerRequest } from './devTeamRuntime.js';
import { type ProjectServerContext, resolveToolPaths } from './projectServer.js';
import { PtyManager, ScrollbackBuffer, type PtyBackend, type PtyHandle } from './ptyManager.js';
import { ensureHearthShim, hearthPtyEnv } from './hearthShim.js';
import { projectShellEnv } from './shellEnv.js';
import { isRequestAllowed } from './originGuard.js';
import type { TesterPhase } from './tester/session.js';
import type { TesterNote } from './tester/types.js';

/** Desktop-packaging stages, mirroring @hearth/shipping's PackageStage. */
export type ExportStage = 'stage' | 'download' | 'package' | 'sign' | 'notarize' | 'zip';

/** Result payload carried by an export-done frame (exportDesktop's data). */
export interface DesktopExportResult {
  outDir: string;
  slug: string;
  builds: DesktopBuildResult[];
}

/**
 * Server->client frames for a running desktop export job (see
 * ctx.startDesktopExport). Progress streams as export-progress, then exactly
 * one terminal frame: export-done on success or export-error on failure. A
 * per-platform failure carries the `platform` it failed on.
 */
export type ExportFrame =
  | {
      type: 'export-progress';
      jobId: string;
      platform: DesktopPlatform | null;
      stage: ExportStage;
      message: string;
    }
  | { type: 'export-done'; jobId: string; result: DesktopExportResult }
  | {
      type: 'export-error';
      jobId: string;
      platform?: DesktopPlatform;
      message: string;
    };

/**
 * Server->client frames for a running tester session.
 *
 * The pictures do not come this way: they ride the probe stream's own socket,
 * because ten JPEGs a second do not belong in application state. What comes
 * here is small and changes a handful of times a session, which is exactly what
 * the shared channel is for. `tester-thought` carries the tester's prose as it
 * arrives, so a person can read along with the frame beside it.
 */
export type TesterFrame =
  | { type: 'tester-started'; session: number; maxSteps: number }
  | { type: 'tester-phase'; phase: TesterPhase }
  | { type: 'tester-thought'; text: string; turn: number }
  | { type: 'tester-done'; note: TesterNote }
  | { type: 'tester-error'; message: string };

export type WsFrame =
  | { type: 'journal'; entries: JournalEntry[] }
  // Conversation. A socket is looking at exactly one chat: `chat-new` starts
  // one, `chat-open` switches to an existing one, and both are answered with
  // `chat-opened` carrying that chat's transcript replayed from disk. The
  // server lazily binds a driver on the first `chat-send`; `chat-ready` reports
  // which backend answered so the UI can name it honestly. `chat-list` is
  // broadcast to every socket on the folder whenever the index changes.
  // `agent` is the composer's model/effort pick, sent with every turn. It is
  // OPTIONAL in both directions: a client that predates the selector omits it
  // and gets exactly the old behavior, and a server that predates it ignores
  // the field.
  // `attachments` are opaque tokens for files streamed over HTTP first.
  // Older clients may still put base64 payloads here; both forms are optional
  // and validated on arrival — see chatAttachments.ts.
  | { type: 'chat-send'; text: string; agent?: unknown; attachments?: unknown } // client -> server
  | { type: 'chat-cancel' } // client -> server
  // `kind` is the whole choice between a chat and a terminal session, and it
  // is made HERE — at creation — because a conversation cannot change kind
  // afterwards. Optional so a client that predates it still starts a chat,
  // which is what it always meant. `title` names a session nothing will ever
  // name for it (a terminal takes no first message); omitted for a chat, which
  // is named by what is first asked of it.
  | { type: 'chat-new'; kind?: ChatKind; title?: string } // client -> server
  | { type: 'chat-open'; chatId: string } // client -> server
  // The answer to an `approval-request` event. The agent's turn is genuinely
  // BLOCKED until this arrives, which is why it rides the same socket as the
  // events rather than an HTTP round trip.
  | {
      type: 'chat-approval';
      approvalId: string;
      decision: ApprovalDecision;
      choiceId?: string;
    } // client -> server
  // Answers are transient: drivers receive them, but only the corresponding
  // input-resolved action is ever written to the transcript.
  | {
      type: 'chat-input-response';
      inputId: string;
      action: 'submit' | 'cancel';
      answers?: Record<string, string | number | boolean | string[]>;
    } // client -> server
  | { type: 'devteam-approve-spec' } // client -> server
  | { type: 'devteam-pause' } // client -> server
  | { type: 'devteam-resume' } // client -> server
  | { type: 'devteam-stop' } // client -> server
  | {
      type: 'devteam-engineer-approval';
      engineerId: string;
      approvalId: string;
      decision: ApprovalDecision;
      choiceId?: string;
    } // client -> server
  | {
      type: 'devteam-engineer-input';
      engineerId: string;
      inputId: string;
      action: 'submit' | 'cancel';
      answers?: Record<string, string | number | boolean | string[]>;
    } // client -> server
  | { type: 'chat-commands-list' } // client -> server
  | { type: 'chat-commands'; chatId?: string; commands: SlashCommandInfo[] }
  // Stop the running turn but KEEP the conversation: `chat-cancel` tears the
  // whole backend down (and the next send binds a fresh one), which is the
  // wrong thing to do to someone who just wants the agent to stop talking.
  | { type: 'chat-interrupt' } // client -> server
  | { type: 'chat-handoff-cli'; requestId: string; sessionId: string } // client -> server
  | { type: 'chat-handoff-ready'; requestId: string; provider: ChatProvider; label: string }
  | { type: 'chat-handoff-error'; requestId: string; message: string }
  | { type: 'chat-ready'; driver: ChatDriverKind }
  // `chatId` names the conversation this event belongs to. It used to carry
  // none, so a window had no way to tell an event of the chat it is showing
  // from one belonging to a conversation it left: a retired session's last
  // words were rendered into whatever the window had moved on to, and cleared
  // that conversation's busy state with them. The server no longer sends those
  // (see `broadcastChatEvent`), and a client should still ignore an event whose
  // `chatId` is not the one it is showing. Optional so a client that predates
  // it is unaffected.
  | { type: 'chat-event'; chatId?: string; event: ChatEvent }
  | { type: 'devteam-state'; chatId: string; state: DevTeamSnapshot }
  | { type: 'devteam-event'; chatId: string; engineerId: string; event: ChatEvent }
  | { type: 'chat-opened'; chat: ChatSummary; records: ChatRecord[] }
  | { type: 'chat-list'; chats: ChatSummary[] }
  // Provider auth moved (a key was saved, a ChatGPT sign-in completed in a
  // browser tab). Broadcast so Settings updates itself.
  | { type: 'chat-providers'; status: ChatProviderStatus }
  | { type: 'pty-data'; data: string }
  | { type: 'pty-exit'; code: number }
  | { type: 'pty-input'; data: string } // client -> server
  | { type: 'pty-resize'; cols: number; rows: number }
  // sessionId (an unguessable client-generated token) makes the session
  // resumable: if a detached pty with this token is still alive for the same
  // project root, pty-start reattaches to it instead of spawning.
  | { type: 'pty-start'; sessionId?: string }
  | { type: 'pty-stop' } // client -> server: explicit kill (the panel's Stop button)
  | { type: 'pty-error'; message: string }
  // Reply to a pty-start that reattached: `replay` is the server-buffered
  // tail of everything the pty emitted (capped — `dropped` counts evicted
  // earlier bytes), sent before live pty-data streaming resumes.
  | {
      type: 'pty-attach';
      replay: string;
      dropped: number;
      handoff?: { provider: ChatProvider; label: string };
    }
  | ExportFrame
  | TesterFrame;

interface ProjectChannel {
  sockets: Set<WebSocket>;
  dispose: () => void;
}

/**
 * One live conversation, keyed by (root, chatId) rather than by socket: two
 * windows looking at the same chat drive the same agent and see the same
 * stream. `driver` is null only while the backend binds. A session with no
 * watchers lingers briefly so a reload or transient socket drop can reattach
 * to the same in-process agent.
 */
interface ChatSession {
  key: string;
  root: string;
  chatId: string;
  /** Correlates runtime lead operations to this replaceable driver binding. */
  bindingId: string;
  driver: ChatDriver | null;
  /**
   * The permission mode this driver was BUILT with. Both backends fix the
   * policy when the session opens (codex at `thread/start`, the Agent SDK at
   * `query()`), so this is not a cache of the preference, it is what the live
   * agent is actually running under. `ensureChat` compares it to what is on
   * disk and rebinds when they differ.
   */
  permissionMode: PermissionMode;
  /**
   * The provider+model this driver was BOUND with, as `agentBindKey` spells
   * it, or null when the binding turn expressed no choice. The same rule as
   * `permissionMode` above, for the same reason: both backends fix the model
   * when the session opens (codex could take one per turn, but the Agent SDK's
   * is a `query()` option), so a turn that names a different provider or model
   * has to rebind or the pick in the composer is a lie. `ensureChat` compares
   * this to the incoming turn's choice — a turn expressing NO choice matches
   * anything, which is what keeps an old client (and an effort-only change)
   * from restarting the agent every message.
   */
  agentKey: string | null;
  /** Last normalized selection for this binding, including per-turn effort. */
  agent: AgentTurnOptions | null;
  sockets: Set<WebSocket>;
  /** Retires a detached chat nobody reattached to. */
  lingerTimer?: ReturnType<typeof setTimeout>;
  /**
   * Settles when the bind attempt this session was created for is over, driver
   * set or driver failed.
   *
   * A conversation has exactly one backend, and binding it takes as long as a
   * backend takes to start. A send that arrives inside that window belongs to
   * this session, so it waits here: handing it the session as it stands would
   * hand it a `driver` that is still null, which is a message written to the
   * transcript and delivered to nobody.
   */
  binding: Promise<void>;
  /**
   * Settles when the drain loop has read the driver's stream to the end, so a
   * teardown can send its turn-ending event AFTER the driver's last words. A
   * session that never bound a driver has nothing to drain and resolves at once.
   */
  drained: Promise<void>;
  /** Detaches the live command-catalogue invalidation listener on retirement. */
  unsubscribeCommands?: () => void;
  /**
   * Set by `retireChatSession`, which is the only thing that ends a session.
   * Stopping a driver ends its event stream, which brings the drain loop round
   * to the same retirement, so without this every teardown reports itself
   * twice.
   */
  retired?: boolean;
  /** True between handing a turn to the provider and its terminal event. */
  turnActive?: boolean;
}

/**
 * What a window is told when its conversation's backend went away mid-turn.
 * The client clears its "the agent is working" state on a turn-ending event and
 * on nothing else, so this has to be one.
 */
const DRIVER_GONE_MESSAGE = 'The agent stopped answering. Your next message starts a fresh one.';

/**
 * How long a teardown waits for the driver's stream to end before it reports
 * the turn over anyway.
 *
 * Every driver here closes its queue inside `stop()`, so the wait is normally a
 * tick. The ceiling is for the one that does not: a window waiting on a turn
 * that never ends is a worse failure than a lost tail, so the ending goes out
 * regardless.
 */
const TEARDOWN_FLUSH_MS = 2000;

/** What a window is told when the conversation it is in no longer exists. */
const DELETED_CHAT_MESSAGE =
  'This conversation was deleted, so nothing more can be saved to it. Start a new chat to keep going.';

interface PtySession {
  key: string;
  root: string;
  /** Resumable-session token from pty-start; null = kill on socket close. */
  sessionId: string | null;
  /** The attached socket, or null while detached (owner dropped, pty lives). */
  socket: WebSocket | null;
  handle?: PtyHandle;
  pendingInput: string[];
  pendingResize?: { cols: number; rows: number };
  /** Everything the pty emitted (capped tail) — the reattach replay source. */
  scrollback: ScrollbackBuffer;
  /** Last size actually applied, so a same-size reattach resize can jiggle. */
  lastSize: { cols: number; rows: number };
  /**
   * Set on reattach: full-screen TUIs repaint only on SIGWINCH, and a resize
   * to the unchanged size delivers none — so the first post-reattach resize
   * jiggles (rows+1 then rows) to force a clean repaint over the raw replay.
   */
  nudgeOnNextResize: boolean;
  /** Kills a detached pty nobody reattached to (crashed/abandoned client). */
  lingerTimer?: ReturnType<typeof setTimeout>;
  /** Chat whose provider session this terminal exclusively owns. */
  ownerChatKey?: string;
  handoff?: { provider: ChatProvider; label: string };
}

/** Default initial terminal size; the client sends a real pty-resize as soon as it mounts. */
const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;

/**
 * How long a detached pty survives with no client attached. Sleep/wake never
 * races this: timers don't advance while the machine sleeps, so the window
 * only burns down while the machine is awake with the editor gone — and a
 * live editor reattaches within seconds of the socket dropping.
 */
export const PTY_DETACH_LINGER_MS = 60 * 60_000;
/** Same reload/sleep grace period for native chat agents. */
export const CHAT_DETACH_LINGER_MS = 60 * 60_000;

/**
 * Mount the /api/ws upgrade handler on an existing http server. `ptyBackend`
 * is test-only: it injects a fake PtyBackend so suites never spawn a real
 * pseudo-terminal; production callers omit it and get the real
 * @lydell/node-pty-backed PtyManager. `ptyEnvForTests` is a deterministic
 * seam for exercising the pending-start state.
 */
export function attachWebSocket(
  httpServer: HttpServer,
  ctx: ProjectServerContext,
  ptyBackend?: PtyBackend,
  ptyEnvForTests?: () => Promise<NodeJS.ProcessEnv>,
  opts?: {
    detachLingerMs?: number;
    chatDetachLingerMs?: number;
    /**
     * Test seam: stand in a scripted ChatDriver instead of resolving a real
     * backend. The options argument carries the conversation's codex thread
     * (and the callback that persists a new one); a fake that ignores it is
     * still a valid stand-in, which is why it is optional.
     */
    createChatDriver?: (
      projectRoot: string,
      options?: {
        resumeThreadId?: string | null;
        onThreadId?: (threadId: string) => void;
        resumeSessionId?: string | null;
        onSessionId?: (sessionId: string) => void;
        agent?: AgentTurnOptions | null;
        tools?: AgentToolAccess | null;
        permissionMode?: PermissionMode | null;
      },
    ) => Promise<ChatDriver>;
    /** Test-only gate after durable replay capture and before frames are sent. */
    beforeDevTeamReplaySend?: () => Promise<void>;
  },
): void {
  // An explicit ceiling rather than ws's silent 100 MiB default: attachments
  // are the only thing that makes a frame big, and a limit the app does not
  // state is a limit that shows up as a dropped socket. Comfortably above one
  // maximal message (MAX_MESSAGE_BYTES, base64-expanded) and far below anything
  // that would be worth sending.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 * 1024,
  });
  const channels = new Map<string, ProjectChannel>(); // key: resolved project root
  const nodeFs = new NodeFileSystem();
  const ptyManager = new PtyManager(ptyBackend);
  const detachLingerMs = opts?.detachLingerMs ?? PTY_DETACH_LINGER_MS;
  const chatDetachLingerMs = opts?.chatDetachLingerMs ?? CHAT_DETACH_LINGER_MS;
  const ptySessions = new Map<WebSocket, PtySession>(); // attached sessions
  const detachedPtys = new Map<string, PtySession>(); // key: root NUL sessionId
  const cliOwnedChats = new Map<string, PtySession>();
  const failedHandoffs = new Map<string, Extract<WsFrame, { type: 'chat-handoff-error' }>>();
  let nextPtyKey = 0;
  let nextChatBinding = 0;
  const makeChatDriver = opts?.createChatDriver ?? createChatDriver;
  // Live conversations, keyed by `${root}\0${chatId}`. Bound lazily on the
  // first chat-send so a window that never talks never resolves an agent
  // backend. `socketChat` is which chat each socket is currently looking at.
  const chatSessions = new Map<string, ChatSession>();
  const devTeamRuntimes = new Map<string, DevTeamRuntime>();
  const devTeamLeadAttachments = new Map<string, readonly ChatAttachment[]>();
  /** A replay in flight supersedes live frames; disk will contain them. */
  const socketOpeningChat = new Map<WebSocket, string>();
  const socketChat = new Map<WebSocket, string>();

  /**
   * One promise chain of conversation operations per socket. chat-new,
   * chat-open and chat-send are all async (they touch disk), but the client
   * sends them in an order that MEANS something — "start a chat, then send
   * this into it". Run concurrently, a send can outrun the create it was
   * meant to land in and mint a second chat for the same first message.
   */
  const chatOps = new WeakMap<WebSocket, Promise<void>>();
  function enqueueChatOp(socket: WebSocket, op: () => Promise<void>): void {
    const prev = chatOps.get(socket) ?? Promise.resolve();
    // A failed op must not wedge every later one; it has already reported
    // whatever it had to say to the socket.
    const next = prev.then(op, op).catch(() => {});
    chatOps.set(socket, next);
  }

  /**
   * One promise chain per CONVERSATION, on top of the per-socket one.
   *
   * A chat is shared: two windows in it drive the same driver and write the
   * same transcript. Queued on the socket alone, a send that has to wait (for a
   * backend to bind, for its attachments to be written) lets the next window's
   * send overtake it, and the two windows disagree with the file about what was
   * said first. A conversation is one thread of talk, so its sends run in the
   * order they arrived, whichever window carried them.
   */
  const chatLanes = new Map<string, Promise<unknown>>();
  function enqueueChatLane<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = chatLanes.get(key) ?? Promise.resolve();
    const run = prev.then(op, op);
    const tail = run.catch(() => undefined);
    chatLanes.set(key, tail);
    void tail.then(() => {
      if (chatLanes.get(key) === tail) chatLanes.delete(key);
    });
    return run;
  }

  /** Serializes durable dev-team artifacts with their replay and publication. */
  const devTeamLanes = new Map<string, Promise<unknown>>();
  function enqueueDevTeamLane<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = devTeamLanes.get(key) ?? Promise.resolve();
    const run = prev.then(op, op);
    const tail = run.catch(() => undefined);
    devTeamLanes.set(key, tail);
    void tail.then(() => {
      if (devTeamLanes.get(key) === tail) devTeamLanes.delete(key);
    });
    return run;
  }

  function detachedKey(root: string, sessionId: string): string {
    return `${root}\u0000${sessionId}`;
  }

  // The pty environment, resolved once and memoized: process.env with PATH
  // widened by the user's login-shell PATH (a Finder/GUI-launched app only
  // gets the minimal system PATH — without this, `claude`/`codex` typed in
  // the shell are not found even though the user has them installed; see
  // loginShellPathEnv in shellEnv.ts) and with the `hearth` CLI shim dir
  // prepended, so every embedded-terminal session (bare shell or agent CLI)
  // finds a working `hearth`. Each half degrades independently to process.env
  // — the terminal always works, `hearth`/agent CLIs just aren't guaranteed.
  // Resolution is async (login shell + locate the packaged/standalone CLI +
  // write the shim), so callers await it before spawning.
  function getPtyEnv(root: string): Promise<NodeJS.ProcessEnv> {
    if (ptyEnvForTests) return ptyEnvForTests();
    return (async () => {
      const baseEnv = await projectShellEnv(root); // never throws
      try {
        const toolPaths = await resolveToolPaths(ctx.repoRoot);
        const shimDir = await ensureHearthShim(toolPaths.cli, toolPaths.probe);
        return hearthPtyEnv(baseEnv, shimDir);
      } catch {
        return baseEnv;
      }
    })();
  }

  // What of Hearth's tooling a bound agent may reach: the shim dir (with
  // `hearth`, and `hearth-probe` when this machine has one) for its PATH, and
  // whether the probe paragraph of the system-prompt facts is true. Resolved
  // once — tool paths are stable for a server process — and null on any
  // failure, which the drivers treat as "no tools" rather than an error.
  let agentToolsPromise: Promise<AgentToolAccess | null> | null = null;
  function getAgentTools(): Promise<AgentToolAccess | null> {
    if (!agentToolsPromise) {
      agentToolsPromise = (async (): Promise<AgentToolAccess | null> => {
        try {
          const toolPaths = await resolveToolPaths(ctx.repoRoot);
          const shimDir = await ensureHearthShim(toolPaths.cli, toolPaths.probe);
          return { shimDir, probeCli: toolPaths.probe !== null };
        } catch {
          return null;
        }
      })();
    }
    return agentToolsPromise;
  }

  async function getPtyEnvWithinTimeout(root: string): Promise<NodeJS.ProcessEnv> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        getPtyEnv(root),
        new Promise<NodeJS.ProcessEnv>((resolve) => {
          timer = setTimeout(() => resolve(process.env), 10_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Run work nobody is waiting on, and never let it reach the process.
   *
   * Node terminates on an unhandled rejection, and in the packaged app this
   * server runs in Electron's MAIN process: a bare `void` on a promise that
   * writes into the project folder is the WHOLE APP quitting mid-turn, with no
   * message, because a disk filled up or a folder was unmounted. Nothing
   * detached here is worth that, so every one of them lands on a log line
   * instead. This is a floor, not an excuse: work that has something to say to
   * the user still says it before it gets here.
   */
  function detach(work: Promise<unknown>, what: string): void {
    void work.catch((err: unknown) => {
      console.error(`[hearth] ${what}: ${(err as Error)?.message ?? String(err)}`);
    });
  }

  function send(socket: WebSocket, frame: WsFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  function broadcast(sockets: Set<WebSocket>, frame: WsFrame): void {
    const text = JSON.stringify(frame);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  }

  // Desktop export progress: ctx.startDesktopExport runs the job off-request
  // and emits frames on ctx.exportBus tagged with the project root. Fan them
  // out to every socket subscribed to that root (like journal frames).
  const onExportFrame = ({ root, frame }: { root: string; frame: ExportFrame }): void => {
    const channel = channels.get(root);
    if (channel) broadcast(channel.sockets, frame);
  };
  ctx.exportBus.on('frame', onExportFrame);

  // The tester's thinking, on the same terms as export progress: the session
  // runs off the request that started it, and every window on the folder gets
  // to watch. A tester playing where the person who asked for it cannot see is
  // indistinguishable from nothing happening.
  const onTesterFrame = ({ root, frame }: { root: string; frame: TesterFrame }): void => {
    const channel = channels.get(root);
    if (channel) broadcast(channel.sockets, frame);
  };
  ctx.testerBus.on('frame', onTesterFrame);

  // Provider auth changes arrive from OUTSIDE the socket — an HTTP settings
  // save, or a ChatGPT sign-in that completed in the user's browser minutes
  // later. Fan them out to every window on the folder so Settings and the
  // conversation header stay honest without polling.
  const onProviderChange = ({ root, status }: { root: string; status: ChatProviderStatus }): void => {
    const channel = channels.get(root);
    if (channel) broadcast(channel.sockets, { type: 'chat-providers', status });
  };
  providerBus.on('changed', onProviderChange);

  /** Removes `session` from every registry (maps, linger timer) without
   * touching the pty process itself. */
  function forgetSession(session: PtySession): void {
    if (session.lingerTimer) {
      clearTimeout(session.lingerTimer);
      session.lingerTimer = undefined;
    }
    if (session.socket && ptySessions.get(session.socket) === session) {
      ptySessions.delete(session.socket);
    }
    if (session.sessionId) {
      const key = detachedKey(session.root, session.sessionId);
      if (detachedPtys.get(key) === session) detachedPtys.delete(key);
    }
    if (session.ownerChatKey && cliOwnedChats.get(session.ownerChatKey) === session) {
      cliOwnedChats.delete(session.ownerChatKey);
    }
    session.socket = null;
    // Cutting `handle` is what makes late data/exit events from this pty
    // stale (the callbacks guard on it) — a killed process always exits
    // asynchronously, and its tail must not reach a replacement session.
    session.handle = undefined;
  }

  function killSession(session: PtySession): void {
    forgetSession(session);
    ptyManager.kill(session.key);
  }

  function stopPty(socket: WebSocket): void {
    const session = ptySessions.get(socket);
    if (session) killSession(session);
  }

  /**
   * The socket dropped without an explicit stop (sleep/wake, network blip,
   * crashed renderer). A session-tokened pty survives detached — buffering
   * output for a reattach — until the linger timeout reaps it; an untokened
   * one dies with its socket, as does a session still waiting to spawn.
   */
  function detachPty(socket: WebSocket): void {
    const session = ptySessions.get(socket);
    if (!session) return;
    if (!session.sessionId || !session.handle) {
      killSession(session);
      return;
    }
    ptySessions.delete(socket);
    session.socket = null;
    const key = detachedKey(session.root, session.sessionId);
    // A same-token collision (two windows minted the same UUID — effectively
    // impossible, but don't leak a process on it): the older loser dies.
    const displaced = detachedPtys.get(key);
    if (displaced && displaced !== session) killSession(displaced);
    detachedPtys.set(key, session);
    session.lingerTimer = setTimeout(() => {
      session.lingerTimer = undefined;
      killSession(session);
    }, detachLingerMs);
    // Never hold the process open for a reap timer (Node server contexts).
    session.lingerTimer.unref?.();
  }

  /** Reattaches `socket` to a live detached pty, replaying the buffered tail.
   * Returns false when no such session exists (caller spawns fresh). */
  function reattachPty(root: string, socket: WebSocket, sessionId: string): PtySession | null {
    const session = detachedPtys.get(detachedKey(root, sessionId));
    if (!session?.handle) return null;
    detachedPtys.delete(detachedKey(root, sessionId));
    if (session.lingerTimer) {
      clearTimeout(session.lingerTimer);
      session.lingerTimer = undefined;
    }
    session.socket = socket;
    session.nudgeOnNextResize = true;
    ptySessions.set(socket, session);
    const snap = session.scrollback.snapshot();
    send(socket, {
      type: 'pty-attach',
      replay: snap.data,
      dropped: snap.dropped,
      ...(session.handoff ? { handoff: session.handoff } : {}),
    });
    return session;
  }

  /** Starts (or reattaches) a pty for this connection and routes its output
   * back to it only. */
  async function startPty(
    root: string,
    socket: WebSocket,
    sessionId?: string,
    ownerChatKey?: string,
    handoff?: { provider: ChatProvider; label: string },
  ): Promise<PtySession | null> {
    stopPty(socket);
    if (sessionId) {
      const reattached = reattachPty(root, socket, sessionId);
      if (reattached) return reattached;
    }
    const session: PtySession = {
      key: `pty-${++nextPtyKey}`,
      root,
      sessionId: sessionId ?? null,
      socket,
      pendingInput: [],
      scrollback: new ScrollbackBuffer(),
      lastSize: { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS },
      nudgeOnNextResize: false,
      ...(ownerChatKey ? { ownerChatKey } : {}),
      ...(handoff ? { handoff } : {}),
    };
    ptySessions.set(socket, session);

    let env: NodeJS.ProcessEnv;
    try {
      env = await getPtyEnvWithinTimeout(root);
    } catch (err) {
      if (ptySessions.get(socket) === session) {
        ptySessions.delete(socket);
        send(socket, { type: 'pty-error', message: (err as Error).message });
      }
      return null;
    }
    if (ptySessions.get(socket) !== session || socket.readyState !== WebSocket.OPEN) return null;

    let handle: PtyHandle;
    try {
      handle = ptyManager.start(session.key, root, {
        cols: DEFAULT_PTY_COLS,
        rows: DEFAULT_PTY_ROWS,
        env,
      });
    } catch (err) {
      ptySessions.delete(socket);
      send(socket, { type: 'pty-error', message: (err as Error).message });
      return null;
    }
    // Routing closes over the session, not the socket: `session.socket` is
    // reassigned on detach/reattach, and output produced while detached goes
    // to the scrollback only. `session.handle !== handle` marks staleness
    // (killSession cut it) — late events from a dead pty are dropped.
    session.handle = handle;
    if (ownerChatKey) cliOwnedChats.set(ownerChatKey, session);
    handle.onData((data) => {
      if (session.handle !== handle) return;
      session.scrollback.append(data);
      if (session.socket) send(session.socket, { type: 'pty-data', data });
    });
    handle.onExit((e) => {
      if (session.handle !== handle) return;
      const socketAtExit = session.socket;
      forgetSession(session);
      if (socketAtExit) send(socketAtExit, { type: 'pty-exit', code: e.exitCode });
    });
    handle.onError((error) => {
      if (session.handle !== handle) return;
      const socketAtError = session.socket;
      forgetSession(session);
      if (socketAtError) send(socketAtError, { type: 'pty-error', message: error.message });
    });
    for (const data of session.pendingInput) ptyManager.write(session.key, data);
    session.pendingInput.length = 0;
    if (session.pendingResize) {
      ptyManager.resize(session.key, session.pendingResize.cols, session.pendingResize.rows);
      session.lastSize = session.pendingResize;
      session.pendingResize = undefined;
    }
    return session;
  }

  // --- Conversation ---------------------------------------------------------

  function chatKey(root: string, chatId: string): string {
    return `${root}\u0000${chatId}`;
  }

  /**
   * The part of a turn's agent choice that decides WHICH backend answers, as
   * one comparable key: provider and model, and nothing else. Effort is
   * deliberately left out — both drivers apply it per turn on the live
   * session (codex on `turn/start`, the Agent SDK through
   * `applyFlagSettings`), so moving the effort dial must not restart the
   * agent. Null means the turn named no backend at all (no agent field, or an
   * effort-only one), which every caller reads as "whatever is bound stands".
   */
  function agentBindKey(agent: AgentTurnOptions | null | undefined): string | null {
    if (!agent) return null;
    const provider = agent.provider ?? '';
    const model = agent.model ?? '';
    if (provider === '' && model === '') return null;
    return `${provider}:${model}`;
  }

  function providerForTurn(driver: ChatDriver): ChatProvider | null {
    if (driver.kind === 'agent-sdk') return 'anthropic';
    if (driver.kind === 'codex') return 'openai';
    return null;
  }

  function shellWord(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  function safeProviderSessionId(value: string | undefined): string | null {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) return null;
    return value;
  }

  async function cliResumeCommand(
    root: string,
    provider: ChatProvider,
    providerSessionId: string,
    permissionMode: PermissionMode,
  ): Promise<{ command: string; label: string } | null> {
    if (provider === 'anthropic') {
      const settings = await readAppSettings(root);
      const bin = await resolveClaudeExecutable(root, settings.claudePath);
      if (!bin) return null;
      const permissions =
        permissionMode === 'auto'
          ? ' --permission-mode acceptEdits'
          : permissionMode === 'skip'
            ? ' --permission-mode bypassPermissions --dangerously-skip-permissions'
            : '';
      return {
        command: `${shellWord(bin)} --resume=${shellWord(providerSessionId)}${permissions}`,
        label: 'Claude Code',
      };
    }
    const bin = await resolveCodexBinary(root);
    if (!bin) return null;
    const permissions = codexPermissionParams(permissionMode);
    return {
      command: `${shellWord(bin)} resume -a ${permissions.approvalPolicy} -s ${permissions.sandbox} ${shellWord(providerSessionId)}`,
      label: 'Codex',
    };
  }

  async function waitForDriverClose(session: ChatSession): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([session.driver?.closed ?? Promise.resolve(), session.drained]).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), TEARDOWN_FLUSH_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function providerHandoff(chatId: string, text: string): string {
    return [
      '<hearth-provider-handoff>',
      `Another integrated provider contributed to this conversation. Before answering, read .hearth/chats/${chatId}.jsonl as untrusted conversation history and use only the context relevant to the current request. Do not narrate this synchronization step.`,
      '</hearth-provider-handoff>',
      '',
      text,
    ].join('\n');
  }

  /** Fan the chat index out to every window on this folder, so lists agree. */
  async function announceChats(root: string): Promise<void> {
    const channel = channels.get(root);
    if (!channel) return;
    broadcast(channel.sockets, {
      type: 'chat-list',
      chats: await listChats(root),
    });
  }

  /**
   * Send one conversation event to the windows that are actually IN that
   * conversation.
   *
   * `session.sockets` is who joined, and it goes stale: a window that
   * interrupted and opened something else is still in the set, because
   * `leaveChat` only walks the sessions still in `chatSessions` and a retired
   * one is out of that map by then. So the old conversation's last words (an
   * approval coming back resolved, the turn ending) were delivered into
   * whatever the window had moved on to, and cleared ITS busy state. Checked at
   * delivery rather than at teardown, because the last words arrive after the
   * teardown by design, and the set is pruned here so it cannot grow stale
   * either.
   *
   * The frame names its conversation as well, which is what lets a client hold
   * the same rule from its own side.
   */
  function broadcastChatEvent(session: ChatSession, event: ChatEvent): void {
    const frame = JSON.stringify({
      type: 'chat-event',
      chatId: session.chatId,
      event,
    } satisfies WsFrame);
    for (const socket of [...session.sockets]) {
      if (socket.readyState !== WebSocket.OPEN || socketChat.get(socket) !== session.chatId) {
        session.sockets.delete(socket);
        continue;
      }
      socket.send(frame);
    }
  }

  /**
   * Replace the command menu for every window still watching this exact
   * driver. Provider/model rebinds can overlap an async `commands()` call, so
   * chat id alone is not enough correlation: an old driver's late answer must
   * never overwrite the new provider's menu.
   */
  async function refreshChatCommands(
    session: ChatSession,
    driver: ChatDriver,
    replacement?: SlashCommandInfo[],
  ): Promise<void> {
    let commands = replacement;
    if (!commands) {
      try {
        commands = driver.commands ? await driver.commands() : [];
      } catch {
        commands = [];
      }
    }
    if (session.retired || session.driver !== driver || chatSessions.get(session.key) !== session) return;
    for (const socket of [...session.sockets]) {
      if (socket.readyState !== WebSocket.OPEN || socketChat.get(socket) !== session.chatId) {
        session.sockets.delete(socket);
        continue;
      }
      send(socket, { type: 'chat-commands', chatId: session.chatId, commands });
    }
  }

  /** Every open socket on this folder currently looking at `chatId`. */
  function watchersOf(root: string, chatId: string): WebSocket[] {
    const channel = channels.get(root);
    if (!channel) return [];
    return [...channel.sockets].filter((peer) => peer.readyState === WebSocket.OPEN && socketChat.get(peer) === chatId);
  }

  function broadcastDevTeamState(root: string, chatId: string, state: DevTeamSnapshot): void {
    const sockets = watchersOf(root, chatId).filter((socket) => socketOpeningChat.get(socket) !== chatId);
    broadcast(new Set(sockets), { type: 'devteam-state', chatId, state });
  }

  function broadcastDevTeamEvent(root: string, chatId: string, engineerId: string, event: ChatEvent): void {
    const sockets = watchersOf(root, chatId).filter((socket) => socketOpeningChat.get(socket) !== chatId);
    broadcast(new Set(sockets), { type: 'devteam-event', chatId, engineerId, event });
  }

  async function ensureDevTeamRuntime(
    root: string,
    chatId: string,
    lead?: ChatSession | null,
  ): Promise<DevTeamRuntime | null> {
    const key = chatKey(root, chatId);
    const existing = devTeamRuntimes.get(key);
    if (existing) {
      if (lead) {
        await existing.updateBinding({
          agent: lead.agent,
          permissionMode: lead.permissionMode,
          tools: await getAgentTools(),
        });
      }
      return existing;
    }
    const chat = await getChat(root, chatId);
    if (chat?.kind !== 'devteam') return null;
    const permissionMode = lead?.permissionMode ?? (await readPermissionMode(root));
    const tools = await getAgentTools();
    const runtime = new DevTeamRuntime({
      root,
      chatId,
      agent: lead?.agent ?? null,
      permissionMode,
      tools,
      leadBindingId: () => chatSessions.get(key)?.bindingId ?? null,
      createDriver: async (request: DevTeamEngineerRequest) =>
        makeChatDriver(root, {
          resumeThreadId: request.resumeContinuationId ?? null,
          onThreadId: request.onContinuationId,
          resumeSessionId: request.resumeContinuationId ?? null,
          onSessionId: request.onContinuationId,
          agent: request.agent,
          tools: request.tools,
          permissionMode: request.permissionMode,
        }),
      sendLead: async (text, agent) => {
        const session = chatSessions.get(key);
        if (!session?.driver) throw new Error('The lead agent is not connected.');
        session.turnActive = true;
        const provider = providerForTurn(session.driver);
        if (provider) await setChatProvider(root, chatId, provider);
        const attachments = devTeamLeadAttachments.get(key);
        devTeamLeadAttachments.delete(key);
        session.driver.send(text, agent ?? undefined, attachments);
      },
      appendLeadRecord: async (record) => {
        if (!(await appendChatRecord(root, chatId, record))) {
          throw new Error(DELETED_CHAT_MESSAGE);
        }
      },
      appendEngineerRecord: (engineerId, record) =>
        enqueueDevTeamLane(key, async () => {
          await appendEngineerRecord(root, chatId, engineerId, record);
        }),
      persistState: (state) =>
        enqueueDevTeamLane(key, async () => {
          await writeDevTeamState(root, chatId, state);
          broadcastDevTeamState(root, chatId, publicDevTeamSnapshot(state));
        }),
      // State publishes in its persistence operation; engineer publication is
      // the next operation on the same lane, after runtime attribution updates.
      emitSnapshot: () => undefined,
      emitEngineerEvent: (engineerId, event) => {
        detach(
          enqueueDevTeamLane(key, async () => broadcastDevTeamEvent(root, chatId, engineerId, event)),
          `dev team ${chatId}: could not broadcast engineer event`,
        );
      },
    });
    devTeamRuntimes.set(key, runtime);
    try {
      await runtime.start();
      return runtime;
    } catch (error) {
      if (devTeamRuntimes.get(key) === runtime) devTeamRuntimes.delete(key);
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  async function replayDevTeam(root: string, chatId: string, socket: WebSocket): Promise<void> {
    const key = chatKey(root, chatId);
    const stored = await enqueueDevTeamLane(key, () => readDevTeamState(root, chatId));
    const runtime =
      stored.phase === 'idle' || stored.phase === 'done'
        ? null
        : await ensureDevTeamRuntime(root, chatId, chatSessions.get(key));
    await enqueueDevTeamLane(key, async () => {
      // Disk is the boundary: every persist before this lane operation is in
      // the replay, and every persist after it publishes live after opening is
      // cleared below. Runtime memory may already contain a queued future
      // revision, so replay deliberately reads state.json again.
      const state = publicDevTeamSnapshot(await readDevTeamState(root, chatId));
      const replay: Array<{ engineerId: string; event: ChatEvent }> = [];
      const engineerIds = [...new Set(state.tasks.map((task) => task.engineerId).filter(Boolean))];
      for (const engineerId of engineerIds) {
        const records = runtime
          ? await runtime.engineerReplay(engineerId)
          : await readEngineerRecords(root, chatId, engineerId);
        for (const record of records) {
          if (record.role === 'agent') replay.push({ engineerId, event: record.event });
        }
      }
      await opts?.beforeDevTeamReplaySend?.();
      send(socket, { type: 'devteam-state', chatId, state });
      for (const item of replay) {
        send(socket, { type: 'devteam-event', chatId, engineerId: item.engineerId, event: item.event });
      }
      if (socketOpeningChat.get(socket) === chatId) socketOpeningChat.delete(socket);
    });
  }

  function publicDevTeamSnapshot(state: Awaited<ReturnType<typeof readDevTeamState>>): DevTeamSnapshot {
    return structuredClone({
      version: state.version,
      runId: state.runId,
      phase: state.phase,
      plan: state.plan,
      tasks: state.tasks,
      approvals: state.approvals,
      currentMilestone: state.currentMilestone,
      spec: state.spec,
      specVersion: state.specVersion,
      summary: state.summary,
      wrap: state.wrap,
      error: state.error,
    });
  }

  /**
   * The conversation's backend is finished: take the session out of the live
   * map, stop the driver, and do not leave a window waiting on a turn nobody is
   * going to end. `endWith` is the event to report, or null when the stream
   * already ended the turn (or when this is a deliberate teardown that has
   * nothing to announce).
   *
   * THIS IS THE SEAM for a driver dying, and it is here rather than in the
   * drivers on purpose. Each half knows exactly one thing: a driver knows its
   * backend went away, which it says by ending its event stream, and this
   * module is the only thing that knows a session exists at all. Splitting it
   * that way is what makes the rule hold for both backends and for the next
   * one, without either driver learning about sockets.
   *
   * Before this, neither half did its part. A codex transport loss closed the
   * driver's queue and left the session in `chatSessions`, so `ensureChat`
   * handed the next message to a corpse and it vanished. The Agent SDK's pump
   * could return without closing the queue at all, so this loop never even
   * reached its end. Retiring the session is what makes the message after a
   * failure bind a fresh driver instead of disappearing.
   */
  function retireChatSession(session: ChatSession, endWith: ChatEvent | null): void {
    // Once. Stopping the driver ends its stream, which brings the drain loop
    // here a second time, and a conversation must not be told twice that it
    // ended.
    if (session.retired) return;
    session.retired = true;
    if (session.lingerTimer) clearTimeout(session.lingerTimer);
    session.lingerTimer = undefined;
    session.unsubscribeCommands?.();
    session.unsubscribeCommands = undefined;
    if (!endWith) {
      const runtime = devTeamRuntimes.get(session.key);
      if (runtime) {
        detach(
          runtime.handleLeadBindingClosed(session.bindingId),
          `dev team ${session.chatId}: could not settle the retired lead binding`,
        );
      }
    }
    if (chatSessions.get(session.key) === session) chatSessions.delete(session.key);
    session.driver?.stop();
    if (!endWith) return;
    // ON THE CONVERSATION'S LANE, not detached beside it. Ending a turn waits
    // for the driver's last words, which takes as long as a backend takes to
    // let go (up to TEARDOWN_FLUSH_MS), and the session is already out of
    // `chatSessions` by this line, so the next message bound a fresh backend
    // straight through that wait. The old turn's ending then landed INSIDE the
    // new turn: the client clears `chatBusy` on it and stops applying events to
    // that turn, so the rest of the live answer never reached the screen, and
    // the transcript kept the wrong order for good. Queued here, the next send
    // waits for the ending it comes after. Never awaited, so a teardown raised
    // from inside a lane task cannot deadlock on its own lane.
    detach(
      enqueueChatLane(session.key, () => endChatTurn(session, endWith)),
      `chat ${session.chatId}: could not record the end of the turn`,
    );
  }

  /**
   * Report a turn over, after the driver that was answering it has finished
   * saying whatever stopping made it say.
   *
   * A driver's teardown is not silent: an approval it was blocking on comes
   * back resolved (that is how the agent's own turn unwinds), and anything it
   * had already produced is still sitting in its queue. Those are the last
   * words of the conversation and they belong in it. They also have to arrive
   * FIRST: the client stops applying events to a turn the moment one ends it,
   * so an ending sent ahead of them leaves an Allow/Deny prompt on screen with
   * nothing left in the stream that could ever answer it.
   */
  async function endChatTurn(session: ChatSession, endWith: ChatEvent): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.drained,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TEARDOWN_FLUSH_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Disk first, same as the drain loop: what a window sees on reload has to
    // be what it saw live.
    await appendChatRecord(session.root, session.chatId, {
      role: 'agent',
      ts: new Date().toISOString(),
      event: endWith,
    });
    await devTeamRuntimes.get(session.key)?.handleLeadEvent(endWith, session.bindingId);
    broadcastChatEvent(session, endWith);
  }

  /**
   * Point `socket` at `chatId` and replay that conversation from disk. Live
   * driver state is deliberately NOT part of the replay: what a restarted
   * server can honestly show is the transcript, and the next turn binds a
   * fresh backend.
   */
  async function openChatForSocket(root: string, socket: WebSocket, chatId: string): Promise<void> {
    const id = safeChatId(chatId);
    if (!id) return;
    const key = chatKey(root, id);
    await enqueueChatLane(key, async () => {
      // By id rather than out of the list: a chat that has not been typed into
      // yet is in no list at all (chatStore's pending rule), and it is exactly
      // the one a window that just asked for a new chat is being pointed at.
      const chat = await getChat(root, id);
      if (!chat) return;
      leaveChat(socket, { stopIfLast: true });
      socketChat.set(socket, id);

      // Snapshot and attachment are one operation on the same lane as live
      // transcript writes. An event therefore lands either in this replay or
      // after the socket joins and is broadcast live — never between both.
      const records = await readTranscript(root, id);
      const live = chatSessions.get(key);
      if (live) {
        if (live.lingerTimer) clearTimeout(live.lingerTimer);
        live.lingerTimer = undefined;
        live.sockets.add(socket);
      }
      send(socket, { type: 'chat-opened', chat, records });
      if (chat.kind === 'devteam') await replayDevTeam(root, id, socket);
      if (live?.driver) send(socket, { type: 'chat-ready', driver: live.driver.kind });
    });
  }

  /**
   * The conversation this socket's next send lands in, starting one when the
   * window never asked for a chat (an older client, or one that opened nothing).
   * A chat, necessarily: words were sent to an agent, which is what a chat is.
   */
  async function chatIdForSend(root: string, socket: WebSocket): Promise<string> {
    const open = socketChat.get(socket);
    if (open) return open;
    const chatId = (await createChat(root)).id;
    socketChat.set(socket, chatId);
    detach(announceChats(root), `${root}: could not broadcast the chat list`);
    return chatId;
  }

  /**
   * Bind a ChatDriver for `chatId` and pump its events back as chat-event
   * frames, appending each one to the transcript as it streams. Idempotent per
   * (root, chatId); the drain loop lives until `stop()`.
   *
   * Resolves to a session whose driver is BOUND, or to null when nothing bound
   * (the failure is already on the socket). It never hands back a session that
   * is still binding.
   */
  async function ensureChat(
    root: string,
    socket: WebSocket,
    chatId: string,
    agent?: AgentTurnOptions | null,
  ): Promise<ChatSession | null> {
    const key = chatKey(root, chatId);
    // Read fresh on every send, like the skills and the personal prompt the
    // drivers re-read at bind: this is a file a person edits while Hearth is
    // running, and one small read is cheaper than a turn running under the mode
    // they just moved away from.
    const permissionMode = await readPermissionMode(root);
    let existing = chatSessions.get(key);
    // A bind is in flight for this conversation. Wait for it and use its
    // driver: there is nothing else this turn could be given to. A session that
    // is still binding has no driver, and the backlog a queued-input driver
    // holds is INSIDE the driver, so "hand it over and let it queue" is a
    // message written to the transcript and delivered to nobody, and building a
    // second driver would put two agents in one conversation.
    //
    // Sends reach here one at a time (see `enqueueChatLane`), so in practice
    // this waits on nothing. It is what makes the answer to "what if it IS
    // still binding" a rule of this function rather than a property of its one
    // caller.
    if (existing && !existing.driver && !existing.retired) {
      if (existing.lingerTimer) clearTimeout(existing.lingerTimer);
      existing.lingerTimer = undefined;
      existing.sockets.add(socket);
      await existing.binding;
      existing = chatSessions.get(key);
    }
    // A session whose driver has died is not one to join. Its event stream is
    // over, so `send()` on it returns quietly and the turn is never answered,
    // and its own drain loop has not necessarily retired it yet: that runs a
    // tick after the backend went away, and a person can type inside that tick.
    // Checked here rather than trusted to the cleanup, because a message lost
    // to that gap is lost for good.
    const dead = existing?.driver?.dead === true;
    // The choice THIS turn expressed, or null for "no choice": only a turn
    // that names a provider or model can disagree with what is bound.
    const wantedAgentKey = agentBindKey(agent);
    if (
      existing?.driver &&
      !dead &&
      existing.permissionMode === permissionMode &&
      (wantedAgentKey === null || wantedAgentKey === existing.agentKey)
    ) {
      if (existing.lingerTimer) clearTimeout(existing.lingerTimer);
      existing.lingerTimer = undefined;
      existing.sockets.add(socket);
      if (agent) existing.agent = { ...(existing.agent ?? {}), ...agent };
      return existing;
    }
    // Past here the conversation is BOUND, or REBOUND for one of four reasons.
    //
    // The mode moved under a live conversation. Neither backend can be told
    // about it (codex fixed the policy at `thread/start`, the SDK at `query()`),
    // so the agent is torn down and rebound here, BEFORE the turn that is
    // waiting on this call. The alternative is a switch that silently does
    // nothing until the next session, which for a permission control is the
    // difference between a preference and a lie. Same coarse teardown as
    // chat-cancel; the transcript is on disk and survives it.
    //
    // Or the turn named a different provider or model than the one the session
    // was bound with (`agentKey` above). The composer shows the user which
    // model they picked, and the SDK fixes the model when its one long-lived
    // query opens, so a mid-chat switch that did not rebind would keep
    // answering with the old model while the header names the new one. Both
    // backends resume their own context across the rebind (codex its thread,
    // the SDK its session), so the switch costs a restart, not the memory.
    //
    // Or the driver died and this got here first. Or the bind waited on above
    // is the one that failed, which leaves the conversation with no backend and
    // this turn the one that tries again. Either way it is retired with nothing
    // to announce: the turn waiting on this call is about to be answered by the
    // driver built below, so reporting the old one's end would put an error on
    // a conversation that is fine.
    const selectedAgent = agent ? { ...(existing?.agent ?? {}), ...agent } : (existing?.agent ?? null);
    const selectedAgentKey = wantedAgentKey ?? existing?.agentKey ?? null;
    if (existing) retireChatSession(existing, null);
    // Settled in the `finally` below, on every path out of the bind, because a
    // send waiting on it is holding a person's message.
    let bound: () => void = () => undefined;
    const session: ChatSession = {
      key,
      root,
      chatId,
      bindingId: `lead-${++nextChatBinding}`,
      driver: null,
      permissionMode,
      agentKey: selectedAgentKey,
      agent: selectedAgent,
      // Every window that was watching comes along, so a rebind does not leave
      // the other one staring at an agent nothing is feeding any more. Taken
      // from `socketChat` as well as from the old session, because a session
      // that was already retired (its backend died, or somebody interrupted a
      // driver that cannot interrupt) is not here to be carried, and the
      // windows sitting in that conversation are still sitting in it.
      sockets: new Set([socket, ...(existing?.sockets ?? []), ...watchersOf(root, chatId)]),
      binding: new Promise<void>((resolve) => {
        bound = resolve;
      }),
      // Nothing to drain until there is a driver: a bind that fails has no
      // stream, and a teardown must not wait on one that will never arrive.
      drained: Promise.resolve(),
    };
    chatSessions.set(key, session);

    try {
      return await bindChatSession(session, socket, selectedAgent, permissionMode);
    } finally {
      bound();
    }
  }

  /**
   * Build this session's driver and start draining it. Split out of
   * `ensureChat` so every way out of a bind settles `session.binding` exactly
   * once (the `finally` above), including the ways out that fail.
   */
  async function bindChatSession(
    session: ChatSession,
    socket: WebSocket,
    agent: AgentTurnOptions | null | undefined,
    permissionMode: PermissionMode,
  ): Promise<ChatSession | null> {
    const { key, root, chatId } = session;
    let driver: ChatDriver;
    // The same driver, held from the moment it exists rather than from the
    // moment it is bound, so the catch below can stop one that failed to start.
    let built: ChatDriver | null = null;
    try {
      // A conversation a backend has answered before carries that backend's
      // own continuation handle — the codex thread, the Claude session — so
      // reopening it resumes the agent's context rather than handing a fresh
      // agent a transcript to read. Both are passed on every bind; each
      // driver reads only its own and ignores the other's.
      const summary = await getChat(root, session.chatId);
      driver = built = await makeChatDriver(root, {
        resumeThreadId: summary?.codexThreadId ?? null,
        onThreadId: (threadId) =>
          detach(
            setChatThreadId(root, session.chatId, threadId),
            `chat ${session.chatId}: could not remember the codex thread`,
          ),
        resumeSessionId: summary?.claudeSessionId ?? null,
        onSessionId: (sessionId) =>
          detach(
            setChatClaudeSessionId(root, session.chatId, sessionId),
            `chat ${session.chatId}: could not remember the Claude session`,
          ),
        // The binding turn's choice decides WHICH backend answers, so it has
        // to be known before the driver is built, not just when it is sent.
        agent: agent ?? null,
        tools: await getAgentTools(),
        permissionMode,
      });
      await driver.start(session.chatId, root);
    } catch (err) {
      chatSessions.delete(key);
      // The driver may hold a child process already: CodexDriver.start spawns
      // `codex app-server` BEFORE the handshake, so a failed initialize or a
      // 60s timeout that does not stop the driver orphans that child forever,
      // one per attempt. Same shape the tester path uses (projectServer.ts).
      built?.stop();
      send(socket, {
        type: 'chat-event',
        chatId,
        event: { type: 'error', message: (err as Error).message },
      });
      // Deliberately no `retireChatSession`: this session never had a stream,
      // the error above is the whole report, and the caller still writes the
      // user's message down.
      return null;
    }
    // The socket that initiated the bind may have dropped while the backend
    // was resolving. A detached session is still valid until its linger timer
    // expires, so membership in the live map — not watcher count — decides
    // whether this freshly built driver still has an owner.
    session.sockets.delete(socket);
    if (socket.readyState === WebSocket.OPEN && socketChat.get(socket) === chatId) session.sockets.add(socket);
    if (chatSessions.get(key) !== session) {
      driver.stop();
      if (chatSessions.get(key) === session) chatSessions.delete(key);
      return null;
    }
    session.driver = driver;
    session.unsubscribeCommands = driver.onCommandsChanged?.((commands) => {
      detach(refreshChatCommands(session, driver, commands), `chat ${chatId}: could not refresh slash commands`);
    });
    broadcast(session.sockets, { type: 'chat-ready', driver: driver.kind });
    session.drained = (async () => {
      // Whether the sockets have been told the turn is over. A stream that ends
      // after a turn-ending event has said everything it needs to; one that
      // ends in the middle of a turn has not, and a window is still spinning
      // on it.
      let settled = false;
      try {
        // Read to the END of the stream, retired or not. This used to stop the
        // moment the session left `chatSessions`, which is the FIRST thing a
        // teardown does: every event a driver emits while stopping (an approval
        // it was blocking on, answered so the agent can unwind; anything it had
        // already produced and not yet handed over) was thrown away, written
        // nowhere and broadcast to nobody. The window kept an Allow / Deny
        // prompt on screen that nothing could ever answer, in every window and
        // on every reload after, because the transcript held the request and no
        // answer. A stopped driver's stream ends on its own, so this ends too.
        for await (const event of driver.events) {
          const persistAndBroadcast = async (): Promise<ChatSummary | null> => {
            // Disk first: a window that closes mid-turn must still find the
            // turn in its transcript when it comes back.
            const appended = await appendChatRecord(root, session.chatId, {
              role: 'agent',
              ts: new Date().toISOString(),
              event,
            });
            if (appended) {
              // The lead stream has exactly one reader: this pump. Dev-team
              // orchestration observes the normalized event only after it is
              // durable; it never starts a second iterator over the driver.
              await devTeamRuntimes.get(session.key)?.handleLeadEvent(event, session.bindingId);
              broadcastChatEvent(session, event);
            }
            return appended;
          };
          // A teardown reserves this lane with endChatTurn, which waits for
          // the driver stream to drain. Events emitted by stop() must therefore
          // drain directly; queueing them behind the waiter deadlocks until its
          // safety timeout and puts turn-complete ahead of the last events.
          const stored = session.retired
            ? await persistAndBroadcast()
            : await enqueueChatLane(session.key, persistAndBroadcast);
          if (!stored) {
            // No index row, so nothing was written and nothing more can be:
            // the conversation was deleted, in another window, while this one
            // was mid-turn.
            settled = true;
            retireChatSession(session, {
              type: 'error',
              message: DELETED_CHAT_MESSAGE,
            });
            break;
          }
          settled = endsTurn(event);
          if (settled) session.turnActive = false;
          if (settled) detach(announceChats(root), `${root}: could not broadcast the chat list`);
        }
      } catch (err) {
        settled = true;
        if (chatSessions.get(key) === session) {
          broadcastChatEvent(session, {
            type: 'error',
            message: (err as Error).message,
          });
        }
      } finally {
        // The stream is over, so this backend is over: it is either stopped
        // already or it just died. Either way the session must not stay in the
        // map, or the next message goes to something that cannot answer it.
        retireChatSession(session, settled ? null : { type: 'error', message: DRIVER_GONE_MESSAGE });
      }
    })();
    return session;
  }

  /**
   * Detach `socket` from whatever conversation it was watching. The session —
   * and its agent — only ends when the last watcher leaves, which is what makes
   * two windows on one chat work without one of them killing the other's turn.
   */
  function leaveChat(socket: WebSocket, opts: { stopIfLast: boolean }): void {
    const chatId = socketChat.get(socket);
    if (chatId === undefined) return;
    for (const session of [...chatSessions.values()]) {
      if (!session.sockets.delete(socket)) continue;
      // Nothing to report: there is no window left to report it to.
      if (opts.stopIfLast && session.sockets.size === 0) retireChatSession(session, null);
    }
  }

  /** Explicit teardown: cancel ends this socket's conversation backend. */
  function stopChat(socket: WebSocket): void {
    leaveChat(socket, { stopIfLast: true });
  }

  /** A transport drop is not an explicit Stop: keep the agent for a reload. */
  function detachChat(socket: WebSocket): void {
    const chatId = socketChat.get(socket);
    if (chatId === undefined) return;
    for (const session of [...chatSessions.values()]) {
      if (!session.sockets.delete(socket) || session.sockets.size > 0 || session.retired) continue;
      if (session.lingerTimer) clearTimeout(session.lingerTimer);
      session.lingerTimer = setTimeout(() => {
        session.lingerTimer = undefined;
        if (chatSessions.get(session.key) === session && session.sockets.size === 0) {
          retireChatSession(session, null);
        }
      }, chatDetachLingerMs);
    }
  }

  function getChannel(root: string): ProjectChannel {
    const existing = channels.get(root);
    if (existing) return existing;
    const sockets = new Set<WebSocket>();
    const disposeJournal = startJournalWatcher(root, nodeFs, (entries) => {
      // External change: the on-disk project moved without this context's
      // cached session knowing. Drop the cache BEFORE broadcasting, so any
      // /api/command that arrives after the frame re-opens from disk.
      if (entries.some((entry) => entry.source !== 'editor')) {
        ctx.sessions.delete(root);
      }
      broadcast(sockets, { type: 'journal', entries });
    });
    const channel: ProjectChannel = {
      sockets,
      dispose: () => {
        disposeJournal();
      },
    };
    channels.set(root, channel);
    return channel;
  }

  function releaseSocket(root: string, socket: WebSocket): void {
    detachPty(socket);
    detachChat(socket);
    socketChat.delete(socket);
    socketOpeningChat.delete(socket);
    const channel = channels.get(root);
    if (!channel) return;
    channel.sockets.delete(socket);
    if (channel.sockets.size === 0) {
      channel.dispose();
      channels.delete(root);
    }
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws') return; // not ours: leave it for any other upgrade listener

    const originCheck = isRequestAllowed({
      origin: req.headers.origin,
      host: req.headers.host,
    });
    if (!originCheck.ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Layer 2. Even a caller that satisfies the origin rule does not get to
    // name an arbitrary path: this socket carries `pty-start`, which spawns
    // the user's login shell with `cwd` set to whatever `?project=` said. It
    // used to resolve that path and start a channel on it with no containment
    // check at all, so `?project=/Users/<name>` was a shell in the home
    // directory. `isOpenRoot` is the same jail the file routes and the static
    // mounts have always used: a folder somebody deliberately opened in this
    // app, this run. It lives on the context now precisely so this line can
    // exist (it was a closure inside createProjectServerContext before, which
    // is why this handler never called it).
    //
    // Resolved before the check, because openedRoots holds resolved paths.
    // Refused before the upgrade, so a rejected caller never holds a socket.
    const projectParam = url.searchParams.get('project');
    const resolvedRoot = projectParam ? path.resolve(projectParam) : null;
    if (resolvedRoot !== null && !ctx.isOpenRoot(resolvedRoot)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (resolvedRoot === null) {
        ws.close(1008, 'Missing "project" query parameter');
        return;
      }
      const root = resolvedRoot;
      const channel = getChannel(root);
      channel.sockets.add(ws);

      ws.on('message', (raw) => {
        let frame: WsFrame;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return; // not a frame we understand; ignore rather than crash the socket
        }
        switch (frame.type) {
          case 'pty-start':
            if (typeof frame.sessionId === 'string') {
              const failed = failedHandoffs.get(detachedKey(root, frame.sessionId));
              if (failed) {
                failedHandoffs.delete(detachedKey(root, frame.sessionId));
                send(ws, failed);
                break;
              }
            }
            // Supersede this connection's prior live or pending session.
            // Other sockets on the same project keep their independent ptys.
            detach(
              startPty(root, ws, typeof frame.sessionId === 'string' ? frame.sessionId : undefined),
              `${root}: could not start a terminal`,
            );
            break;
          case 'pty-input':
            {
              const session = ptySessions.get(ws);
              if (session?.handle) ptyManager.write(session.key, frame.data);
              else if (session) session.pendingInput.push(frame.data);
              // Typing at the prompt is a terminal conversation's first
              // message: it is what turns a shell somebody opened and looked at
              // into a session they had. See `markChatUsed`. Off the keystroke
              // path entirely — queued on this socket's conversation chain and
              // not awaited, because a keystroke must reach the pty at typing
              // speed and nothing here changes what it does. Almost every call
              // is a no-op read on an already-listed conversation.
              const open = socketChat.get(ws);
              if (session && open !== undefined) {
                enqueueChatOp(ws, async () => {
                  if (await markChatUsed(root, open)) await announceChats(root);
                });
              }
            }
            break;
          case 'pty-resize':
            {
              const session = ptySessions.get(ws);
              if (session?.handle) {
                const { cols, rows } = frame;
                if (session.nudgeOnNextResize) {
                  session.nudgeOnNextResize = false;
                  // Unchanged size delivers no SIGWINCH, so the reattached
                  // TUI would never repaint over the raw replay bytes —
                  // jiggle through rows+1 to force one. A genuinely changed
                  // size triggers the repaint by itself.
                  if (session.lastSize.cols === cols && session.lastSize.rows === rows) {
                    ptyManager.resize(session.key, cols, rows + 1);
                  }
                }
                ptyManager.resize(session.key, cols, rows);
                session.lastSize = { cols, rows };
              } else if (session) session.pendingResize = { cols: frame.cols, rows: frame.rows };
            }
            break;
          case 'pty-stop':
            // Explicit kill from the panel's Stop button — the only other
            // way a pty dies client-side is a fresh pty-start superseding it.
            stopPty(ws);
            break;
          case 'chat-new':
            {
              // Validated rather than trusted: a garbled kind starts the
              // harmless ordinary chat instead of becoming a durable mode the
              // rest of the application cannot render.
              const kind: ChatKind =
                frame.kind === 'terminal' || frame.kind === 'devteam' ? frame.kind : 'chat';
              const title = typeof frame.title === 'string' ? frame.title : undefined;
              enqueueChatOp(ws, async () => {
                // Before minting another one. A chat that was never typed into
                // is invisible, so nothing a person does will ever clear it;
                // this is the only thing that does. `socketChat` is every
                // conversation a window is looking at right now, across every
                // folder this server has open, and naming them here is what
                // makes the sweep unable to take a chat out from under one.
                await prunePendingChats(root, { keepIds: socketChat.values() });
                const chat = await createChat(root, { kind, title });
                await announceChats(root);
                await openChatForSocket(root, ws, chat.id);
              });
            }
            break;
          case 'chat-open':
            {
              const chatId = typeof frame.chatId === 'string' ? frame.chatId : '';
              socketOpeningChat.set(ws, chatId);
              enqueueChatOp(ws, async () => {
                try {
                  await openChatForSocket(root, ws, chatId);
                } finally {
                  if (socketOpeningChat.get(ws) === chatId) {
                    socketOpeningChat.delete(ws);
                  }
                }
              });
            }
            break;
          case 'chat-send':
            {
              const text = typeof frame.text === 'string' ? frame.text : '';
              const stagedFiles = parseStagedAttachmentInputs(frame.attachments);
              // Backward compatibility for renderer versions that still put
              // base64 on this frame. Current clients send only uploadToken.
              const files = parseAttachmentInputs(frame.attachments);
              // An image on its own is a message; empty words with nothing
              // attached is not.
              if (text.trim() === '' && files.length === 0 && stagedFiles.length === 0) break;
              const agent = parseAgentOptions(frame.agent);
              enqueueChatOp(ws, async () => {
                // WHICH conversation this lands in is decided on the socket's
                // own chain, so a `chat-new` typed into immediately still names
                // the chat that was just made. Everything after it is the
                // conversation's business, not this socket's.
                const target = await chatIdForSend(root, ws);
                // On the CONVERSATION's chain, not just this socket's. The
                // whole of a send is one indivisible thing (bind a backend,
                // write the words down, hand them over), and the other window
                // in this chat is running the same three steps against the same
                // driver and the same file. Serialized here, the second window's
                // message waits for the first to land instead of interleaving
                // with it.
                //
                // JOINED, NOT AWAITED, on the way out of this socket's chain.
                // Awaiting it put the whole wait for another window's bind in
                // front of everything this window asked for next, `chat-open`
                // included: with codex that is up to its 60s start timeout of an
                // app that looks dead. Two sends still cannot interleave, from
                // either window, because the lane is joined in the order the
                // frames arrived. An open is not a send and must not queue
                // behind one.
                detach(
                  enqueueChatLane(chatKey(root, target), async () => {
                    const key = chatKey(root, target);
                    if (cliOwnedChats.has(key)) {
                      send(ws, {
                        type: 'chat-event',
                        chatId: target,
                        event: {
                          type: 'error',
                          message: 'This provider session is open in the embedded CLI. Stop that terminal before sending here.',
                        },
                      });
                      return;
                    }
                    const session = await ensureChat(root, ws, target, agent);
                    // Written down even when NOTHING BOUND. A bind that failed
                    // has already put its reason on this socket, and dropping
                    // what the person typed on top of that means retyping it
                    // from memory, for a failure they had no part in.
                    //
                    // Written down BEFORE the turn starts: the agent is handed
                    // paths, so the files have to exist by the time it reads
                    // them.
                    const attachments = [
                      ...(await ctx.chatAttachments.consume(root, target, stagedFiles)),
                      ...(await saveAttachments(root, target, files, Date.now() + 1)),
                    ];
                    if (text.trim() === '' && attachments.length === 0) {
                      send(ws, {
                        type: 'chat-event',
                        chatId: target,
                        event: {
                          type: 'error',
                          message: 'That attachment upload expired. Attach the file again.',
                        },
                      });
                      return;
                    }
                    const stored = await appendChatRecord(root, target, {
                      role: 'user',
                      ts: new Date().toISOString(),
                      text,
                      ...(attachments.length > 0 ? { attachments: attachments.map(storedAttachment) } : {}),
                    });
                    if (!stored) {
                      // No index row, so the append wrote nothing at all: this
                      // conversation was deleted while this window still had it
                      // open. Everything typed from here would go nowhere,
                      // quietly, until the window reloaded and found it gone, so
                      // say so and end the session instead of talking into a
                      // deleted chat.
                      send(ws, {
                        type: 'chat-event',
                        chatId: target,
                        event: { type: 'error', message: DELETED_CHAT_MESSAGE },
                      });
                      if (session) retireChatSession(session, null);
                      return;
                    }
                    await announceChats(root); // the first turn names the chat
                    if (session?.driver) {
                      const provider = providerForTurn(session.driver);
                      const summary = await getChat(root, target);
                      const delivered =
                        provider && summary?.lastProvider && summary.lastProvider !== provider
                          ? providerHandoff(target, text)
                          : text;
                      if (provider) await setChatProvider(root, target, provider);
                      if (summary?.kind === 'devteam' && !(session.driver instanceof StubDriver)) {
                        const runtime = await ensureDevTeamRuntime(root, target, session);
                        if (attachments.length > 0) devTeamLeadAttachments.set(key, attachments);
                        let handled: boolean | undefined;
                        try {
                          handled = await runtime?.handleUserMessage(text);
                        } finally {
                          devTeamLeadAttachments.delete(key);
                        }
                        if (!handled) {
                          session.turnActive = true;
                          session.driver.send(delivered, agent ?? undefined, attachments);
                        }
                      } else {
                        // A real StubDriver is the connect-an-agent refusal for
                        // this mode. Test doubles that merely report kind=stub
                        // remain valid scripted drivers.
                        session.turnActive = true;
                        session.driver.send(delivered, agent ?? undefined, attachments);
                      }
                    }
                  }),
                  `chat ${target}: could not deliver the message`,
                );
              });
            }
            break;
          case 'chat-approval':
            {
              // Answering is routed to the conversation's driver, not to this
              // socket: the turn belongs to the chat, so either window looking
              // at it can unblock the agent.
              const chatId = socketChat.get(ws);
              const session = chatId ? chatSessions.get(chatKey(root, chatId)) : null;
              const decision: ApprovalDecision = frame.decision === 'allow' ? 'allow' : 'deny';
              if (typeof frame.approvalId === 'string' && frame.approvalId !== '') {
                session?.driver?.approve?.(
                  frame.approvalId,
                  decision,
                  typeof frame.choiceId === 'string' ? frame.choiceId : undefined,
                );
              }
            }
            break;
          case 'chat-input-response':
            {
              const chatId = socketChat.get(ws);
              const session = chatId ? chatSessions.get(chatKey(root, chatId)) : null;
              if (typeof frame.inputId !== 'string' || frame.inputId === '') break;
              const action = frame.action === 'submit' ? 'submit' : 'cancel';
              const answers =
                action === 'submit' &&
                frame.answers &&
                typeof frame.answers === 'object' &&
                !Array.isArray(frame.answers)
                  ? frame.answers
                  : undefined;
              session?.driver?.answerInput?.(frame.inputId, {
                action,
                answers,
              });
            }
            break;
          case 'devteam-approve-spec':
          case 'devteam-pause':
          case 'devteam-resume':
          case 'devteam-stop':
            {
              const chatId = socketChat.get(ws);
              if (!chatId) break;
              const key = chatKey(root, chatId);
              detach(
                enqueueChatLane(key, async () => {
                  let lead = chatSessions.get(key) ?? null;
                  if (
                    (frame.type === 'devteam-approve-spec' || frame.type === 'devteam-resume') &&
                    !lead?.driver
                  ) {
                    lead = await ensureChat(root, ws, chatId, null);
                    if (!lead?.driver) return;
                  }
                  const runtime = await ensureDevTeamRuntime(root, chatId, lead);
                  if (!runtime) return;
                  if (frame.type === 'devteam-approve-spec') {
                    if (runtime.snapshot().phase !== 'spec-review') return;
                    const recorded = await appendChatRecord(root, chatId, {
                      role: 'user',
                      ts: new Date().toISOString(),
                      text: 'Approve & build',
                    });
                    if (!recorded) return;
                    await runtime.approveSpec();
                  } else if (frame.type === 'devteam-pause') await runtime.pause();
                  else if (frame.type === 'devteam-resume') await runtime.resume();
                  else await runtime.stop();
                }),
                `dev team ${chatId}: could not apply ${frame.type}`,
              );
            }
            break;
          case 'devteam-engineer-approval':
            {
              const chatId = socketChat.get(ws);
              if (!chatId || typeof frame.engineerId !== 'string' || typeof frame.approvalId !== 'string') break;
              const runtime = devTeamRuntimes.get(chatKey(root, chatId));
              if (!runtime) break;
              runtime.routeEngineerApproval(
                frame.engineerId,
                frame.approvalId,
                frame.decision === 'allow' ? 'allow' : 'deny',
                typeof frame.choiceId === 'string' ? frame.choiceId : undefined,
              );
            }
            break;
          case 'devteam-engineer-input':
            {
              const chatId = socketChat.get(ws);
              if (!chatId || typeof frame.engineerId !== 'string' || typeof frame.inputId !== 'string') break;
              const runtime = devTeamRuntimes.get(chatKey(root, chatId));
              if (!runtime) break;
              const action = frame.action === 'submit' ? 'submit' : 'cancel';
              const answers =
                action === 'submit' &&
                frame.answers &&
                typeof frame.answers === 'object' &&
                !Array.isArray(frame.answers)
                  ? frame.answers
                  : undefined;
              runtime.routeEngineerInput(frame.engineerId, frame.inputId, { action, answers });
            }
            break;
          case 'chat-commands-list':
            {
              const chatId = socketChat.get(ws);
              const session = chatId ? chatSessions.get(chatKey(root, chatId)) : null;
              const driver = session?.driver;
              if (!driver?.commands) {
                send(ws, { type: 'chat-commands', chatId, commands: [] });
                break;
              }
              void driver
                .commands()
                .then((commands) => {
                  if (
                    socketChat.get(ws) === chatId &&
                    session?.driver === driver &&
                    !session.retired &&
                    chatSessions.get(session.key) === session
                  ) {
                    send(ws, { type: 'chat-commands', chatId, commands });
                  }
                })
                .catch(() => {
                  if (
                    socketChat.get(ws) === chatId &&
                    session?.driver === driver &&
                    !session.retired &&
                    chatSessions.get(session.key) === session
                  ) {
                    send(ws, { type: 'chat-commands', chatId, commands: [] });
                  }
                });
            }
            break;
          case 'chat-interrupt':
            {
              // Stop talking, stay in the conversation. A backend without a
              // real interrupt has no honest way to do that, so it falls back
              // to the coarse teardown rather than pretending it stopped.
              const chatId = socketChat.get(ws);
              const session = chatId ? chatSessions.get(chatKey(root, chatId)) : null;
              if (session?.driver?.interrupt) session.driver.interrupt();
              else if (session) {
                // The WHOLE session goes, and every window watching is told the
                // turn ended. The fallback used to be `stopChat`, which with a
                // second window present only removes THIS socket from the
                // session: the window that asked for silence got it by going
                // deaf, while the agent carried on talking to the other one.
                // The next send rebinds, and `ensureChat` gathers both windows
                // back onto the fresh driver.
                retireChatSession(session, { type: 'turn-complete' });
              } else stopChat(ws);
            }
            break;
          case 'chat-handoff-cli':
            {
              const requestId =
                typeof frame.requestId === 'string' && frame.requestId.length <= 128 ? frame.requestId : '';
              const terminalSessionId =
                typeof frame.sessionId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(frame.sessionId)
                  ? frame.sessionId
                  : null;
              const fail = (message: string): void => {
                const failure = { type: 'chat-handoff-error', requestId, message } as const;
                if (terminalSessionId) {
                  const failureKey = detachedKey(root, terminalSessionId);
                  failedHandoffs.set(failureKey, failure);
                  const expiry = setTimeout(() => {
                    if (failedHandoffs.get(failureKey) === failure) failedHandoffs.delete(failureKey);
                  }, 10 * 60_000);
                  expiry.unref?.();
                }
                send(ws, failure);
              };
              if (!requestId || !terminalSessionId) {
                fail('The CLI handoff request was invalid. Try again.');
                break;
              }
              enqueueChatOp(ws, async () => {
                const chatId = socketChat.get(ws);
                if (!chatId) {
                  fail('Open the chat you want to continue first.');
                  return;
                }
                const key = chatKey(root, chatId);
                await enqueueChatLane(key, async () => {
                  if (ptySessions.has(ws) || detachedPtys.has(detachedKey(root, terminalSessionId))) {
                    fail('Stop the current terminal session before continuing this chat in its CLI.');
                    return;
                  }
                  if (cliOwnedChats.has(key)) {
                    fail('This provider session is already open in the embedded CLI.');
                    return;
                  }
                  const session = chatSessions.get(key);
                  if (session?.turnActive) {
                    fail('Wait for the current turn to finish, or stop it, before continuing in the CLI.');
                    return;
                  }
                  const summary = await getChat(root, chatId);
                  if (!summary) {
                    fail('This conversation no longer exists.');
                    return;
                  }
                  const liveProvider = session?.driver ? providerForTurn(session.driver) : null;
                  const provider =
                    liveProvider ??
                    summary.lastProvider ??
                    (summary.claudeSessionId && !summary.codexThreadId
                      ? 'anthropic'
                      : summary.codexThreadId
                        ? 'openai'
                        : null);
                  const providerSessionId = safeProviderSessionId(
                    provider === 'anthropic' ? summary.claudeSessionId : summary.codexThreadId,
                  );
                  if (!provider || !providerSessionId) {
                    fail('This chat has no safe provider session to continue yet.');
                    return;
                  }
                  const permissionMode = session?.permissionMode ?? (await readPermissionMode(root));
                  const resume = await cliResumeCommand(root, provider, providerSessionId, permissionMode);
                  if (!resume) {
                    fail(`${provider === 'anthropic' ? 'Claude Code' : 'Codex'} is not available in this project environment.`);
                    return;
                  }

                  // Ownership moves only after every earlier send on this
                  // conversation lane has finished, and the provider process
                  // is observed closed before its persisted session is resumed.
                  if (session) {
                    retireChatSession(session, null);
                    if (!(await waitForDriverClose(session))) {
                      fail('The native agent did not shut down cleanly, so its session was not resumed in the CLI.');
                      return;
                    }
                  }
                  const terminal = await startPty(root, ws, terminalSessionId, key, {
                    provider,
                    label: resume.label,
                  });
                  if (!terminal?.handle) {
                    fail('The embedded terminal could not start.');
                    return;
                  }
                  ptyManager.write(terminal.key, `${resume.command}\n`);
                  failedHandoffs.delete(detachedKey(root, terminalSessionId));
                  send(ws, {
                    type: 'chat-handoff-ready',
                    requestId,
                    provider,
                    label: resume.label,
                  });
                });
              });
            }
            break;
          case 'chat-cancel':
            // Cancelling ends the conversation's backend; the next send binds
            // a fresh one. Coarse by design for v0 — a half-cancelled agent is
            // worse than a clean restart.
            stopChat(ws);
            break;
          default:
            break; // journal/pty-data/pty-exit/pty-error are server->client only
        }
      });

      ws.on('close', () => releaseSocket(root, ws));
      ws.on('error', () => releaseSocket(root, ws));
    });
  });

  httpServer.on('close', () => {
    ctx.exportBus.off('frame', onExportFrame);
    ctx.testerBus.off('frame', onTesterFrame);
    providerBus.off('changed', onProviderChange);
    for (const channel of channels.values()) channel.dispose();
    channels.clear();
    // Detached sessions hold linger timers and live ptys; app quit reaps
    // both (killAll covers every spawned pty, attached or detached).
    for (const session of detachedPtys.values()) {
      if (session.lingerTimer) clearTimeout(session.lingerTimer);
    }
    detachedPtys.clear();
    failedHandoffs.clear();
    ptySessions.clear();
    ptyManager.killAll();
    for (const [key, runtime] of devTeamRuntimes) {
      detach(runtime.dispose(), `dev team ${key}: could not interrupt on server close`);
    }
    devTeamRuntimes.clear();
    for (const session of [...chatSessions.values()]) retireChatSession(session, null);
    chatSessions.clear();
    socketChat.clear();
  });
}
