/**
 * Client-side shapes for data crossing the /api and WebSocket boundaries.
 */
import type { CommandResult, JournalEntry } from '@hearth/core';

export type { CommandResult, JournalEntry };

export type { ChatRecord, ChatSummary } from '../server/chatStore';
export type { StoredAttachment } from '../server/chatAttachments';
export type { SlashCommandInfo } from '../server/chat';
// Imported as well as re-exported, for the same reason ProjectIdentity is.
import type { ChatKind } from '../server/chatStore';
export type { ChatKind };
export type {
  DevTeamPhase,
  DevTeamPlan,
  DevTeamSnapshot,
  DevTeamState,
  DevTeamTaskRecord,
} from '../server/devTeamStore';
// Imported as well as re-exported: this file uses it below, and a bare
// `export type … from` does not bring the name into local scope.
import type { ProjectIdentity } from '../server/projectIdentity';
export type { ProjectIdentity };

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/** A folder the app has open. Not necessarily a Hearth project — usually just
 * the folder the agent is building a game in. */
export interface WorkspaceInfo {
  path: string;
  name: string;
  isHearthProject: boolean;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  exists: boolean;
  /**
   * What the project chose to look like, if anything. Absent fields are
   * derived from the path by the renderer — see src/projects/identity.ts, and
   * note the resolution is per-field, not all-or-nothing.
   */
  identity?: ProjectIdentity;
}

export interface ServerMeta {
  hearthVersion: string;
  runtimeAvailable: boolean;
  /**
   * Absolute loopback origin the game mount is served from, e.g.
   * `http://127.0.0.1:52341`. The port is picked at startup, so the client is
   * told rather than assuming. Null means the mount server did not come up:
   * the pane says it has nowhere to serve the game from and shows nothing,
   * which is the only safe answer. See server/gameServer.ts.
   *
   * `home`, `repoRoot`, and `toolPaths` used to be here too. They were never
   * read by anything, and an unauthenticated caller being handed the user's
   * home directory is what made the /api/ws hole point-and-shoot.
   */
  gameOrigin: string | null;
}

// ---------------------------------------------------------------------------
// Game pane
// ---------------------------------------------------------------------------

/** GET /api/game/status — is there a game to show, and how fresh is it? */
export interface GameStatus {
  present: boolean;
  /** Folder-relative entry document, e.g. `index.html`. Null when absent. */
  entry: string | null;
  /** Newest mtime under the entry's folder; a change is the reload cue. */
  mtime: number;
}

/** GET /api/probe/status — what Hearth can currently sense about the game. */
export type Sense = 'preview' | 'errors' | 'screenshots' | 'entities' | 'events' | 'scenes';

/** GET /api/probe/status — the full read-out of what Hearth can sense. */
export interface ProbeStatus {
  senses: Sense[];
  /** The last probe read found a shim, so the deeper senses are real. */
  shimDetected: boolean;
}

/**
 * One file in a project's context folder (`.hearth/context/`). `lines` is the
 * line count for text and null for anything else — a card must not claim a
 * line count for a PNG.
 */
export interface ContextFile {
  name: string;
  bytes: number;
  lines: number | null;
  ext: string;
  modifiedAt: string;
}

/** One file in the folder, for the code peek. */
export interface ProjectFile {
  path: string;
  size: number;
}

