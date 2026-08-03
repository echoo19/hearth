/**
 * App state. One zustand store covering the four things the app is:
 *
 *   1. an open folder (and the socket to its server),
 *   2. a conversation,
 *   3. a game pane,
 *   4. the small amount of pane/drawer state the shell needs.
 *
 * Everything live — conversation events, terminal bytes, external
 * file changes — arrives on ONE WebSocket per folder, multiplexed by frame
 * type (see server/ws.ts). The terminal's own buffer deliberately lives
 * outside this store (components/agent/useAgentSocket.ts) so it survives the
 * conversation column switching away from terminal mode.
 */
import { create } from 'zustand';
import {
  apiAppSettings,
  apiChatProviders,
  apiCloseWorkspace,
  apiCreateWorkspace,
  apiDeleteChat,
  apiGameStatus,
  apiListChats,
  apiMeta,
  apiOpenAiLogin,
  apiOpenWorkspace,
  apiPermissionMode,
  apiPersonalization,
  apiSetPermissionMode,
  apiProbeStatus,
  apiTesterApprove,
  apiTesterHistory,
  apiTesterHistoryAll,
  apiTesterPlay,
  apiTesterStop,
  apiUploadChatAttachment,
  apiRecentChats,
  apiRenameChat,
  apiSavePersonalization,
  apiSaveProviderSettings,
  projectFileUrl,
  type Personalization,
  type PersonalizationInfo,
} from './api';
import { releaseAttachments, type PendingAttachment } from './chat/attachments';
import type {
  AppSettingsInfo,
  ApprovalDecision,
  ChatAttachmentView,
  ChatDriverKind,
  ChatEvent,
  ChatProvider,
  ChatKind,
  ChatMessage,
  ChatPart,
  ChatProviderStatus,
  ChatRecord,
  ChatSummary,
  DevTeamSnapshot,
  ConsoleEntry,
  ConsoleLevel,
  ConsoleSource,
  FileChangeEntry,
  GameStatus,
  JournalEntry,
  InputAction,
  InputAnswer,
  PermissionMode,
  RecentChatEntry,
  Sense,
  ServerMeta,
  SlashCommandInfo,
  StoredAttachment,
  TesterRunHistory,
  UpdateReadyInfo,
  WorkspaceInfo,
} from './types';
import type { WsFrame } from '../server/ws';
import type { TesterPhase } from '../server/tester/session';
import type { TesterNote } from '../server/tester/types';
import { agentForTurn, getModelChoice, rememberedChoiceFor, setModelChoice } from './chat/modelChoice';
import { hearthNative } from './native';
import { suggestProjectName } from './projects/suggestName';
import { showToast } from './toast';
import {
  ensureAgentPtySessionId,
  getAgentSessionSummary,
  ingestPtyAttach,
  ingestPtyFrame,
  markAgentDisconnected,
  markAgentCli,
  markAgentStarted,
  resetAgentSocket,
  type AgentStatus,
} from './components/agent/useAgentSocket';

/** Which surface the right-hand stack is showing. */
export type PaneTab = 'game' | 'console' | 'tester';

/**
 * One answer from the tester, assembled from the fragments it arrives in.
 * `turn` is which question it was answering: the text streams in pieces and
 * nothing else in the frame says where one thought ends and the next begins.
 */
export interface TesterThought {
  turn: number;
  text: string;
}

/**
 * A message that has been typed and not sent: the words, and the files waiting
 * with them.
 *
 * The attachments carry live object URLs for their thumbnails, so a draft is
 * something that has to be RELEASED rather than merely dropped — see
 * `clearDrafts`.
 */
export interface ComposerDraft {
  text: string;
  attachments: readonly PendingAttachment[];
}

/** Nothing typed. Shared, so an empty draft is one object and not a thousand. */
export const EMPTY_DRAFT: ComposerDraft = { text: '', attachments: [] };

/**
 * The drafts that belong to the open folder, by the key their composer uses.
 *
 * A message in a conversation, or on a project's own screen, is about that
 * project and goes when it does. Home's is not: it is aimed at whichever
 * project the person picked and it is the composer that OPENS a folder, so
 * clearing it on an open would empty the box mid-send and revoke the pictures
 * still on screen in it. Kept as a list rather than as "everything except
 * home" so the exception is named where it is made.
 */
export const FOLDER_DRAFT_KEYS: readonly string[] = ['chat', 'project'];

/** The tester, as this window currently understands it. */
export interface TesterState {
  /** A session is playing right now. */
  running: boolean;
  /** A play request is in flight, before the server has said yes. */
  starting: boolean;
  /** Which session number is playing, or the last one that did. */
  session: number | null;
  phase: TesterPhase | null;
  /** Turns this session may spend. Shown before it is spent, not after. */
  maxSteps: number;
  thoughts: TesterThought[];
  /** The note the last session wrote, so the pane can end on a result. */
  lastNote: TesterNote | null;
  error: string | null;
  /** Every session in the folder, oldest first. Filled by the history screen. */
  sessions: TesterNote[];
  /** What the tester says it knows about this game, as markdown. */
  memory: string;
  /** True once the history has been read at least once for this folder. */
  historyLoaded: boolean;
}

const EMPTY_TESTER: TesterState = {
  running: false,
  starting: false,
  session: null,
  phase: null,
  maxSteps: 0,
  thoughts: [],
  lastNote: null,
  error: null,
  sessions: [],
  memory: '',
  historyLoaded: false,
};

