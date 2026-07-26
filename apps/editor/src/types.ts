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

export type ChatDriverKind = 'stub' | 'agent-sdk';

/** One thing the driver did. Mirrors server/chat.ts's ChatEvent. */
export type ChatEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; id: string; name: string; detail?: string }
  | { type: 'tool-end'; id: string; ok: boolean; detail?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type ToolState = 'running' | 'ok' | 'error';

export interface ChatToolPart {
  kind: 'tool';
  id: string;
  name: string;
  detail?: string;
  state: ToolState;
}

export interface ChatTextPart {
  kind: 'text';
  text: string;
}

/**
 * A turn is an ordered list of parts, not a text blob plus a tool list: what
 * the agent said between two tool calls belongs between them on screen.
 */
export type ChatPart = ChatTextPart | ChatToolPart;

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  parts: ChatPart[];
  /** Still receiving events (drives the working indicator). Agent turns only. */
  streaming: boolean;
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