/** GET /api/app/settings — whether an agent key is configured, and from where. */
export interface AppSettingsInfo {
  hasKey: boolean;
  source: 'project' | 'environment' | null;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/**
 * Which backend answered. `agent-sdk` is the Claude Code CLI, `codex` is the
 * codex binary. Any other agent runs in the terminal, where it is the user's
 * own process and Hearth is not the one answering.
 *
 * `custom` was a fourth kind, for agents registered against a small stdio
 * protocol. Transcripts written by those builds still carry it, so a reader
 * that pattern-matches on this union must tolerate an unknown value rather
 * than assume these three are all that can appear on disk.
 */
export type ChatDriverKind = 'stub' | 'agent-sdk' | 'codex';

/** Which vendor's agent answers a turn. */
export type ChatProvider = 'anthropic' | 'openai';

export type ToolKind = 'command' | 'file-change' | 'mcp' | 'web-search' | 'skill' | 'other';
export type ToolStatus = 'ok' | 'error' | 'declined';
export type ApprovalKind = 'command' | 'file-change';
export type ApprovalDecision = 'allow' | 'deny';
export interface ApprovalChoice {
  id: string;
  label: string;
  tone: 'allow' | 'deny' | 'neutral';
}
export type InputAction = 'submit' | 'cancel';
export type InputResolution = InputAction | 'withdrawn';
export type InputAnswer = string | number | boolean | string[];

export interface InputOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * One typed field in a provider-neutral question. A request may carry several
 * of these, which is the "form" case; a one-question request uses the exact
 * same renderer and wire shape.
 */
export interface InputQuestion {
  id: string;
  label: string;
  type: 'choice' | 'text' | 'number' | 'boolean' | 'url';
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  multiple?: boolean;
  /** Offer a free-form answer alongside declared choices. */
  allowOther?: boolean;
  options?: InputOption[];
  min?: number;
  max?: number;
}

export interface InputExternalAction {
  type: 'open-url';
  url: string;
  elicitationId: string;
}

/**
 * How an approval can END UP, which is wider than how a person can answer
 * one: `withdrawn` means the session ended (a Stop, a teardown, the backend
 * dying) before anyone answered — a teardown speaking, never a Deny the user
 * pressed. Old transcripts hold only allow/deny and render exactly as they
 * always did. Mirrors server/chat.ts's ApprovalResolution.
 */
export type ApprovalResolution = ApprovalDecision | 'withdrawn';

/**
 * When the agent stops to ask before it acts, for one project.
 *
 *   ask   every command and every file change raises an approval. Not every
 *         act: an approval is a `command` or a `file-change` (ApprovalKind),
 *         so a read or a search has no kind it could be raised as and is not
 *         interrupted. The composer's wording says so rather than promising
 *         a completeness the union cannot deliver.
 *   auto  work inside the project folder goes ahead; anything outside asks.
 *   skip  nothing asks.
 *
 * Named for what happens rather than for the backends' own vocabulary (the
 * Agent SDK calls the last one `bypassPermissions`), because this is a word
 * the user reads in the composer, not a token on the wire.
 */
export type PermissionMode = 'ask' | 'auto' | 'skip';

/**
 * GET/POST /api/permission-mode: the project's answer, plus whether it has
 * already been told what `skip` means. The acknowledgement is stored with the
 * mode so that warning is a one-time conversation per project rather than a
 * toll on every turn.
 */
export interface PermissionModeInfo {
  mode: PermissionMode;
  skipAcknowledged: boolean;
}

export type FileChangeKind = 'edit' | 'create' | 'delete';

/** One file an agent touched, with the patch when the driver reports one. */
export interface FileChangeEntry {
  path: string;
  kind: FileChangeKind;
  diff?: string;
}

/**
 * One thing the driver did. Mirrors server/chat.ts's ChatEvent, and is the
 * whole vocabulary the transcript can render — every driver (Agent SDK, Codex,
 * the stub) is translated into THIS on the server, so the UI never learns
 * which agent it is talking to.
 *
 * The trailing v0 members are what earlier builds wrote into
 * `.hearth/chats/*.jsonl`. They stay in the union so an old transcript still
 * replays; `normalizeChatEvent` (store.ts) upgrades them on the way in, and
 * nothing downstream of it has to know they existed.
 */
export type ChatEvent =
  | { type: 'message-delta'; text: string }
  /** One piece of prose ended. No text: it only marks where the next begins. */
  | { type: 'message-end' }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-begin'; toolId: string; kind: ToolKind; title: string; detail?: string }
  | { type: 'tool-output-delta'; toolId: string; chunk: string }
  | { type: 'tool-end'; toolId: string; status: ToolStatus; exitCode?: number; summary?: string }
  | { type: 'file-change'; toolId?: string; files: FileChangeEntry[] }
  | {
      type: 'approval-request';
      approvalId: string;
      kind: ApprovalKind;
      title: string;
      detail: string;
      choices?: ApprovalChoice[];
    }
  | { type: 'approval-resolved'; approvalId: string; decision: ApprovalResolution }
  | {
      type: 'input-request';
      inputId: string;
      title?: string;
      description?: string;
      questions: InputQuestion[];
      allowCancel?: boolean;
      /** Provider-side auto-resolution window, when there is one. */
      timeoutMs?: number;
      externalAction?: InputExternalAction;
    }
  /**
   * Deliberately carries no answers. Values are transient transport data and
   * must not become transcript history — especially secrets.
   */
  | { type: 'input-resolved'; inputId: string; action: InputResolution }
  | { type: 'subagent-start'; agentId: string; role?: string; title: string }
  | { type: 'subagent-delta'; agentId: string; chunk: string }
  | { type: 'subagent-end'; agentId: string; status: ToolStatus; summary?: string }
  | { type: 'plan-update'; planId: string; text: string }
  | { type: 'image'; toolId: string; path: string; caption?: string }
  | { type: 'notice'; text: string }
  | { type: 'turn-complete' }
  | { type: 'error'; message: string }
  // --- legacy v0 members, kept so old persisted transcripts still replay ---
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; id: string; name: string; detail?: string }
  | { type: 'tool-end'; id: string; ok: boolean; detail?: string }
  | { type: 'done' };

