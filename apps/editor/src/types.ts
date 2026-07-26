/**
 * Client-side shapes for data crossing the /api and WebSocket boundaries.
 */
import type { CommandResult, JournalEntry } from '@hearth/core';

export type { CommandResult, JournalEntry };

/**
 * The evidence schema is the probe's, not a mirror of it. This is a TYPE-only
 * import: `@hearth/probe-core` is a Node package (it writes files), and the
 * import is erased at build time, so nothing from it reaches the browser
 * bundle. Verified by tests/probeTypes.test.ts.
 */
export type { EvidenceEvent } from '@hearth/probe-core';
export type { ChatRecord, ChatSummary } from '../server/chatStore';

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
}

export interface ServerMeta {
  repoRoot: string;
  home: string;
  hearthVersion: string;
  runtimeAvailable: boolean;
  /** Where the agent tools live (bundled single files in the desktop app). */
  toolPaths?: { cli: string; mcp: string; bundled: boolean };
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

/** GET /api/probe/status — the full read-out, including whether one is running. */
export interface ProbeStatus {
  senses: Sense[];
  /** A sweep is running for this folder right now. */
  playing: boolean;
  /** The last sweep found a probe shim, so the deeper senses are real. */
  shimDetected: boolean;
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

export type ChatDriverKind = 'stub' | 'agent-sdk' | 'codex';

/** Which vendor's agent answers a turn. */
export type ChatProvider = 'anthropic' | 'openai';

export type ToolKind = 'command' | 'file-change' | 'mcp' | 'web-search' | 'other';
export type ToolStatus = 'ok' | 'error' | 'declined';
export type ApprovalKind = 'command' | 'file-change';
export type ApprovalDecision = 'allow' | 'deny';
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
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-begin'; toolId: string; kind: ToolKind; title: string; detail?: string }
  | { type: 'tool-output-delta'; toolId: string; chunk: string }
  | { type: 'tool-end'; toolId: string; status: ToolStatus; exitCode?: number; summary?: string }
  | { type: 'file-change'; toolId?: string; files: FileChangeEntry[] }
  | { type: 'approval-request'; approvalId: string; kind: ApprovalKind; title: string; detail: string }
  | { type: 'approval-resolved'; approvalId: string; decision: ApprovalDecision }
  | { type: 'subagent-start'; agentId: string; role?: string; title: string }
  | { type: 'subagent-delta'; agentId: string; chunk: string }
  | { type: 'subagent-end'; agentId: string; status: ToolStatus; summary?: string }
  | { type: 'turn-complete' }
  | { type: 'error'; message: string }
  // --- legacy v0 members, kept so old persisted transcripts still replay ---
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; id: string; name: string; detail?: string }
  | { type: 'tool-end'; id: string; ok: boolean; detail?: string }
  | { type: 'done' };

/** How far along one piece of tool activity is. Three states, one glyph each. */
export type ToolState = 'running' | 'ok' | 'error';

export interface ChatTextPart {
  kind: 'text';
  text: string;
}

/** The agent thinking out loud. Collapsed by default — it is not the answer. */
export interface ChatReasoningPart {
  kind: 'reasoning';
  text: string;
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
   * (see DURATION_FLOOR_MS in CommandRow.tsx): no duration beats a wrong one.
   */
  startedAt?: number;
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
  decision: ApprovalDecision | null;
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
  | ChatFileChangePart
  | ChatSubagentPart
  | ChatApprovalPart;

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  parts: ChatPart[];
  /** Still receiving events (drives the working indicator). Agent turns only. */
  streaming: boolean;
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

/** One model a provider offers, in the words the selector shows. */
export interface ProviderModelInfo {
  /** Wire id (e.g. `claude-opus-5`). Empty string means the provider default. */
  id: string;
  label: string;
  note?: string;
}

/**
 * The user's standing choice of who answers and how hard it thinks. `model`
 * null means the provider's default; `effort` only applies where the provider
 * supports it (Codex).
 */
export interface AgentChoice {
  provider: ChatProvider;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | null;
}

/**
 * One conversation anywhere on this machine — the global Recents list. The
 * folder rides along because opening the chat means opening its folder first.
 */
export interface RecentChatEntry {
  id: string;
  title: string;
  updatedAt: string;
  project: { path: string; name: string };
}

/** hearth:update-ready — an update is downloaded and installs on relaunch. */
export interface UpdateReadyInfo {
  version: string;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Verdict vocabulary shared with the probe. Deliberately WIDER than
 * probe-core's closed union: the rail must render a verdict a newer probe
 * invents (as a neutral chip) rather than dropping the row.
 */
export type Verdict = string;

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