/**
 * What a folder is on before its own answer arrives, and what a failed read
 * leaves standing: today's behaviour, which asks before anything outside the
 * project folder. Deliberately not `skip`. A mode nobody chose must never be
 * the one that stops asking, so every fallback in this file lands here.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

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
  /** The latest authoritative runtime snapshot for the open dev-team chat. */
  devTeam: DevTeamSnapshot | null;
  /** Existing chat folds, one per Hearth-run engineer. */
  devTeamLanes: Record<string, ChatMessage[]>;
  /** Latest team snapshot per conversation, for live status outside the open pane. */
  devTeamByChat: Record<string, DevTeamSnapshot>;
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
  /** Commands reported by that live backend, refreshed whenever the composer focuses. */
  slashCommands: SlashCommandInfo[];
  chatError: string | null;
  settings: AppSettingsInfo | null;
  /**
   * What could answer a turn in this folder — a key, a signed-in Codex, or
   * nothing. Null until the first read; refreshed whenever the server says it
   * changed (a login completing, a key being saved).
   */
  providers: ChatProviderStatus | null;
  /**
   * When the agent stops to ask before it runs a command or writes a file, in
   * THIS folder. Not null while it is being read: a control over what the
   * agent is allowed to do has to name a real behaviour at every moment, so it
   * starts on the default and is corrected by the read a beat later. The
   * correction can only ever loosen it towards what the project actually
   * stored, never towards something the user never chose.
   */
  permissionMode: PermissionMode;
  /**
   * This folder has already been told what `skip` means, so choosing it again
   * does not ask again. Stored per project by the server; false until the read
   * lands, which is the safe way round (it costs one extra confirm, where the
   * other way round costs the confirm entirely).
   */
  permissionSkipAcknowledged: boolean;
  /** Every conversation this folder holds, newest activity first. */
  chats: ChatSummary[];
  /**
   * Whether that list has been read for the open folder yet.
   *
   * An empty array is both "this project has no conversations" and "nobody has
   * asked yet", and the project screen was drawing the first over the second:
   * clicking a project put "No conversations yet. Say what you want to make
   * and the first one starts here." on screen for the length of the round
   * trip, in front of a project with twelve of them. Same rule the tester
   * history holds itself to.
   */
  chatsLoaded: boolean;
  /** Which one the window is looking at. */
  activeChatId: string | null;
  /**
   * Every conversation on this machine, across folders — what the rail's
   * Recents list shows. Global on purpose: a chat is the unit of work, and
   * which folder it happens to live in is a detail the user shouldn't have to
   * reopen a project to remember.
   */
  recentChats: RecentChatEntry[];
  /**
   * The global list has been read at least once.
   *
   * `recentChats: []` is two different facts, and the rail was telling them
   * apart by guessing: it said "Nothing yet. Say something and it lands here."
   * for the length of the round trip, in front of a machine with a hundred
   * conversations on it. Never say there is nothing when the truth is that
   * nobody has looked. Never cleared: the list belongs to the person, not to
   * any folder, so a project switch does not un-read it.
   */
  recentChatsLoaded: boolean;

  // --- Game pane ------------------------------------------------------------
  game: GameStatus;
  /**
   * Whether anybody has actually managed to look. `game.present` is false
   * before the first status read lands and false again when one fails, and
   * `refreshGame` leaves the empty default standing on a null answer, so the
   * field alone cannot tell "this folder has no game" from "nobody could
   * look". Surfaces that speak about the folder read this first: never say
   * there is nothing when the truth is that nobody has looked.
   */
  gameKnown: boolean;
  senses: Sense[];
  /** The last probe read found a shim, so the deeper senses are real. */
  shimDetected: boolean;
  /** Bumped whenever the game's files change, so the iframe reloads. */
  gameNonce: number;

  // --- The private tester ---------------------------------------------------
  tester: TesterState;

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
  /** The game is silenced. See GAME_MUTED_KEY for why this is not per folder. */
  gameMuted: boolean;
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
   * the only one so far: it is a library you browse and edit, which is a
   * place, not a question to answer and dismiss. A dialog would put a
   * page-sized surface behind a scrim and take the window's own back button
   * away from it.
   *
   * `null` means the work itself — whatever `composing` / `projectView` and
   * the open project already decide between them. Leaving a screen restores
   * that arrangement untouched, which is why nothing else is stored here.
   */
  screen: 'skills' | 'tester' | null;
  /**
   * Which project the tester screen is aimed at. Null means "whatever the
   * picker resolves to", which is the most recent project.
   *
   * The tester screen is global — a history of every run across every game —
   * but a run has to start somewhere, so the screen carries an aim the way the
   * blank composer carries `composeTarget`. Separate from `projectPath` on
   * purpose: standing on a global screen must not mean standing in a project,
   * and reading the open folder to decide what to show is exactly the coupling
   * that made Tester silently inherit whichever project was last clicked.
   */
  testerTarget: string | null;
  /**
   * A project is being named, with the first draft of the answer.
   *
   * Naming lives here rather than inside the dialog because two places ask for
   * it — the rail's New project, and a first message with nowhere to land —
   * and they have to be the SAME question. It used to be two: the rail asked,
   * and the first message did not, so typing "a game where a raccoon steals
   * bins" silently produced a folder the server had named for you, off a
   * stopword list, with no chance to say otherwise. The name is the one thing
   * about a project that is hard to change later, so it is asked for.
   *
   * Null means nothing is being named. The dialog is mounted once at the shell
   * so that neither asker owns it.
   */
  naming: { suggestion: string } | null;
  /**
   * Every recent playtest across every game, newest first, as the Tester
   * screen shows it. Null until it has been read once, which is how the screen
   * tells "no runs yet" from "not asked yet" without inventing a flag.
   */
  testerRuns: TesterRunHistory | null;
  /** Prompt carried across a folder open, consumed by the composer on mount. */
  pendingPrompt: string | null;
  /**
   * What has been typed and not sent yet, per composer.
   *
   * It lives here rather than inside the composer because the composer does
   * not outlive the surface it sits on: opening Skills or the Tester screen
   * takes the whole working area, which unmounts the conversation column, and
   * the words went with it along with the tray's object URLs. Losing what
   * somebody typed is the worst thing this app can do, and the composer's own
   * home path already refuses to do it on a failed send.
   *
   * Keyed by which composer, because they are different acts: Home's first
   * message makes a project, a conversation's continues one, and one must
   * never turn up in the other's box.
   *
   * The tray's object URLs live exactly as long as the draft holding them, so
   * every path that drops a draft releases them: see `clearDrafts`.
   */
  composerDrafts: Record<string, ComposerDraft>;
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
  openWorkspace(
    path: string,
    prompt?: string,
    conversation?: 'latest' | 'new',
    newKind?: 'chat' | 'devteam',
  ): Promise<{ ok: boolean; error?: string }>;
  closeWorkspace(): void;
  /** Send a turn. `attachments` are files the composer's tray was holding. */
  /**
   * Send a message, or queue it behind the turn already running.
   *
   * False means it went nowhere: nothing to send, or the socket was not there
   * to take it. Queued counts as taken, because a queued message is still
   * going to be sent. Callers typing into the composer can ignore the answer —
   * the box still holds what they wrote — but anything sending on someone's
   * behalf has to know, or it reports work as started that never left.
   */
  sendChat(text: string, attachments?: readonly PendingAttachment[]): boolean;
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
  approveChat(approvalId: string, decision: ApprovalDecision, choiceId?: string): void;
  /**
   * Answer a provider question. Values cross the socket once and are never
   * copied into transcript state; false leaves the live form untouched.
   */
  answerChatInput(inputId: string, action: InputAction, answers?: Record<string, InputAnswer>): boolean;
  refreshChatCommands(): void;
  refreshProviders(): Promise<void>;
  /**
   * Choose which agent answers, from the composer.
   *
   * Writes BOTH halves: the standing choice this window sends on every turn,
   * and `provider` in the folder's own settings. They were allowed to disagree
   * before, and the server resolved the disagreement by quietly preferring
   * whatever the turn carried (`agent?.provider ?? settings.provider` in
   * server/chat.ts). So Settings could say Claude, the composer could send
   * ChatGPT, and both screens were honestly reporting a different fact. One
   * act, both writes, no resolution rule to remember.
   *
   * The local write lands FIRST and is not rolled back if the save fails. The
   * choice is this window's to make and it is what the next turn will carry;
   * the settings write is how the rest of the app finds out. A failed save is
   * logged and leaves the two out of step until the next one, which is the
   * lesser of the two wrongs: refusing the switch because a file could not be
   * written would leave the person unable to change agent at all.
   */
  setChatProvider(provider: ChatProvider): Promise<void>;
  /** Re-read the open folder's permission mode. Safe to over-call. */
  refreshPermissionMode(): Promise<void>;
  /**
   * Choose a mode for the open folder, and remember it there.
   *
   * `acknowledgeSkip` records that this project has been shown what `skip`
   * does. It travels WITH the mode rather than in a call of its own, so a
   * project can never end up on skip having never been told what that is.
   */
  setPermissionMode(mode: PermissionMode, acknowledgeSkip?: boolean): Promise<void>;
  /** Begin the ChatGPT device flow and open the page it hands back. */
  startOpenAiLogin(): Promise<void>;
  /**
   * Start a fresh conversation in the open folder and switch to it. A folder
   * is required — see `newProject` for the other half of that rule.
   */
  newChat(): void;
  /** Start a new Hearth-orchestrated team conversation in the open project. */
  newDevTeam(): void;
  /**
   * Begin a new game. There is no name field: Hearth's projects are made by
   * describing one, so this returns to the surface where the first message
   * creates the folder (see `startFromHome`). Leaving the current folder IS
   * the act — a new project is a different folder by definition.
   */
  newProject(): void;
  /** Switch to an existing conversation, replaying it from disk. */
  openChat(chatId: string): void;
  /**
   * Rename or delete a conversation in `from`, defaulting to the open folder.
   *
   * The rail lists every conversation on the machine, so the folder has to be
   * nameable: without it, tidying the list meant opening each folder in turn
   * to be allowed to touch one row of it.
   */
  renameChat(chatId: string, title: string, from?: string): Promise<void>;
  deleteChat(chatId: string, from?: string): Promise<void>;
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
  startFromHome(
    text: string,
    attachments?: readonly PendingAttachment[],
    kind?: 'chat' | 'devteam',
  ): Promise<{ ok: boolean; error?: string }>;
  approveDevTeamSpec(): void;
  pauseDevTeam(): void;
  resumeDevTeam(): void;
  /** Give up on a turn that is not going to finish and go on from whatever the
   *  team left on disk. See DevTeamRuntime.recover. */
  recoverDevTeam(): void;
  stopDevTeam(): void;
  approveEngineer(
    engineerId: string,
    approvalId: string,
    decision: ApprovalDecision,
    choiceId?: string,
  ): void;
  answerEngineerInput(
    engineerId: string,
    inputId: string,
    action: InputAction,
    answers?: Record<string, InputAnswer>,
  ): boolean;
  /** Subscribe to the main process's update-ready signal. Returns unsubscribe. */
  watchUpdates(): () => void;
  /** Quit and install the downloaded update (the rail's banner button). */
  relaunchToUpdate(): Promise<void>;
  consumePendingPrompt(): string | null;
  /**
   * Hold what a composer currently has in it. Called on every keystroke, which
   * is what makes the draft survive its surface being taken away.
   *
   * Takes ownership of the attachments' object URLs: whatever this replaces is
   * NOT released, because the caller is normally handing back the same files it
   * was given. A caller that is really letting go of them releases them itself
   * (the composer does, on send and on remove).
   */
  setDraft(key: string, draft: ComposerDraft): void;
  /**
   * Forget drafts and release the pictures they were holding.
   *
   * Named keys, or all of them when none are given. A project switch and a
   * close pass `FOLDER_DRAFT_KEYS`, because a message typed into a folder is
   * about that folder. Releasing is explicit rather than left to be collected:
   * an object URL nobody revokes is a picture the page holds for its whole
   * life, and one revoked too early is a broken thumbnail.
   */
  clearDrafts(keys?: readonly string[]): void;
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
   * A shell in the project folder, with nothing typed into it.
   *
   * THE ONLY WAY INTO THE TERMINAL, and it deliberately runs nothing. Hearth
   * used to offer a list of agent CLIs it would type for you, which read as
   * the set of agents that work here. They all work here: it is your shell.
   * So the door is unnamed, it opens empty, and what runs in it is something
   * the person typed.
   *
   * Hearth records nothing about what ends up running here, because it typed
   * nothing and genuinely does not know.
   */
  openTerminal(): void;
  /** Hand the current native provider session to its full CLI inside Hearth. */
  continueChatInCli(): boolean;
  setPaneTab(tab: PaneTab): void;
  /**
   * Ask the tester to play. Never called by anything but a person: the tester
   * has no schedule and does not run on save, because every session spends
   * model calls on the user's own quota.
   */
  playTester(): Promise<void>;
  /** Stop the session that is playing. It still writes down what it saw. */
  stopTester(): Promise<void>;
  /** Re-read the folder's sessions and memory from disk. */
  refreshTesterHistory(): Promise<void>;
  /**
   * Every recent playtest across every game, for the Tester screen. Global, so
   * it takes no project and does not care which folder is open.
   */
  refreshTesterRuns(): Promise<void>;
  /**
   * Play a session in a named project, opening it first if it is not the one
   * already open. What the global Tester screen's Play does.
   */
  playTesterIn(path: string): Promise<void>;
  /**
   * Start work on the proposals someone ticked, in a conversation of their own.
   *
   * A NEW one, always. Approved work appended to whatever was open would land
   * on top of a conversation already in the middle of something else, and the
   * agent would have to guess which of the two it was being asked about.
   */
  approveProposals(
    session: number,
    proposals: readonly string[],
    options?: {
      /**
       * The folder the report belongs to, when that is not the open one. The
       * Tester screen lists every game's sessions, so a report read there is
       * usually about a project this window is not standing in. Left out, the
       * open project is meant.
       */
      project?: string;
      /** How long to wait for the new conversation. Only a test passes this. */
      waitMs?: number;
    },
  ): Promise<{ ok: boolean; error?: string }>;
  /** Show or hide the playtest column. An explicit pick, remembered per folder. */
  setPaneOpen(open: boolean): void;
  setGameMuted(muted: boolean): void;
  /** Aim the new-chat composer at a project, or at one that doesn't exist yet. */
  setComposeTarget(path: string | null): void;
  /** Aim the tester screen's Play at a project. Null means the most recent one. */
  setTesterTarget(path: string | null): void;
  /**
   * Ask for a project name and wait for the answer.
   *
   * Resolves with the new folder's path, or null if the question was dismissed
   * — which is an answer, not a failure, and the caller should quietly stop
   * rather than report anything.
   */
  askProjectName(suggestion: string): Promise<string | null>;
  /** The dialog's reply. A path if a folder was made, null if it was dismissed. */
  answerProjectName(path: string | null): void;
  /** Open a project and land on its own screen rather than in a conversation. */
  openProject(path: string): Promise<void>;
  /** Come back up from a conversation to the project it belongs to. */
  showProject(): void;
  /** Open a full screen over the work. */
  openScreen(screen: 'skills' | 'tester'): void;
  /**
   * Open the Tester screen aimed at one game — what "Every session" means when
   * it is pressed from inside a project.
   *
   * The screen is still global and still lists every game's runs; what this
   * fixes is its Play. The aim defaults to the most recently played game
   * ANYWHERE, so arriving from lighthouse's own screen and pressing Play could
   * close lighthouse and play harbour instead. Arriving from a project is the
   * one case where the app knows which game is meant, so it says so, out loud
   * in the picker, rather than leaving the reader to check.
   */
  openTesterFor(path: string): void;
  /** Leave it. The work underneath is exactly as it was left. */
  closeScreen(): void;
  setNarrowTab(tab: 'chat' | 'pane'): void;
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
/**
 * How many of the tester's answers a window keeps. A session is capped at a few
 * dozen turns, so this is a ceiling on a runaway rather than a trim anyone will
 * see: the whole session is on disk in its transcript either way.
 */
const MAX_TESTER_THOUGHTS = 200;
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

/**
 * Whoever is waiting on the naming dialog. Outside the store because a promise
 * resolver is not state — nothing renders from it, and putting a function in
 * the store would make every subscriber re-run when the dialog opens.
 */
let namingResolve: ((path: string | null) => void) | null = null;