/**
 * How far along one piece of tool activity is. One glyph each.
 *
 * `stopped` is the turn ending before this row did: the turn failed mid
 * command, someone pressed Stop, or the driver died. It is a fourth state
 * rather than either of the settled two because nothing knows a row that never
 * reported succeeded, and an interrupted command did not necessarily fail. The
 * only true thing left to say is that it never finished. Without it these rows
 * kept `running` for the life of the transcript, on disk, and a conversation
 * that ended days ago went on showing a spinner.
 */
export type ToolState = 'running' | 'ok' | 'error' | 'stopped';

export interface ChatTextPart {
  kind: 'text';
  text: string;
}

/** The agent thinking out loud. Collapsed by default — it is not the answer. */
export interface ChatReasoningPart {
  kind: 'reasoning';
  text: string;
  /**
   * When the first token of this thought arrived, in `Date.now()` terms. Same
   * arrangement as a command's: no driver reports a duration, so the only way
   * to say how long a model thought is to watch its deltas arrive.
   */
  startedAt?: number;
  /**
   * How long the thinking ran — first delta to last. Undefined on a replayed
   * transcript, where every delta lands in the same millisecond and the honest
   * answer is to say nothing (see DURATION_FLOOR_MS in chat/duration.ts).
   */
  durationMs?: number;
}

/** Any tool that isn't a shell command: reads, searches, MCP calls. */
export interface ChatToolPart {
  kind: 'tool';
  id: string;
  name: string;
  detail?: string;
  state: ToolState;
}

/**
 * A shell command. Carries its own captured output because a command is the
 * one tool whose result a reader routinely needs to see in full.
 */
export interface ChatCommandPart {
  kind: 'command';
  id: string;
  title: string;
  detail?: string;
  output: string;
  state: ToolState;
  exitCode?: number;
  durationMs?: number;
  /**
   * When the row opened, in `Date.now()` terms — the only way to know how long
   * a command took, since no driver reports it. A replayed transcript folds in
   * milliseconds, so the duration it computes is ~0 and is simply not shown
   * (see DURATION_FLOOR_MS in chat/duration.ts): no duration beats a wrong one.
   */
  startedAt?: number;
}

/**
 * A skill the agent reached for.
 *
 * Its own row rather than a tool chip because a skill is the one piece of the
 * agent's equipment the user chose: they installed it, they switched it on,
 * and until now the only sign it had ever been read was a line in the
 * transcript indistinguishable from a file read.
 */
export interface ChatSkillPart {
  kind: 'skill';
  id: string;
  /** What the skill is called: the SDK's own name for it, or the folder name. */
  name: string;
  /** What it was asked to do, when the driver reports it. */
  detail?: string;
  state: ToolState;
}

/**
 * What the agent says it is going to do, replaced whole whenever it changes.
 * One card per plan rather than one per revision — a transcript with five
 * stale copies of the same list in it is a transcript nobody reads.
 */
export interface ChatPlanPart {
  kind: 'plan';
  id: string;
  text: string;
}

/** An image the agent made, or looked at. */
export interface ChatImagePart {
  kind: 'image';
  id: string;
  /** Absolute or project-relative path; the renderer resolves it. */
  path: string;
  caption?: string;
}

/** One quiet line explaining something that happened to the conversation. */
export interface ChatNoticePart {
  kind: 'notice';
  text: string;
  /**
   * An error tone means the turn did not finish, and the line is the app
   * speaking rather than the agent. Without it a rate limit or an expired
   * login rendered in the agent's own voice, indistinguishable from something
   * it had decided to tell you.
   */
  tone?: 'info' | 'error';
  /** The prompt to put back, so a turn lost to a transient failure is one press to retry. */
  retryText?: string;
}

export interface ChatFileChangePart {
  kind: 'file-change';
  id: string;
  files: FileChangeEntry[];
}

/** A delegated agent, running inside this turn. */
export interface ChatSubagentPart {
  kind: 'subagent';
  id: string;
  role?: string;
  title: string;
  text: string;
  state: ToolState;
  summary?: string;
}

/**
 * A blocking ask. Stays in the transcript after it is answered — what you let
 * an agent do is part of the record of what happened.
 */
export interface ChatApprovalPart {
  kind: 'approval';
  id: string;
  approvalKind: ApprovalKind;
  title: string;
  detail: string;
  choices?: ApprovalChoice[];
  /** Null while the ask is live; `withdrawn` when the session ended under it. */
  decision: ApprovalResolution | null;
}

/**
 * A provider question, inline where the turn stopped. `resolution` is the only
 * answer history Hearth keeps; values live in InputPrompt only until sent.
 */
export interface ChatInputPart {
  kind: 'input';
  id: string;
  title?: string;
  description?: string;
  questions: InputQuestion[];
  allowCancel: boolean;
  timeoutMs?: number;
  externalAction?: InputExternalAction;
  resolution: InputResolution | null;
}

/**
 * A turn is an ordered list of parts, not a text blob plus a tool list: what
 * the agent said between two tool calls belongs between them on screen.
 */
export type ChatPart =
  | ChatTextPart
  | ChatReasoningPart
  | ChatToolPart
  | ChatCommandPart
  | ChatSkillPart
  | ChatFileChangePart
  | ChatSubagentPart
  | ChatApprovalPart
  | ChatInputPart
  | ChatPlanPart
  | ChatImagePart
  | ChatNoticePart;

/**
 * A file the user sent with a turn, as the transcript shows it back.
 *
 * `url` is where the picture actually comes from, and it has two lives: a
 * blob/data URL for the message that was just sent (the bytes are already in
 * the browser, and waiting for a round trip would make the send feel slow),
 * and an `/api/file` URL once the turn is replayed from disk. The renderer
 * never needs to know which it is looking at.
 */
export interface ChatAttachmentView {
  name: string;
  mimeType: string;
  url: string;
  /** Absent for a locally-previewed attachment that has not been saved yet. */
  relPath?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  parts: ChatPart[];
  /** Still receiving events (drives the working indicator). Agent turns only. */
  streaming: boolean;
  /**
   * When the turn opened, in `Date.now()` terms — what the working indicator
   * counts from. Agent turns only, and absent on a replayed one, where the
   * elapsed time would be a measure of how fast the file was read.
   */
  startedAt?: number;
  /** What was attached to this turn. User turns only. */
  attachments?: ChatAttachmentView[];
  /** Hearth authored this lead prompt for a dev-team run, not the person. */
  orchestration?: boolean;
}

/**
 * GET /api/chat/providers — what could answer a turn in this folder, and what
 * would. Two vendors, asked in the terms each one actually uses: Anthropic is
 * a key, OpenAI is a CLI you install and sign into. Reported rather than
 * inferred, so the Settings dialog can say why nothing is answering.
 */
export interface ChatProviderStatus {
  anthropic: {
    hasKey: boolean;
    source: 'project' | 'environment' | null;
    /**
     * The Claude Code CLI is on this machine. On its own that is enough to
     * answer a turn: the SDK runs that CLI and it authenticates with whatever
     * the person signed into, so a key is one route in rather than the route.
     */
    cli: boolean;
    /**
     * The CLI has an account. THIS is the one that decides whether Claude can
     * answer; `cli` above only says the binary exists, and a machine with
     * claude installed and nobody signed into it used to report itself ready
     * and then fail the turn.
     */
    loggedIn: boolean;
    /** The signed-in account, when the CLI says. */
    email: string | null;
    /** The plan word, verbatim from the CLI (`max`, `pro`, ...). */
    planType: string | null;
    /** Models this provider can answer with, curated by the server. */
    models?: ProviderModelInfo[];
  };
  openai: {
    /** The `codex` binary was found on PATH (or at a configured path). */
    installed: boolean;
    version: string | null;
    loggedIn: boolean;
    authMode: 'chatgpt' | 'apikey' | null;
    email: string | null;
    planType: string | null;
    /** An OpenAI API key is stored for this folder. */
    hasKey: boolean;
    /** Models this provider can answer with, curated by the server. */
    models?: ProviderModelInfo[];
  };
  /** Which provider a turn would use right now, or null when none can answer. */
  active: ChatProvider | null;
}

/**
 * One reasoning effort a model accepts, named by its own backend. There is no
 * display name because codex ships none — the words are ours to choose, and
 * `effortDisplayName` in chat/modelChoice is where that happens.
 */
export interface EffortOption {
  id: string;
  /** The backend's own one-liner, e.g. "Balances speed and reasoning depth". */
  description?: string;
}

/**
 * One model a provider offers, in the words the selector shows.
 *
 * The optional half is the backend's own catalogue and is only as full as that
 * backend says. Codex answers all of it from `model/list` — including which
 * efforts THIS model accepts, which differs per model. Anthropic has no such
 * call, so its rows carry a curated note and nothing else. Absent means "not
 * offered", which the picker renders as no control rather than a guess.
 */