/** Settle the pending ask, at most once. Safe to call when nobody is waiting. */
function answerNaming(path: string | null): void {
  const resolve = namingResolve;
  namingResolve = null;
  resolve?.(path);
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function makeEntry(
  level: ConsoleLevel,
  source: ConsoleSource,
  message: string,
  link?: ConsoleEntry['link'],
): ConsoleEntry {
  return { id: ++entryId, time: timestamp(), level, source, message, link };
}

let queuedId = 0;

const EMPTY_GAME: GameStatus = { present: false, entry: null, mtime: 0 };

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

/** A place that belongs to the person rather than to any one game. */
export type GlobalPlace = 'new-chat' | 'skills' | 'tester';

/**
 * Which global screen you are standing on, or null for "inside a project".
 *
 * This is the app's one answer to "where am I", and the rail, the top bar and
 * the screens themselves all have to give the same one. New chat, Skills and
 * Tester belong to the person: a project may still be OPEN underneath (the
 * socket stays up, the game keeps running, coming back is instant) but it is
 * not SELECTED, and nothing may be drawn or announced as current while one of
 * these is up.
 *
 * The distinction is the whole fix for the navigation confusion. The rail used
 * to keep `aria-current` on both the open project and the active chat while
 * Skills filled the window, so a screen reader was told you were in a
 * conversation you could not see, and Tester silently inherited whichever
 * project had last been clicked instead of saying which game it meant.
 *
 * Pure, and exported, so the rule is checkable without a store or a viewport.
 */
export function globalPlace(state: {
  screen: 'skills' | 'tester' | null;
  composing: boolean;
  projectPath: string | null;
}): GlobalPlace | null {
  if (state.screen !== null) return state.screen;
  // Mirrors Shell's own routing rule (App.tsx) exactly, and has to: `Home` is
  // rendered when there is no folder OR when `composing` is set, so those are
  // precisely the states that ARE New chat.
  //
  // Reading only `composing` was wrong in the app's most common no-project
  // state. At first launch, and after every Close project, `projectPath` is
  // null and `composing` is false, so this answered "you are in a project"
  // while the window showed the blank composer and the rail marked nothing at
  // all. That is the exact failure this function exists to prevent, in the one
  // case none of its tests covered.
  return state.projectPath === null || state.composing ? 'new-chat' : null;
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
  return chat.kind === 'terminal' || chat.kind === 'devteam' ? chat.kind : 'chat';
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
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
  // `cli` counts: a machine with Claude Code on it can answer with no key.
  return providers.anthropic.hasKey || providers.anthropic.cli || providers.openai.loggedIn || providers.openai.hasKey;
}

/** The folder's stored preference, or null when it has never picked one. */
export function readConversationMode(projectPath: string): ConversationMode | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(conversationModeStorageKey(projectPath));
  } catch {
    return null; // private mode: fall back to the derived default
  }
  return raw === 'chat' || raw === 'terminal' || raw === 'devteam' ? raw : null;
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

/**
 * Whether the game is silenced.
 *
 * One key for the whole app rather than one per folder, because this is a fact
 * about the room the person is sitting in and not about a game: someone who
 * muted a game at midnight wants the next one muted too, and having to mute
 * each new game separately is the setting failing at its only job.
 */
export const GAME_MUTED_KEY = 'hearth.game.muted';

export function readGameMuted(): boolean {
  try {
    return localStorage.getItem(GAME_MUTED_KEY) === '1';
  } catch {
    // Private mode: no preference on record, and unmuted is the state a game
    // is in when nobody has said otherwise.
    return false;
  }
}

function writeGameMuted(muted: boolean): void {
  try {
    localStorage.setItem(GAME_MUTED_KEY, muted ? '1' : '0');
  } catch {
    /* private mode: the preference just doesn't persist */
  }
}

// ---------------------------------------------------------------------------
// Conversation reducer — pure, so the streaming assembly is unit-testable
// without a socket or a React tree.
// ---------------------------------------------------------------------------