export interface ProviderModelInfo {
  /** Wire id (e.g. `claude-opus-5`). Empty string means the provider default. */
  id: string;
  /**
   * The canonical model this row's `id` resolves to, when the backend says.
   * Claude's catalogue is aliases (`sonnet`, `opus[1m]`), so this is how a
   * choice stored as `claude-sonnet-5` finds the row that covers it. See
   * `modelRowCovers`.
   */
  resolvedModel?: string;
  label: string;
  note?: string;
  description?: string;
  /** The model this provider picks when the turn names none. */
  isDefault?: boolean;
  efforts?: EffortOption[];
  defaultEffort?: string;
}

/**
 * The user's standing choice of who answers and how hard it thinks. `model`
 * null means the provider's default; `effort` only applies where the provider
 * supports it (Codex).
 *
 * `effort` is a plain string rather than a union because the vocabulary is the
 * model's, not ours: one real `model/list` offers `low medium high xhigh max
 * ultra`, and the accepted set differs from model to model. The picker only
 * ever offers what a model declared, and `agentForTurn` drops one a model has
 * since stopped accepting.
 */
export interface AgentChoice {
  provider: ChatProvider;
  model: string | null;
  effort: string | null;
}

/**
 * One agent CLI the picker can offer for terminal mode, as the server found it
 * (see server/agentClis.ts).
 *
 * `installed` is measured against the user's login-shell PATH, never assumed:
 * an entry that reads false is shown as unavailable rather than offered, and
 * `installHint` is the only thing Hearth claims to know about how to fix that.
 * There is deliberately nothing here about models or capabilities — Hearth
 * types the command into a shell and knows no more than that.
 */
export interface AgentCliInfo {
  id: string;
  /** The word typed into the shell. */
  command: string;
  label: string;
  installed: boolean;
  /** A published install command, or null when Hearth does not know one. */
  installHint: string | null;
}

/**
 * Which models the user has switched off (server/modelPrefs.ts). Keys are
 * `provider:modelId`. Disabled rather than enabled is stored on purpose: a
 * model nobody has seen yet has to default to available.
 */
export interface ModelPrefsInfo {
  disabled: string[];
  /** Where the list is written, so the pane can say. */
  file: string;
}

/**
 * One conversation anywhere on this machine — the global Recents list. The
 * folder rides along because opening the chat means opening its folder first.
 */
export interface RecentChatEntry {
  id: string;
  title: string;
  /**
   * Chat or terminal session, so a row can say which it is without being
   * opened. Optional on the wire on purpose: this list also gets folded
   * together with a folder's own chats (see mergeRecentChats), and a missing
   * answer reads as 'chat' — the same default the index itself applies to
   * records written before kinds existed.
   */
  kind?: ChatKind;
  updatedAt: string;
  project: { path: string; name: string };
}

/** hearth:update-ready — an update is downloaded and installs on relaunch. */
export interface UpdateReadyInfo {
  version: string;
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

export type ConsoleLevel = 'info' | 'warn' | 'error';
export type ConsoleSource = 'agent' | 'game' | 'app';

export interface ConsoleEntry {
  id: number;
  time: string; // HH:MM:SS
  level: ConsoleLevel;
  source: ConsoleSource;
  message: string;
  /** Present when the entry names a file; clicking opens it in the code peek. */
  link?: { path: string; line: number | null };
}

/**
 * One playtest, and which game it was a playtest OF.
 *
 * A run only makes sense next to its game, so the pairing travels together
 * rather than being reassembled by the screen from a path. The identity rides
 * along for the same reason the rail's projects carry theirs: the list paints
 * a mark per row on first render, and fetching them separately would be one
 * flash of the wrong colour per game.
 */
export interface TesterRun {
  note: import('../server/tester/types').TesterNote;
  project: { path: string; name: string; identity?: ProjectIdentity };
}

/** Every recent playtest across every game, newest first, and what was cut. */
export interface TesterRunHistory {
  runs: TesterRun[];
  /** How many runs the cap left out. Zero means the list is everything. */
  dropped: number;
  /**
   * How many GAMES were not looked in at all: past the project cap, or a
   * folder that is no longer there.
   *
   * Separate from `dropped` because they are different admissions. `dropped`
   * says "there is more of this game's history than fits"; this says "there
   * are games here I did not open". A screen that says "every time your tester
   * has played, across every game" has to be able to take that back.
   */
  skippedProjects: number;
}