export function makeUserMessage(
  text: string,
  attachments?: readonly ChatAttachmentView[],
  orchestration = false,
): ChatMessage {
  return {
    id: `m${++messageId}`,
    role: 'user',
    // A message that is only a picture has no text part: an empty paragraph
    // would render as a blank line under the thumbnail.
    parts: text === '' ? [] : [{ kind: 'text', text }],
    streaming: false,
    ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
    ...(orchestration ? { orchestration: true } : {}),
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
      return {
        type: 'tool-begin',
        toolId: event.id,
        kind: 'other',
        title: event.name,
        detail: event.detail,
      };
    case 'tool-end':
      return 'toolId' in event
        ? event
        : {
            type: 'tool-end',
            toolId: event.id,
            status: event.ok ? 'ok' : 'error',
            summary: event.detail,
          };
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

/**
 * Close out every row that never reported a result.
 *
 * A turn can end with tool rows still open: it failed mid-command, someone
 * pressed Stop, or the driver died. Ending a turn used to flip only the
 * MESSAGE to not-streaming, so those rows kept `state: 'running'` for the life
 * of the transcript, on disk, through a reload. A conversation that finished
 * days ago went on spinning on a command that stopped with it, and the tool-run
 * fold (which refuses to collapse a run holding a live member) stayed pinned
 * open by one stale row.
 *
 * `stopped`, never `ok` and never `error`: nothing here knows the row
 * succeeded, and a command someone interrupted did not necessarily fail. See
 * ToolState in types.ts.
 *
 * Same array identity when nothing was open, so React skips the work.
 */
function settleOpenParts(parts: readonly ChatPart[]): ChatPart[] {
  if (
    !parts.some(
      (part) => ('state' in part && part.state === 'running') || (part.kind === 'input' && part.resolution === null),
    )
  ) {
    return parts as ChatPart[];
  }
  return parts.map((part) => {
    if ('state' in part && part.state === 'running') return { ...part, state: 'stopped' };
    if (part.kind === 'input' && part.resolution === null) return { ...part, resolution: 'withdrawn' };
    return part;
  });
}

/**
 * A message that is no longer being written: nothing is streaming into it and
 * nothing inside it is still claiming to run. Every place a turn ends goes
 * through here, so there is one answer to "what does a half-finished turn look
 * like afterwards" rather than one per ending.
 */
export function settleMessage(message: ChatMessage): ChatMessage {
  const parts = settleOpenParts(message.parts);
  if (!message.streaming && parts === message.parts) return message;
  return { ...message, parts, streaming: false };
}

export function applyChatEvent(messages: ChatMessage[], incoming: ChatEvent, now: number = Date.now()): ChatMessage[] {
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
      if (tail && tail.kind === 'text')
        parts[parts.length - 1] = {
          kind: 'text',
          text: tail.text + event.text,
        };
      else parts.push({ kind: 'text', text: event.text });
      return replace(parts);
    }
    // Closes the open piece of prose so the next one starts its own. It carries
    // no text, so an already-closed message (or a turn that never wrote one) is
    // a no-op rather than an empty paragraph in the transcript.
    case 'message-end': {
      const tail = last.parts[last.parts.length - 1];
      if (!tail || tail.kind !== 'text' || tail.text === '') return messages;
      return replace([...last.parts, { kind: 'text', text: '' }]);
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
        opened = {
          kind: 'skill',
          id: event.toolId,
          name: event.title,
          detail: event.detail,
          state: 'running',
        };
      } else {
        opened = {
          kind: 'tool',
          id: event.toolId,
          name: event.title,
          detail: event.detail,
          state: 'running',
        };
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
            return {
              ...part,
              state: settled,
              detail: event.summary ?? part.detail,
            };
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
        {
          kind: 'file-change',
          id: toolId ?? `${last.id}:f${last.parts.length}`,
          files: event.files,
        },
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
          choices: event.choices,
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
    case 'input-request':
      return replace([
        ...last.parts,
        {
          kind: 'input',
          id: event.inputId,
          title: event.title,
          description: event.description,
          questions: event.questions,
          allowCancel: event.allowCancel ?? true,
          timeoutMs: event.timeoutMs,
          externalAction: event.externalAction,
          resolution: null,
        },
      ]);
    case 'input-resolved':
      return replace(
        last.parts.map((part) =>
          part.kind === 'input' && part.id === event.inputId ? { ...part, resolution: event.action } : part,
        ),
      );
    case 'subagent-start':
      return replace([
        ...last.parts,
        {
          kind: 'subagent',
          id: event.agentId,
          role: event.role,
          title: event.title,
          text: '',
          state: 'running',
        },
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
            ? {
                ...part,
                state: event.status === 'ok' ? 'ok' : 'error',
                summary: event.summary ?? part.summary,
              }
            : part,
        ),
      );
    case 'plan-update': {
      // One card per plan: a revision replaces the list in place, so the
      // transcript shows the plan as it stands rather than every draft of it.
      const parts = last.parts.slice();
      const at = parts.findIndex((part) => part.kind === 'plan' && part.id === event.planId);
      const card: ChatPart = {
        kind: 'plan',
        id: event.planId,
        text: event.text,
      };
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
        {
          kind: 'image',
          id: `img:${event.toolId}`,
          path: event.path,
          caption: event.caption,
        },
      ]);
    case 'notice':
      return replace([...last.parts, { kind: 'notice', text: event.text }]);
    case 'turn-complete':
      // Drop a turn that produced nothing at all rather than leaving an empty
      // bubble behind.
      if (last.parts.length === 0) return messages.slice(0, lastIndex);
      // A turn that ended can hold no work in progress. Codex reports a failed
      // turn as a completion, so this is also the ending a command killed
      // mid-run arrives on.
      return replace(settleOpenParts(last.parts), false);
    case 'error':
      // A failed turn is the app speaking, not the agent. Appended as a text
      // part this used to render in the agent's own voice and typography, so
      // "rate limit exceeded" or an expired login read as something the model
      // had chosen to say. It carries the prompt that was lost so the row can
      // offer to send it again.
      return replace(
        [
          // Whatever was mid-flight stopped with the turn. The failure is the
          // turn's, not necessarily the command's, so the row says it never
          // finished rather than borrowing the error.
          ...settleOpenParts(last.parts),
          {
            kind: 'notice',
            text: event.message,
            tone: 'error',
            retryText: lastUserText(messages),
          },
        ],
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

/** The oldest provider question still blocking its turn. */
export function pendingInputId(messages: readonly ChatMessage[]): string | null {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === 'input' && part.resolution === null) return part.id;
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

/**
 * Rebuild a conversation from what is on disk.
 *
 * `live` is not a detail. A transcript read back is normally a finished thing,
 * so every row is closed out: running commands become stopped, and a question
 * nobody answered becomes withdrawn. Do that to a conversation whose turn is
 * STILL RUNNING on the server and the window quietly destroys it — the agent
 * is sitting on an AskUserQuestion, the replay marks it withdrawn, the prompt
 * that would have answered it never renders, and the run waits on an answer
 * that now has no way to be given. Worse, `applyChatEvent` drops events whose
 * last message is not streaming, so every delta after the reload lands nowhere
 * and the transcript freezes with the pane still saying Working.
 *
 * That is exactly what happened: a dev team interview sat at 19 minutes with
 * an unanswered question invisible on screen, and nothing the person pressed
 * could reach it. So when the server says the turn is still going, the tail of
 * the transcript is left exactly as it was found: streaming, with its asks
 * open, ready for the events still to come.
 */
export function replayTranscript(
  records: readonly ChatRecord[],
  project = '',
  { live = false }: { live?: boolean } = {},
): ChatMessage[] {
  let messages: ChatMessage[] = [];
  for (const record of records) {
    if (record.role === 'user') {
      messages = [
        ...messages,
        makeUserMessage(record.text, replayAttachments(record.attachments, project), record.orchestration === true),
      ];
      continue;
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'agent' || !last.streaming) messages = [...messages, makeAgentMessage()];
    messages = applyChatEvent(messages, record.event);
  }
  // A turn that is running has produced nothing yet when the last thing on
  // disk is what the person said, so the bubble it will stream into has to
  // exist — the same one `sendChat` opens optimistically.
  if (live && (messages.length === 0 || messages[messages.length - 1].role === 'user')) {
    messages = [...messages, makeAgentMessage()];
  }
  const settled = messages.map(settleMessage);
  if (!live || messages.length === 0) return settled;
  // Only the tail. Everything before it belongs to turns that really did end.
  settled[settled.length - 1] = messages[messages.length - 1];
  return settled;
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
  let pendingCliHandoff: { requestId: string; chatId: string } | null = null;
  let loadMetaPromise: Promise<void> | null = null;
  /**
   * Which conversation this window wants to be in, as a frame ready to resend.
   * A chat request made before the socket is open (opening a folder does
   * exactly that) — or one lost to a reconnect — is replayed on connect, so the
   * window never ends up watching a conversation the server isn't sending.
   */
  let chatIntent: Extract<WsFrame, { type: 'chat-open' } | { type: 'chat-new' }> | null = null;
  // The conversation New chat deliberately left behind. An already-sent
  // chat-open can still answer after the blank surface appears; naming it lets
  // that stale answer be ignored without ignoring the fresh chat-new that the
  // first message sends.
  let abandonedChatId: string | null = null;

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
   * Resolve once the folder's socket is up AND the conversation this send
   * belongs in is the one open in it.
   *
   * Three silent failures live under this one wait:
   *
   *   1. a send that beats the socket goes nowhere at all;
   *   2. a send that beats `chat-opened` has its optimistic bubbles wiped by
   *      that frame's transcript replay, and every event after it lands on an
   *      empty list (see applyChatEvent's early return), so the turn really
   *      runs, spends real quota, and the window shows a blank page;
   *   3. a send the server receives before the conversation binds mints a
   *      SECOND chat for the same first message.
   *
   * `replacing` is why the test is not simply `activeChatId !== null`. When a
   * brand-new conversation is being minted inside a folder that already has
   * one open, "a conversation exists" was true before the request was even
   * sent, so the wait resolved synchronously and failure 2 happened every
   * time, which is exactly what the wait was written to prevent. Readiness
   * for a NEW conversation means a DIFFERENT one is open, so the caller names
   * the one it is leaving and that one does not count as an answer.
   *
   * Pass null when there is nothing to leave: opening a folder clears
   * `activeChatId` itself, so any id that appears there is the new folder's.
   */
  function waitForChatSurface(replacing: string | null, timeoutMs = CONNECT_WAIT_MS): Promise<boolean> {
    return waitForState(
      (state) => state.wsStatus === 'connected' && state.activeChatId !== null && state.activeChatId !== replacing,
      timeoutMs,
    );
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

  /**
   * The record the server last opened for this window.
   *
   * `chats` is no longer a complete answer to "what am I in": a chat that has
   * not been typed into yet is left out of every list (server/chatStore.ts),
   * and it is precisely the one a window sits in between asking for a new chat
   * and sending the first message. The opened record is the answer for that
   * gap, and it is kept here rather than in state because only the actions
   * below read it, so nothing should re-render for it.
   */
  let openedChat: ChatSummary | null = null;
  /** Deleted ids reject late run snapshots until this workspace or id is opened afresh. */
  const deletedChatIds = new Set<string>();

  /** The conversation this window has open, as its record. Null on Home. */
  function activeConversation(): ChatSummary | null {
    const state = get();
    if (state.activeChatId === null) return null;
    return (
      state.chats.find((chat) => chat.id === state.activeChatId) ??
      // Guarded on the id, so a record left over from the conversation before
      // this one can never answer for the one that is open.
      (openedChat !== null && openedChat.id === state.activeChatId ? openedChat : null)
    );
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
    set({
      composing: false,
      projectView: false,
      screen: null,
      messages: [],
      chatBusy: false,
      chatDriver: null,
      slashCommands: [],
      chatError: null,
      queued: [],
      devTeam: null,
      devTeamLanes: {},
      narrowTab: 'chat',
    });
    applyConversationMode(kind);
    requestChat({
      type: 'chat-new',
      kind,
      ...(title === undefined ? {} : { title }),
    });
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
        set((state) => ({
          journalFeed: [...state.journalFeed, ...frame.entries].slice(-MAX_JOURNAL_FEED),
        }));
        return;
      case 'chat-ready':
        set({ chatDriver: frame.driver });
        get().sendFrame({ type: 'chat-commands-list' });
        return;
      case 'chat-commands':
        if (frame.chatId && frame.chatId !== get().activeChatId) return;
        set({ slashCommands: frame.commands });
        return;
      case 'chat-handoff-ready':
        if (!pendingCliHandoff || frame.requestId !== pendingCliHandoff.requestId) return;
        pendingCliHandoff = null;
        markAgentCli({
          id: frame.provider === 'anthropic' ? 'claude' : 'codex',
          label: frame.label,
        });
        enterTerminalConversation(`${frame.label} CLI`);
        return;
      case 'chat-handoff-error':
        if (!pendingCliHandoff || frame.requestId !== pendingCliHandoff.requestId) return;
        pendingCliHandoff = null;
        resetAgentSocket();
        get().log('error', 'app', frame.message);
        showToast(frame.message, 'error');
        return;
      case 'chat-providers':
        // Pushed rather than polled: a ChatGPT login finishes in a browser
        // window this app doesn't own, and the dialog behind it has to notice.
        set({ providers: frame.status });
        return;
      case 'chat-list':
        set({ chats: frame.chats, chatsLoaded: true });
        // The index changed (a chat was created, renamed, retitled, deleted),
        // which is exactly what the global list is a view of.
        scheduleRecentChats();
        return;
      case 'chat-opened':
        // Navigation wins over a late socket answer. Without this, clicking
        // New chat while open-latest was still in flight immediately restored
        // that old transcript and made the app look one-chat-per-project.
        if (get().composing && frame.chat.id === abandonedChatId) return;
        abandonedChatId = null;
        // A `chat-new` that has landed becomes a plain "open this one" intent,
        // so a later reconnect resumes this chat instead of minting another.
        chatIntent = { type: 'chat-open', chatId: frame.chat.id };
        // The only place this window is told what kind of thing it is looking
        // at while the conversation is still too new to be in any list.
        openedChat = frame.chat;
        // Unlike a delayed run snapshot, a successful open is authoritative:
        // this id exists again and may publish fresh team status.
        deletedChatIds.delete(frame.chat.id);
        // The record decides what the column shows. This is the whole of the
        // rule "a conversation has a kind": whatever the window was showing a
        // moment ago, it now shows the thing that was opened.
        applyConversationMode(conversationKind(frame.chat));
        // A turn the server is still running belongs to whoever opens the
        // conversation next, not only to the window that started it.
        const turnActive = frame.turnActive === true;
        set((state) => ({
          activeChatId: frame.chat.id,
          messages: replayTranscript(frame.records, state.projectPath ?? '', { live: turnActive }),
          devTeam: null,
          devTeamLanes: {},
          // A non-team record is authoritative too: it cannot retain a stale
          // team badge merely because an older frame once used the same id.
          devTeamByChat: conversationKind(frame.chat) === 'devteam'
            ? state.devTeamByChat
            : withoutKey(state.devTeamByChat, frame.chat.id),
          // Busy only where busy means "queue what I type": a dev team run
          // spends its life in turns the runtime starts, and a note typed
          // during one has to reach the runtime as steering rather than sit in
          // a client queue behind a turn nobody here started. That pane offers
          // Stop from the run's own phase instead.
          chatBusy: turnActive && conversationKind(frame.chat) !== 'devteam',
          chatDriver: null,
          slashCommands: [],
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
        }));
        // Switching conversations empties the queue, so anything still in it
        // here survived a dropped socket rather than belonging to somewhere
        // else. The connection is back; send it.
        drainQueue();
        return;
      case 'devteam-state': {
        if (deletedChatIds.has(frame.chatId)) return;
        const belongsToOpenPane =
          frame.chatId === get().activeChatId &&
          chatIntent?.type === 'chat-open' &&
          chatIntent.chatId === frame.chatId;
        set((state) => ({
          devTeamByChat: { ...state.devTeamByChat, [frame.chatId]: frame.state },
          ...(belongsToOpenPane
            ? {
                devTeam: frame.state,
                devTeamLanes: state.devTeam?.runId === frame.state.runId ? state.devTeamLanes : {},
              }
            : {}),
        }));
        return;
      }
      case 'devteam-steering-accepted': {
        // A steering note is folded into the lead's next turn instead of
        // starting one, so the turn this window optimistically began is never
        // going to end on its own. This is that ending: without it the composer
        // keeps a Stop button for a turn that does not exist, and everything
        // typed afterwards queues locally and is never sent.
        //
        // The user's own words stay — the server wrote them to the transcript
        // before answering — and the empty agent bubble becomes the receipt.
        //
        // It used to be deleted, which left a message sent to the lead with no
        // answer and no acknowledgement of any kind: indistinguishable, from
        // the chair, from a send that failed. This is the one send in the app
        // that is deliberately answered by nobody, so it has to say so itself.
        if (frame.chatId !== get().activeChatId) return;
        set((state) => {
          const last = state.messages[state.messages.length - 1];
          const filed: ChatMessage = {
            ...last,
            parts: [{ kind: 'notice', text: 'Noted. The lead reads this at the next handoff.' }],
            streaming: false,
          };
          return {
            chatBusy: false,
            messages:
              last && last.role === 'agent' && last.parts.length === 0
                ? [...state.messages.slice(0, -1), filed]
                : state.messages,
          };
        });
        drainQueue();
        return;
      }
      case 'devteam-event':
        if (
          frame.chatId !== get().activeChatId ||
          chatIntent?.type !== 'chat-open' ||
          chatIntent.chatId !== frame.chatId
        ) return;
        set((state) => {
          const lane = state.devTeamLanes[frame.engineerId] ?? [makeAgentMessage()];
          return {
            devTeamLanes: {
              ...state.devTeamLanes,
              [frame.engineerId]: applyChatEvent(lane, normalizeChatEvent(frame.event)),
            },
          };
        });
        return;
      case 'chat-event': {
        // An event belongs to the conversation it came from, and only recently
        // did the frame say which. A session being torn down goes on emitting
        // (its last approval-resolved and turn-complete arrive after the
        // teardown, by design), so with no id those tail events landed in
        // whatever conversation had been opened since and cleared ITS busy
        // state, in the middle of a live turn.
        //
        // `activeChatId !== null` is load-bearing: the server can mint a chat
        // for a send before the window has one, and comparing unconditionally
        // would drop exactly those events.
        const active = get().activeChatId;
        if (frame.chatId !== undefined && active !== null && frame.chatId !== active) return;
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
      case 'tester-started':
        set((state) => ({
          tester: {
            ...state.tester,
            running: true,
            starting: false,
            session: frame.session,
            maxSteps: frame.maxSteps,
            phase: 'opening',
            thoughts: [],
            lastNote: null,
            error: null,
          },
        }));
        return;
      case 'tester-phase':
        set((state) => ({ tester: { ...state.tester, phase: frame.phase } }));
        return;
      case 'tester-thought':
        set((state) => {
          const thoughts = state.tester.thoughts;
          const last = thoughts[thoughts.length - 1];
          // The text arrives in fragments; `turn` is what says whether this one
          // continues the answer above it or starts a new one.
          const next =
            last && last.turn === frame.turn
              ? [...thoughts.slice(0, -1), { turn: last.turn, text: last.text + frame.text }]
              : [...thoughts, { turn: frame.turn, text: frame.text }];
          return {
            tester: {
              ...state.tester,
              thoughts: next.slice(-MAX_TESTER_THOUGHTS),
            },
          };
        });
        return;
      case 'tester-done':
        set((state) => ({
          tester: {
            ...state.tester,
            running: false,
            starting: false,
            phase: 'finished',
            lastNote: frame.note,
            // The note is on disk now, so the history this window holds is one
            // session out of date. Replaced by session AND start time, because
            // the number is not an identity: the folder it comes out of is
            // hand-editable, so two notes in one game can claim the same one,
            // which is why a row carries the position of its note rather than
            // its number. De-duping on the number alone deleted the other
            // session from this window's record of an append-only history.
            sessions: [
              ...state.tester.sessions.filter(
                (s) => s.session !== frame.note.session || s.startedAt !== frame.note.startedAt,
              ),
              frame.note,
            ],
          },
        }));
        return;
      case 'tester-error':
        set((state) => ({
          tester: {
            ...state.tester,
            running: false,
            starting: false,
            phase: null,
            error: frame.message,
          },
        }));
        get().log('error', 'app', `Tester: ${frame.message}`);
        return;
      case 'pty-data':
      case 'pty-exit':
      case 'pty-error':
        ingestPtyFrame(frame);
        return;
      case 'pty-attach':
        ingestPtyAttach(frame);
        if (frame.handoff) {
          const shouldNavigate = pendingCliHandoff !== null;
          pendingCliHandoff = null;
          markAgentCli({
            id: frame.handoff.provider === 'anthropic' ? 'claude' : 'codex',
            label: frame.handoff.label,
          });
          if (shouldNavigate) enterTerminalConversation(`${frame.handoff.label} CLI`);
        }
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
        socket.send(
          JSON.stringify({
            type: 'pty-start',
            sessionId: ensureAgentPtySessionId(),
          }),
        );
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
          messages: state.messages.map(settleMessage),
        }));
      }
      scheduleReconnect(project, epoch);
    };
  }

  function disconnectWs(): void {
    wsEpoch++;
    wsBackoffMs = WS_BACKOFF_INITIAL_MS;
    chatIntent = null;
    abandonedChatId = null;
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
    devTeam: null,
    devTeamLanes: {},
    devTeamByChat: {},
    chatBusy: false,
    queued: [],
    chatDriver: null,
    slashCommands: [],
    chatError: null,
    settings: null,
    providers: null,
    permissionMode: DEFAULT_PERMISSION_MODE,
    permissionSkipAcknowledged: false,
    chats: [],
    chatsLoaded: false,
    activeChatId: null,
    recentChats: [],
    recentChatsLoaded: false,

    game: EMPTY_GAME,
    gameKnown: false,
    senses: [],
    shimDetected: false,
    gameNonce: 0,
    tester: EMPTY_TESTER,

    consoleEntries: [],
    consoleUnread: 0,
    consoleAtBottom: true,

    sidebarCollapsed: readSidebarCollapsed(),
    conversationMode: 'chat',
    conversationModePinned: false,
    paneTab: 'game',
    paneOpen: false,
    gameMuted: readGameMuted(),
    paneChoice: null,
    composing: false,
    composeTarget: null,
    projectView: false,
    screen: null,
    testerTarget: null,
    naming: null,
    testerRuns: null,
    narrowTab: 'chat',
    codePeek: { open: false, path: null },
    pendingPrompt: null,
    composerDrafts: {},
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

    async openWorkspace(path, prompt, conversation = 'latest', newKind = 'chat') {
      const res = await apiOpenWorkspace(path);
      if (!res.ok || !res.info) return { ok: false, error: res.error ?? 'Could not open that folder.' };
      const info: WorkspaceInfo = res.info;
      chatIntent = null;
      abandonedChatId = null;
      deletedChatIds.clear();
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
      // An unsent message belongs to the folder it was written in, so it does
      // not follow the window into the next one. Released rather than dropped,
      // because the tray's thumbnails are object URLs this window is holding.
      // Not Home's: that composer is the one that OPENS folders, and this runs
      // in the middle of its send. See FOLDER_DRAFT_KEYS.
      get().clearDrafts(FOLDER_DRAFT_KEYS);
      set({
        projectPath: info.path,
        projectName: info.name,
        isHearthProject: info.isHearthProject,
        messages: [],
        chatBusy: false,
        chatDriver: null,
        slashCommands: [],
        chatError: null,
        providers: null,
        // Which key answers for a folder is the folder's own answer: a project
        // with its own key must not vouch for the next one for the length of a
        // round trip. Null is the honest pre-read value, and it is also what
        // holds `maybeSettleConversationMode` until BOTH reads land.
        settings: null,
        // The console is a record of what happened in a folder, so project A's
        // stack traces have no business in project B's pane. Cleared here as
        // well as on close, because a switch is a close and an open.
        consoleEntries: [],
        consoleUnread: 0,
        consoleAtBottom: true,
        // The folder being left does not lend this one its permissions. Back
        // to the default until this folder's own answer lands below, so a
        // project that had skipped every check cannot hand that to the next
        // one for the length of a round trip.
        permissionMode: DEFAULT_PERMISSION_MODE,
        permissionSkipAcknowledged: false,
        chats: [],
        chatsLoaded: false,
        activeChatId: null,
        devTeam: null,
        devTeamLanes: {},
        devTeamByChat: {},
        queued: [],
        journalFeed: [],
        game: EMPTY_GAME,
        // Nobody has looked in THIS folder yet. Carried over from the last one,
        // it would let a new project inherit the old one's certainty for the
        // length of a round trip.
        gameKnown: false,
        senses: [],
        shimDetected: false,
        gameNonce: 0,
        // The tester belongs to the folder, so nothing about the last one
        // survives into this one.
        tester: EMPTY_TESTER,
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
        // `screen`, `projectView` and `composing` are deliberately NOT set
        // here. Opening a folder is not a view: `openProject` wants the
        // project screen, `openRecentChat` wants a conversation, and
        // `startFromHome` wants the one it is about to send into. Clearing
        // them here made the project screen appear and then vanish mid-open
        // (the same flicker `chat-opened` documents), so each caller says
        // where it is going instead, before and after this round trip.
      });
      connectWs(info.path);
      await Promise.all([
        get().refreshGame(),
        get().refreshSettings(),
        get().refreshProviders(),
        get().refreshPermissionMode(),
        get().refreshChats(),
        get().refreshRecentChats(),
        // Read once on open, so a window that arrives while a session is
        // already playing says so everywhere rather than only on the surface
        // that happens to ask.
        get().refreshTesterHistory(),
      ]);
      // Land in the most recent conversation, or start the folder's first one.
      // Either way the window opens on a conversation, never on nothing.
      const chats = get().chats;
      if (get().projectPath === info.path) {
        // Opening a folder is an act of intent, so it lands in the folder, and
        // it lands there the same way whatever is inside. This used to be
        // decided by the branch below: `openChat` leaves a global screen, and
        // the empty-folder branch does not, so opening a project from Skills
        // put you in the project or left you on Skills depending on whether
        // that folder had ever been talked to. Said here, once, for both.
        //
        // `projectView` and `composing` are still the caller's to say: which
        // surface OF the folder you wanted is what the caller knows and this
        // does not.
        set({ screen: null });
        // `chat-new` directly, not `newChat()`: that action shows the blank
        // NEW-CHAT SURFACE, which is a different thing from asking the server
        // for an empty conversation. Opening a project has to land on a real
        // one, or the socket has nothing to send into.
        if (conversation === 'new' || chats.length === 0) {
          requestChat({ type: 'chat-new', ...(newKind === 'devteam' ? { kind: newKind } : {}) });
        }
        else get().openChat(chats[0].id);
      }
      return { ok: true };
    },

    closeWorkspace() {
      try {
        localStorage.removeItem(LAST_WORKSPACE_KEY);
      } catch {
        /* ignore */
      }
      // Closing is a fact about the SERVER, not only about this window. The
      // set of folders the server will serve files from and accept sockets
      // for used to only ever grow: a folder opened once stayed reachable for
      // the life of the process, however emphatically it had been closed. Not
      // awaited and not reported — nothing about this failing is something the
      // person closing a project can act on, and the window has already left.
      const closing = get().projectPath;
      if (closing !== null) void apiCloseWorkspace(closing);
      disconnectWs();
      deletedChatIds.clear();
      // The unsent message goes with the folder it was written in, and its
      // pictures are let go of rather than left behind. See openWorkspace.
      get().clearDrafts(FOLDER_DRAFT_KEYS);
      set({
        projectPath: null,
        projectName: null,
        isHearthProject: false,
        messages: [],
        chatBusy: false,
        chatDriver: null,
        slashCommands: [],
        chatError: null,
        settings: null,
        providers: null,
        permissionMode: DEFAULT_PERMISSION_MODE,
        permissionSkipAcknowledged: false,
        chats: [],
        chatsLoaded: false,
        activeChatId: null,
        devTeam: null,
        devTeamLanes: {},
        devTeamByChat: {},
        queued: [],
        journalFeed: [],
        game: EMPTY_GAME,
        // Nobody has looked in THIS folder yet. Carried over from the last one,
        // it would let a new project inherit the old one's certainty for the
        // length of a round trip.
        gameKnown: false,
        senses: [],
        shimDetected: false,
        gameNonce: 0,
        // The tester belongs to the folder. Its history left standing is why
        // the Tester screen went on offering a Play button for a game that was
        // no longer open.
        tester: EMPTY_TESTER,
        // Errors are things that happened IN a folder. Carried across a close
        // they read as errors in whatever is opened next.
        consoleEntries: [],
        consoleUnread: 0,
        consoleAtBottom: true,
        conversationMode: 'chat',
        conversationModePinned: false,
        paneTab: 'game',
        paneOpen: false,
        paneChoice: null,
        narrowTab: 'chat',
        codePeek: { open: false, path: null },
        pendingPrompt: null,
        // WHERE the window is, not just what it is holding. A project view is
        // a view OF a folder, so a closed folder cannot leave one up.
        //
        // A global screen is NOT, and that is the distinction `globalPlace`
        // exists to hold. Skills is the person's library and Tester is a
        // history across every game: neither reads the open folder, so closing
        // one project while standing on either is not a reason to throw the
        // reader back to the blank composer. (The old rule cleared it, from
        // when Tester was per-project and survived a close reading "your tester
        // has not played this game yet" with no game open. That screen is gone;
        // TesterHistory reads the global run list and names the game it aims
        // at.) `screen` is therefore deliberately absent from this set.
        projectView: false,
        composing: false,
        // The blank composer aimed at a folder that is no longer open would
        // start the next message inside it.
        composeTarget: null,
      });
      // recentChats deliberately survives: it spans folders, and the rail is
      // the first thing a user looks at after closing one. So does
      // `personalization`, which lives in ~/.hearth and belongs to the person,
      // not to any one project.
      //
      // `providers` was just cleared with the folder's other state (it carried
      // the folder's own key and provider choice), but the account row is
      // still on screen and who the person is signed in as did not change with
      // the close: read the machine-level answer back rather than leaving the
      // row on "haven't looked yet".
      void get().refreshProviders();
    },

    sendChat(text, attachments) {
      const trimmed = text.trim();
      const files = attachments ?? [];
      // A picture on its own is a message; nothing at all is not.
      if (trimmed === '' && files.length === 0) return false;
      // A turn already running is not a reason to lose what someone typed.
      // The thought arrives while the agent is mid-answer — that is WHEN
      // people think of things — so it waits its turn instead of being
      // swallowed by a disabled box. Drained by `drainQueue` (see below).
      if (get().chatBusy) {
        set((state) => ({
          queued: [...state.queued, { id: `q${++queuedId}`, text: trimmed, attachments: files }],
        }));
        // Taken, not sent: `drainQueue` sends it the moment the turn ends, so
        // a caller waiting to hear that the message is on its way has heard it.
        return true;
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
      const send = (uploadTokens?: { uploadToken: string }[]): boolean => {
        if (
          get().sendFrame({
            type: 'chat-send',
            text: trimmed,
            ...(agent ? { agent } : {}),
            ...(uploadTokens && uploadTokens.length > 0 ? { attachments: uploadTokens } : {}),
          })
        ) {
          return true;
        }
        // Said out loud, not only to the console. The console panel lives
        // behind a tab in the game pane, so someone who pressed send and saw
        // nothing happen had no reason to go looking for the explanation.
        const note = 'Not connected. Wait a moment and send again.';
        get().log('error', 'app', note);
        showToast(note, 'error');
        return false;
      };
      if (files.length === 0) {
        if (!send()) return false;
      } else {
        const project = get().projectPath;
        if (!project) return false;
        // Upload raw bytes over HTTP; the socket receives only opaque tokens.
        // Uploading runs behind the optimistic bubble so a large screenshot
        // never makes the composer feel like its Send click was ignored.
        void Promise.all(files.map((file) => apiUploadChatAttachment(project, file))).then((results) => {
          if (get().projectPath !== project || !get().chatBusy) return;
          const failed = results.find((result) => !result.ok);
          if (failed && !failed.ok) {
            get().log('error', 'app', failed.error);
            showToast(failed.error, 'error');
            set((state) => ({
              chatBusy: false,
              messages: state.messages.map(settleMessage),
            }));
            return;
          }
          if (!send(results.flatMap((result) => (result.ok ? [{ uploadToken: result.upload.uploadToken }] : [])))) {
            set((state) => ({
              chatBusy: false,
              messages: state.messages.map(settleMessage),
            }));
          }
        });
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
      return true;
    },

    cancelChat() {
      get().sendFrame({ type: 'chat-cancel' });
      set((state) => ({
        chatBusy: false,
        messages: state.messages.map(settleMessage),
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
        messages: state.messages.map(settleMessage),
      }));
      // "Stop, do this instead" is the whole reason someone queues a message
      // during a turn they can see going wrong. The agent is still bound, so
      // the next one continues the same conversation.
      drainQueue();
    },

    unqueueChat(id) {
      set((state) => ({
        queued: state.queued.filter((message) => message.id !== id),
      }));
    },

    receiveFrame(frame) {
      handleFrame(frame);
    },

    approveChat(approvalId, decision, choiceId) {
      get().sendFrame({
        type: 'chat-approval',
        approvalId,
        decision,
        ...(choiceId ? { choiceId } : {}),
      });
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

    answerChatInput(inputId, action, answers) {
      const frame = {
        type: 'chat-input-response',
        inputId,
        action,
        ...(action === 'submit' && answers ? { answers } : {}),
      };
      if (!get().sendFrame(frame as WsFrame)) return false;

      // Optimistic like approvals, but values are intentionally absent. The
      // server echo writes only the action too, so a secret cannot return on
      // replay through either path.
      set((state) => ({
        messages: state.messages.map((message) =>
          message.parts.some((part) => part.kind === 'input' && part.id === inputId && part.resolution === null)
            ? {
                ...message,
                parts: message.parts.map((part) =>
                  part.kind === 'input' && part.id === inputId ? { ...part, resolution: action } : part,
                ),
              }
            : message,
        ),
      }));
      return true;
    },

    refreshChatCommands() {
      if (get().chatDriver) get().sendFrame({ type: 'chat-commands-list' });
    },

    async refreshProviders() {
      // Home has an account row and a composer too: with no folder open the
      // read still goes out, project-less, and answers with the machine-level
      // facts (who the CLIs are signed in as). Leaving early here left the row
      // on "haven't looked yet" forever until a first project was opened.
      const project = get().projectPath;
      const providers = await apiChatProviders(project ?? null);
      if (get().projectPath !== project) return; // folder changed mid-flight
      // A read that did not land leaves the last answer standing, the same way
      // refreshPermissionMode does below. This route answers 403 for a root the
      // server has not marked open yet, which includes the gap in the middle of
      // a project switch, and writing that null through made the account row
      // say "Not signed in" and the top bar "No agent connected" while the very
      // same endpoint was still answering loggedIn: true on the next call.
      // Uncertainty must never resolve into a confident "not connected".
      //
      // Nothing is settled from a failed read either: choosing chat or terminal
      // for a folder on an answer nobody got is the same lie one step later.
      if (!providers) return;
      set({ providers });
      maybeSettleConversationMode();
    },

    async setChatProvider(provider) {
      // The window's own choice first. See the interface doc: this is what the
      // next turn carries, and it must take effect whether or not a folder is
      // open, because Home has a composer too.
      // Where this agent was last left, not a blank slate. Nothing is carried
      // ACROSS from the agent being left; see rememberedChoiceFor.
      setModelChoice(rememberedChoiceFor(provider));
      const project = get().projectPath;
      if (!project) return;
      const saved = await apiSaveProviderSettings(project, { provider });
      if (get().projectPath !== project) return; // folder changed mid-flight
      if (!saved) {
        get().log('error', 'app', 'Hearth could not save which agent answers. It is set for this window only.');
        return;
      }
      await get().refreshProviders();
    },

    async refreshPermissionMode() {
      const project = get().projectPath;
      if (!project) return;
      const info = await apiPermissionMode(project);
      if (get().projectPath !== project) return; // folder changed mid-flight
      // A read that did not land leaves the default standing rather than
      // blanking the control: this is also what the very first run of a build
      // whose server has not learned the route yet looks like, and the pill
      // has to keep naming a real behaviour through it.
      if (!info) return;
      set({
        permissionMode: info.mode,
        permissionSkipAcknowledged: info.skipAcknowledged,
      });
    },

    async setPermissionMode(mode, acknowledgeSkip = false) {
      const project = get().projectPath;
      if (!project) return;
      // The server first, the mirror second, unlike almost every other control
      // in this file. A pill reading "Skip all checks" while the project on
      // disk still says otherwise is a claim about what the agent may do, and
      // that is the one kind of optimism worth paying a round trip to avoid.
      const info = await apiSetPermissionMode(project, {
        mode,
        ...(acknowledgeSkip ? { skipAcknowledged: true } : {}),
      });
      if (get().projectPath !== project) return; // folder changed mid-flight
      if (!info) {
        const note = 'Could not save the permission setting.';
        get().log('error', 'app', note);
        showToast(note, 'error');
        return;
      }
      set({
        permissionMode: info.mode,
        permissionSkipAcknowledged: info.skipAcknowledged,
      });
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
      //
      // `activeChatId` is untouched too, and that is not an oversight: the
      // previous conversation is still the one the server has open, and it
      // stays that way until the first message asks for another. Nothing may
      // read "a conversation is open" as "the surface is ready to be sent
      // into": see waitForChatSurface, which takes the conversation being
      // left as an argument for exactly this reason.
      abandonedChatId = chatIntent?.type === 'chat-open' ? chatIntent.chatId : get().activeChatId;
      // Reconnecting while the blank surface is up must not replay the chat
      // it just left. The first send installs a chat-new intent of its own.
      chatIntent = null;
      set({
        composing: true,
        projectView: false,
        screen: null,
        composeTarget: get().projectPath,
        messages: [],
        chatBusy: false,
        chatError: null,
        paneOpen: false,
        // The column is closing, so the narrow layout's tab has to come back
        // with it — `setPaneOpen(false)` does this for the same reason, and
        // this path sets `paneOpen` directly rather than going through it.
        // Left on 'pane' it is a stale answer waiting to be believed: the next
        // game to appear reopens the column and the window would land on the
        // game rather than on whatever was asked for.
        narrowTab: 'chat',
        queued: [],
        devTeam: null,
        devTeamLanes: {},
      });
      // A new chat is a chat. Leaving the column in the terminal would show a
      // shell to someone who just asked for a blank page to write on.
      applyConversationMode('chat');
    },

    newDevTeam() {
      startConversationOfKind('devteam');
    },

    setComposeTarget(path) {
      set({ composeTarget: path });
    },

    setTesterTarget(path) {
      set({ testerTarget: path });
    },

    askProjectName(suggestion) {
      // A second ask while one is up means the first was abandoned. Answer it
      // null rather than leaving a promise that nothing will ever settle, or
      // `startFromHome` would sit in its `finally` forever with `homeBusy`
      // true and the composer locked.
      answerNaming(null);
      // The resolver is armed BEFORE the state moves, and that order is the
      // whole of it: `set` notifies subscribers synchronously, so anything
      // that answers the moment it sees the question — a test standing in for
      // the dialog, or any future auto-answer — would otherwise call
      // `answerNaming` while `namingResolve` was still null and the promise
      // would hang forever with the composer locked behind it.
      const waiting = new Promise<string | null>((resolve) => {
        namingResolve = resolve;
      });
      set({ naming: { suggestion } });
      return waiting;
    },

    answerProjectName(path) {
      set({ naming: null });
      answerNaming(path);
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
      // Nothing else moves. A global screen is not a view OF the open project,
      // so it takes no aim from `projectPath`: Skills is the person's library
      // and Tester is a history across every game. The folder underneath stays
      // open and connected — the socket, the running game and the warm chat
      // list are what make coming back instant — it simply stops being the
      // answer to "where am I", which `globalPlace` is what decides.
      //
      // `composing` and `projectView` are deliberately left standing so that
      // leaving returns to the exact arrangement the screen covered.
      set({ screen });
    },

    openTesterFor(path) {
      // The aim is set BEFORE the screen appears, so the picker never draws
      // one game's name and then swaps it for another under the reader.
      set({ testerTarget: path, screen: 'tester' });
    },

    closeScreen() {
      set({ screen: null });
    },

    openChat(chatId) {
      // Asking for a conversation is asking to leave the project screen, even
      // when that conversation is already the active one underneath it.
      //
      // `narrowTab` goes with it. Below the breakpoint the conversation and the
      // playtest column are two tabs of one region, so a window left on the
      // game tab answered "open this conversation" by carrying on showing the
      // game: the row was clicked, the conversation was opened, and nothing on
      // screen changed. Asking for a conversation is asking to SEE it.
      set({ projectView: false, screen: null, narrowTab: 'chat' });
      if (get().activeChatId === chatId) return;
      // Anything still queued was meant for the conversation being left.
      set({ chatBusy: false, chatError: null, queued: [], devTeam: null, devTeamLanes: {} });
      requestChat({ type: 'chat-open', chatId });
    },

    async renameChat(chatId, title, from) {
      const project = from ?? get().projectPath;
      if (!project) return;
      const res = await apiRenameChat(project, chatId, title);
      // A rename that did not land used to be silence: the old title just came
      // back on the next paint, and whether the server refused or was never
      // reached, the person who typed the new one was told nothing. The rail
      // has no error surface of its own, so the reason goes where they already
      // are — the toast — and the console keeps the record.
      if (!res.ok) {
        get().log('error', 'app', res.error);
        showToast(res.error, 'error');
        return;
      }
      if (get().projectPath === project) set({ chats: res.chats });
      // The row is in the global list too, and that list is a snapshot on a
      // schedule: without this the old title sits there until the next read.
      set((state) => ({
        recentChats: state.recentChats.map((entry) =>
          entry.id === chatId ? { ...entry, title } : entry,
        ),
      }));
    },

    async deleteChat(chatId, from) {
      const project = from ?? get().projectPath;
      if (!project) return;
      const res = await apiDeleteChat(project, chatId);
      // Same as renameChat: a delete that failed must say so where the click
      // happened, because the row still being there reads as a bug, not as a
      // request that never arrived.
      if (!res.ok) {
        get().log('error', 'app', res.error);
        showToast(res.error, 'error');
        return;
      }
      deletedChatIds.add(chatId);
      const open = get().projectPath === project;
      // Gone from the list it was clicked in, now. `chats` is the open folder's
      // and must not be handed another folder's answer; `recentChats` spans
      // folders and is refreshed on a schedule, so leaving it to that read is
      // how a deleted conversation stays on screen for the next four hundred
      // milliseconds and comes back if the read is slower than that.
      set((state) => ({
        ...(open ? { chats: res.chats } : {}),
        recentChats: state.recentChats.filter((entry) => entry.id !== chatId),
        devTeamByChat: withoutKey(state.devTeamByChat, chatId),
      }));
      // Deleting the conversation you are reading leaves nowhere to be: land in
      // the next one, or start a fresh one. Deleting one in another folder
      // leaves the screen alone, because nothing on it was that conversation.
      if (!open || get().activeChatId !== chatId) return;
      if (res.chats.length > 0) {
        set({ activeChatId: null });
        get().openChat(res.chats[0].id);
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
      // Read, whatever came back. An empty list from a request that failed is
      // still an answer the screen has to draw something for, and "looking…"
      // forever would be the worse lie.
      if (get().projectPath === project) set({ chats, chatsLoaded: true });
    },

    async refreshRecentChats() {
      // No project guard: this list spans folders and is the only thing the
      // rail has to show before one is open.
      set({ recentChats: await apiRecentChats(), recentChatsLoaded: true });
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

    async startFromHome(text, attachments, kind = 'chat') {
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
          // Ask for the name rather than taking one from the sentence. The
          // dialog does the creating, so what comes back is a folder that
          // exists, and the field arrives holding a draft of the answer so the
          // fast path is still one keystroke.
          //
          // Dismissed is not failed: nothing is said, nothing is created, and
          // `{ ok: false }` with no error keeps the words in the composer
          // exactly where they were typed.
          root = await get().askProjectName(suggestProjectName(trimmed));
          if (root === null) return { ok: false };
        }
        // The conversation this message must NOT land in, for the wait below.
        // Only the already-open branch has one: opening a folder clears
        // `activeChatId`, and the chat it lands in is the new folder's.
        let leaving: string | null = null;
        if (get().projectPath !== root) {
          const opened = await get().openWorkspace(root, undefined, 'new', kind);
          if (!opened.ok) {
            return fail(opened.error ?? 'Could not open that project.');
          }
        } else {
          // Already here, so the only thing missing is somewhere to put the
          // message: a project sitting on a finished conversation must not
          // have this one appended to it. `newChat` leaves that conversation
          // open underneath the blank surface, so it is named here rather than
          // inferred from the state.
          leaving = get().activeChatId;
          requestChat({ type: 'chat-new', kind });
        }
        // The first thing this folder did was receive this kind of message, so
        // that is the mode it opens in. This only moves the column: asking
        // through setConversationMode would try to start a second conversation.
        applyConversationMode(kind);
        // The send needs the conversation the open just started, not merely
        // the socket. Wait for it; if it never comes, hand the words to the
        // composer instead of dropping them on the floor.
        if (!(await waitForChatSurface(leaving))) {
          set({ pendingPrompt: trimmed });
          return fail('The project opened, but nothing is listening yet. Your message is in the composer.');
        }
        // The message is about to land in a conversation, so the window shows
        // that conversation. Neither the blank surface nor the project screen
        // nor a full screen over the top may still be covering it, or the
        // words go somewhere the person who typed them cannot see. In the
        // narrow layout the game tab covers it just as completely as a screen
        // does, so the region comes back to the conversation too.
        set({
          composing: false,
          projectView: false,
          screen: null,
          narrowTab: 'chat',
        });
        get().sendChat(trimmed, files);
        return { ok: true };
      } finally {
        set({ homeBusy: false });
      }
    },

    approveDevTeamSpec() {
      get().sendFrame({ type: 'devteam-approve-spec' });
    },

    pauseDevTeam() {
      get().sendFrame({ type: 'devteam-pause' });
    },

    resumeDevTeam() {
      get().sendFrame({ type: 'devteam-resume' });
    },

    recoverDevTeam() {
      get().sendFrame({ type: 'devteam-recover' });
    },

    stopDevTeam() {
      get().sendFrame({ type: 'devteam-stop' });
    },

    approveEngineer(engineerId, approvalId, decision, choiceId) {
      if (!get().sendFrame({
        type: 'devteam-engineer-approval',
        engineerId,
        approvalId,
        decision,
        ...(choiceId ? { choiceId } : {}),
      })) return;
      set((state) => ({
        devTeamLanes: {
          ...state.devTeamLanes,
          [engineerId]: (state.devTeamLanes[engineerId] ?? []).map((message) =>
            message.parts.some((part) => part.kind === 'approval' && part.id === approvalId && part.decision === null)
              ? {
                  ...message,
                  parts: message.parts.map((part) =>
                    part.kind === 'approval' && part.id === approvalId ? { ...part, decision } : part,
                  ),
                }
              : message,
          ),
        },
      }));
    },

    answerEngineerInput(engineerId, inputId, action, answers) {
      if (!get().sendFrame({
        type: 'devteam-engineer-input',
        engineerId,
        inputId,
        action,
        ...(action === 'submit' && answers ? { answers } : {}),
      })) return false;
      set((state) => ({
        devTeamLanes: {
          ...state.devTeamLanes,
          [engineerId]: (state.devTeamLanes[engineerId] ?? []).map((message) =>
            message.parts.some((part) => part.kind === 'input' && part.id === inputId && part.resolution === null)
              ? {
                  ...message,
                  parts: message.parts.map((part) =>
                    part.kind === 'input' && part.id === inputId ? { ...part, resolution: action } : part,
                  ),
                }
              : message,
          ),
        },
      }));
      return true;
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

    setDraft(key, draft) {
      set((state) => ({
        // An empty draft is dropped rather than stored, so `composerDrafts`
        // holds only real ones and an untouched composer costs nothing.
        composerDrafts:
          draft.text === '' && draft.attachments.length === 0
            ? Object.fromEntries(Object.entries(state.composerDrafts).filter(([held]) => held !== key))
            : { ...state.composerDrafts, [key]: draft },
      }));
    },

    clearDrafts(keys) {
      const held = get().composerDrafts;
      const going = Object.entries(held).filter(([key]) => keys === undefined || keys.includes(key));
      if (going.length === 0) return;
      for (const [, draft] of going) releaseAttachments(draft.attachments);
      set({
        composerDrafts: Object.fromEntries(
          Object.entries(held).filter(([key]) => !going.some(([gone]) => gone === key)),
        ),
      });
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
        }));
      }
      // A read that did not land teaches this folder nothing: `gameKnown` is
      // left where it was, so a dropped request cannot unlearn an answer that
      // did arrive, and it cannot mint one either.
      if (!status) return;
      const previous = get().game;
      // Set before the early return below: a status that says exactly what the
      // last one said is still somebody having looked, and that is the whole of
      // what this field claims.
      if (!get().gameKnown) set({ gameKnown: true });
      const changed =
        status.present !== previous.present || status.entry !== previous.entry || status.mtime !== previous.mtime;
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
      // Same rule as refreshProviders above: null here is "the read did not
      // land", not "this folder has no key", and the two must never be written
      // to the same place. `openWorkspace` has already cleared this to null for
      // the new folder, so a failed read leaves the honest pre-read value
      // standing rather than unlearning an answer that did arrive.
      if (!settings) return;
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
      if (mode !== 'chat' && get().projectPath === null) return;
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

    openTerminal() {
      const state = get();
      if (state.projectPath === null) {
        state.log('error', 'app', 'Open a project first. The terminal runs in the project folder.');
        return;
      }
      const session = getAgentSessionSummary();
      // Already live: this is a way back to it, not a second one. Nothing is
      // typed here, so there is nothing to interrupt in a session already
      // running something.
      if (session.status === 'running' || session.status === 'reconnecting') {
        enterTerminalConversation('Terminal');
        return;
      }
      if (state.wsStatus !== 'connected') {
        state.log('error', 'app', 'Terminal: the connection is down. Wait a moment and try again.');
        return;
      }
      if (
        !state.sendFrame({
          type: 'pty-start',
          sessionId: ensureAgentPtySessionId(),
        })
      ) {
        state.log('error', 'app', 'Terminal: the connection is down. Wait a moment and try again.');
        return;
      }
      markAgentStarted('shell');
      enterTerminalConversation('Terminal');
    },

    continueChatInCli() {
      const state = get();
      const chat = activeConversation();
      if (!chat || (!chat.claudeSessionId && !chat.codexThreadId)) {
        state.log('error', 'app', 'This chat has no provider session to continue yet.');
        return false;
      }
      if (chat.kind === 'devteam' && state.devTeam?.phase !== 'done') {
        state.log('error', 'app', 'Finish the dev team run before continuing its lead in the CLI.');
        return false;
      }
      if (state.chatBusy) {
        state.log('error', 'app', 'Stop the current turn before continuing this chat in its CLI.');
        return false;
      }
      if (state.projectPath === null || state.wsStatus !== 'connected') {
        state.log('error', 'app', 'The terminal needs an open project and a live connection.');
        return false;
      }
      const terminal = getAgentSessionSummary();
      if (terminal.status === 'running' || terminal.status === 'reconnecting') {
        state.log('error', 'app', 'Stop the current terminal session before continuing this chat in its CLI.');
        return false;
      }

      const requestId = crypto.randomUUID();
      pendingCliHandoff = { requestId, chatId: chat.id };
      if (!state.sendFrame({
        type: 'chat-handoff-cli',
        requestId,
        sessionId: ensureAgentPtySessionId(),
      })) {
        pendingCliHandoff = null;
        return false;
      }
      // Mark the resumable terminal as starting so a socket drop during the
      // transaction reattaches to the server-owned PTY. The conversation does
      // not navigate until the server confirms the provider is stopped and the
      // CLI has been launched.
      markAgentStarted('shell');
      return true;
    },

    setPaneTab(tab) {
      set(tab === 'console' ? { paneTab: tab, consoleUnread: 0 } : { paneTab: tab });
    },

    async playTesterIn(path) {
      // The Tester screen is global, so its Play aims at a project that is
      // usually NOT the open one. Nothing the person is looking at moves until
      // this knows there is something to play: this used to switch folders
      // first and ask afterwards, so aiming Play at a game that is not there
      // closed the project you had open, cleared its conversation, its console
      // and its chat list, and then told you there was nothing to play. The
      // one thing it could not give back was the folder it had just closed.
      const here = get().projectPath === path;
      if (!here) {
        // `gameStatus` answers 403 for a folder the server does not have open,
        // so asking it anything means asking the server to serve that folder
        // first. That is a fact about the SERVER and not a move by the window:
        // no state is set here, and if the answer below is no, the window is
        // exactly where it was.
        const served = await apiOpenWorkspace(path);
        if (!served.ok || !served.info) {
          showToast(served.error ?? 'Could not open that project.', 'error');
          return;
        }
      }
      // Asked for a game the folder does not have. Said out loud rather than by
      // a button that quietly does nothing, because from a screen listing other
      // games' playtests there is no way to tell which is which.
      //
      // Read here rather than taken from `game.present`, which is false both
      // when the folder has no game and when the last status read failed:
      // `refreshGame` returns early on a null answer and leaves the empty
      // default standing, so a dropped request became "there is no game in that
      // project", a definite claim about someone's disk made from a question
      // that was never answered. Not knowing is its own sentence.
      const status = await apiGameStatus(path);
      /**
       * Hand the folder back if this is not going to play it.
       *
       * Asking the status question required asking the server to serve the
       * folder, and a question that was answered "no" should not leave the
       * server authorized to serve someone's project for the rest of the
       * session. The set of open roots is the jail every file route and every
       * socket upgrade is checked against, and today it grew on a press that
       * did nothing. Only when this call is what opened it: a folder that was
       * already open stays open, because it was not this that opened it.
       */
      const giveBack = async (): Promise<void> => {
        if (!here && get().projectPath !== path) await apiCloseWorkspace(path);
      };
      if (!status) {
        await giveBack();
        showToast('Could not check whether that project has a game, so it was not played.', 'error');
        return;
      }
      if (!status.present) {
        await giveBack();
        showToast('There is no game in that project yet, so there is nothing for it to play.', 'error');
        return;
      }
      // Now it is worth the move. A playtest needs the folder's game, its probe
      // and its socket, all of which come from an open workspace, and the
      // person watching needs to be in the game they asked to have played.
      if (!here) {
        const opened = await get().openWorkspace(path);
        if (!opened.ok) {
          await giveBack();
          showToast(opened.error ?? 'Could not open that project.', 'error');
          return;
        }
      }
      await get().playTester();
    },

    async playTester() {
      const project = get().projectPath;
      if (!project || get().tester.running || get().tester.starting) return;
      // The pane comes forward and lands on the tester before the request goes
      // out. A tester playing somewhere the person who asked for it cannot see
      // is indistinguishable from nothing happening.
      set((state) => ({
        paneTab: 'tester',
        paneOpen: true,
        paneChoice: true,
        // Play can be pressed from the history screen, which is a place the app
        // has gone to. Leave it: watching is the point, and a session playing
        // behind a page of past sessions is the failure this feature exists to
        // avoid.
        screen: null,
        composing: false,
        projectView: false,
        // Narrow layouts put the pane on a tab of its own, so opening the
        // column is not the same as being able to see it.
        narrowTab: 'pane',
        tester: {
          ...state.tester,
          starting: true,
          error: null,
          thoughts: [],
          lastNote: null,
        },
      }));
      const result = await apiTesterPlay(project);
      if (get().projectPath !== project) return;
      if (!result.ok) {
        set((state) => ({
          tester: {
            ...state.tester,
            starting: false,
            error: result.error ?? 'The tester could not start.',
          },
        }));
        return;
      }
      // `running` is left to the tester-started frame: the socket is what knows
      // the session is really under way, and setting it here would leave a
      // window claiming a session that died on the way up.
      set((state) => ({
        tester: {
          ...state.tester,
          session: result.session ?? null,
          maxSteps: result.maxSteps ?? state.tester.maxSteps,
        },
      }));
    },

    async stopTester() {
      const project = get().projectPath;
      if (!project) return;
      await apiTesterStop(project);
    },

    async refreshTesterRuns() {
      const runs = await apiTesterHistoryAll();
      // A failed read keeps whatever was on screen. The alternative is a list
      // of real playtests replaced by "nothing yet", which is a lie the screen
      // has no way to take back.
      if (runs) set({ testerRuns: runs });
    },

    async refreshTesterHistory() {
      const project = get().projectPath;
      if (!project) return;
      const history = await apiTesterHistory(project);
      if (!history || get().projectPath !== project) return;
      set((state) => ({
        tester: {
          ...state.tester,
          sessions: history.sessions,
          memory: history.memory,
          historyLoaded: true,
          maxSteps: state.tester.maxSteps || history.maxSteps,
          // A session outlives the window watching it: the server keeps playing
          // through a reload or a dropped socket. Without this the window comes
          // back believing nothing is running and offers to start a second one.
          running: state.tester.running || history.running,
          session: state.tester.session ?? history.sessions[history.sessions.length - 1]?.session ?? null,
          // A window that has just opened has watched nothing, but the folder
          // remembers. Without this the surface says "nothing said yet" beside a
          // history full of sessions.
          lastNote: state.tester.lastNote ?? history.sessions[history.sessions.length - 1] ?? null,
        },
      }));
    },

    async approveProposals(session, proposals, options = {}) {
      // The report's own folder, which is not always the open one: the Tester
      // screen lists every game's sessions, and a project can be closed while
      // standing on it. Read from the surface rather than assumed, because the
      // session number means nothing without the folder it was played in —
      // asking about session 3 of the folder that happens to be open is at
      // best an error and at worst another game's session turned into work.
      const project = options.project ?? get().projectPath;
      const waitMs = options.waitMs ?? CONNECT_WAIT_MS;
      // Nothing ticked is not a failure worth a message. The control that got
      // here is disabled, so this is the belt on top of the braces.
      if (!project || proposals.length === 0) return { ok: false };

      const fail = (error: string): { ok: false; error: string } => {
        get().log('error', 'app', error);
        showToast(error, 'error');
        return { ok: false, error };
      };

      // Everything below needs that folder open: the note is read from it, the
      // conversation is created in it, and the person has to end up watching
      // the work in the game it is about. `playTesterIn` moves for the same
      // reason when Play is aimed at another game from the same screen.
      if (get().projectPath !== project) {
        const opened = await get().openWorkspace(project);
        if (!opened.ok) return fail(opened.error ?? 'Could not open the project that report belongs to.');
      }

      // The words are written by the server from the note on disk. The window
      // sends ids and nothing else, so an unticked proposal has no route into
      // the message at all.
      const seed = await apiTesterApprove(project, session, [...proposals]);
      if (!seed.ok || !seed.text) return fail(seed.error ?? 'Could not put that plan into words.');
      if (get().projectPath !== project) return { ok: false };

      const words = seed.text;
      // Leave the tester's screen. Approving starts work, and watching it start
      // somewhere the person cannot see is the same as nothing happening. The
      // narrow layout's tab is part of that: `playTester` moved it to the game
      // to watch the session, and the conversation this is about to open is on
      // the other one.
      set({
        composing: false,
        projectView: false,
        screen: null,
        narrowTab: 'chat',
        chatBusy: false,
        chatError: null,
        queued: [],
      });
      applyConversationMode('chat');

      const before = get().activeChatId;
      requestChat({ type: 'chat-new' });
      // Waiting for a DIFFERENT conversation, not merely for one: the folder
      // already had one open, so "a conversation exists" was true before this
      // began and would let the send land in the wrong place.
      const landed = await waitForChatSurface(before, waitMs);
      if (!landed) {
        // Held in the composer rather than sent anywhere. The one place this
        // must never put approved work is the conversation being left.
        set({ pendingPrompt: words });
        return fail('No new chat opened, so nothing was sent. Your message is waiting in the composer.');
      }
      // The conversation opening is not the message arriving. The socket can go
      // between the two frames, and `sendChat` then gives up with a toast — so
      // this used to report success, close the report over it, and leave a
      // brand-new empty conversation as the only trace of approved work.
      if (!get().sendChat(words)) {
        set({ pendingPrompt: words });
        return fail('The message could not be sent, so no work has started. It is waiting in the composer.');
      }
      return { ok: true };
    },

    setGameMuted(muted) {
      set({ gameMuted: muted });
      writeGameMuted(muted);
      // The window is what gets muted, not the frame: the game is served from
      // a second loopback port so it is cross-origin on purpose, and a game
      // making its noise through WebAudio has no media element to reach even
      // when it is not. Chromium mutes a whole webContents whatever the sound
      // is made of. Fire and forget: nothing downstream waits on it, and a
      // build whose preload predates it simply has no mute to offer.
      void hearthNative()?.setAudioMuted?.(muted);
    },

    setPaneOpen(open) {
      const project = get().projectPath;
      if (project) writePaneOpen(project, open);
      // Asking for the column is asking to see it, so this has to go where it
      // is rendered. The project screen and the blank composer are rendered
      // INSTEAD of the working area (App.tsx), so the flag alone changed
      // nothing there: the top bar offers the toggle on the project screen —
      // `globalPlace` answers null there — and pressing it did nothing at all.
      // `playTester` already leaves the project screen for exactly this
      // reason, and this is the same act by a different control.
      //
      // The narrow layout is the other half of the same point: below the
      // breakpoint the conversation and the column are two tabs of one region,
      // so opening the column without moving the tab answers "show playtest"
      // by carrying on showing the conversation.
      //
      // Closing does the reverse for the tab, or the window is left on a tab
      // that no longer exists. Closing is NOT a navigation: it leaves you in
      // the conversation you were in rather than posting you back to a screen
      // you did not ask for.
      set(
        open
          ? {
              paneOpen: true,
              paneChoice: true,
              projectView: false,
              composing: false,
              narrowTab: 'pane',
            }
          : { paneOpen: false, paneChoice: false, narrowTab: 'chat' },
      );
    },

    setNarrowTab(tab) {
      set({ narrowTab: tab });
    },

    openCodePeek(path) {
      set((state) => ({
        codePeek: { open: true, path: path ?? state.codePeek.path },
      }));
    },

    closeCodePeek() {
      set((state) => ({
        codePeek: { open: false, path: state.codePeek.path },
      }));
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
