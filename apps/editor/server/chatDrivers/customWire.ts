/**
 * The Hearth Agent Protocol, version 0, and the ONLY module that knows it.
 *
 * A user's own agent is a program Hearth spawns. Hearth writes one JSON object
 * per line to its stdin; the program writes one JSON object per line back to
 * stdout. That is the whole transport: newline-delimited JSON, no framing
 * headers, no handshake round trip, no RPC ids.
 *
 *   Hearth  ->  agent      prompt | approval | interrupt | shutdown
 *   agent   ->  Hearth     ready (first line, once) then ChatEvent per line
 *
 * The event vocabulary is `ChatEvent` from chat.ts, unchanged and verbatim.
 * That is the reason this protocol is small enough to be worth implementing:
 * Hearth's transcript, its `.hearth/chats/*.jsonl` history, its replay and its
 * tester all already speak it, so an agent that emits `message-delta` and
 * `turn-complete` is a first-class conversation backend in about thirty lines
 * of wrapper.
 *
 * THREE EVENTS ARE REQUIRED and the rest are opt-in: `message-delta`,
 * `turn-complete` and `error`. The gradient is deliberate. A protocol that
 * demanded tool rows, file changes and approvals before it would render a
 * sentence is a protocol nobody writes a wrapper for.
 *
 * Rules, applied throughout and matching what the two shipped backends already
 * do:
 *
 *  - **An unknown event type is DROPPED, never fatal.** Same leniency
 *    `mapSdkMessage` and `parseRegistryFile` apply. A newer Hearth adding an
 *    event, or an agent inventing one, must not end a running conversation.
 *  - **Every field is probed, never trusted.** A shape that does not match
 *    yields nothing rather than a half-built event on somebody's transcript.
 *  - **stderr is diagnostics and never protocol**, the same treatment codex's
 *    stderr gets. An agent that logs to stderr is a normal agent.
 *  - **Hearth owns `approval-resolved`.** An agent asks with
 *    `approval-request` and Hearth answers with an `approval` frame; the
 *    resolution event is emitted by the driver so that every window watching
 *    the chat agrees, and so an agent cannot claim an answer nobody gave.
 *
 * NOTHING HERE MOLDS THE AGENT. The prompt frame carries words, attachments and
 * the model/effort the user picked, and that is all. There is no field for what
 * kind of game this is, what engine it uses, what tools the agent should have or
 * what shape its answer should take, and adding one would make Hearth's protocol
 * a statement about somebody else's agent.
 *
 * PURE on purpose: no node imports, no filesystem, no process. Everything about
 * spawning lives in custom.ts, so the whole of the wire format is unit-testable
 * against strings.
 */
import type {
  AgentTurnOptions,
  ApprovalDecision,
  ApprovalKind,
  ChatAttachment,
  ChatEvent,
  FileChangeEntry,
  FileChangeKind,
  ToolKind,
  ToolStatus,
} from '../chat.js';
import type { PermissionMode } from '../permissionMode.js';

/**
 * The version an agent must announce back. Zero, and it stays zero until the
 * frames themselves change: a protocol that bumps its version for an added
 * OPTIONAL event would make every existing wrapper look wrong overnight.
 */
export const HEARTH_PROTOCOL_VERSION = 0;

/** Environment variables Hearth adds. Named here so Settings can list them. */
export const HEARTH_PROJECT_ROOT = 'HEARTH_PROJECT_ROOT';
export const HEARTH_PERMISSION_MODE = 'HEARTH_PERMISSION_MODE';
export const HEARTH_PROTOCOL_VERSION_VAR = 'HEARTH_PROTOCOL_VERSION';

/**
 * What Hearth adds to the environment the child inherits, and nothing more.
 *
 * Three variables, all of them facts the agent needs and none of them
 * credentials. Hearth does not invent an API key for somebody else's program:
 * an agent that needs one reads it from the same environment the user's own
 * terminal has.
 */
export function agentEnvVars(projectRoot: string, mode: PermissionMode): Record<string, string> {
  return {
    [HEARTH_PROJECT_ROOT]: projectRoot,
    [HEARTH_PERMISSION_MODE]: mode,
    [HEARTH_PROTOCOL_VERSION_VAR]: String(HEARTH_PROTOCOL_VERSION),
  };
}

/** The three, in order, for the one place that has to print them. */
export const HEARTH_AGENT_ENV_VARS: readonly string[] = [
  HEARTH_PROJECT_ROOT,
  HEARTH_PERMISSION_MODE,
  HEARTH_PROTOCOL_VERSION_VAR,
];

// ---------------------------------------------------------------------------
// Frames Hearth writes
// ---------------------------------------------------------------------------

/** One attachment, as the prompt frame carries it. */
export interface PromptAttachment {
  path: string;
  name: string;
  mimeType: string;
}

export interface PromptFrame {
  type: 'prompt';
  turnId: string;
  text: string;
  attachments: PromptAttachment[];
  /**
   * The model and effort the user picked in the composer, or null when they
   * left it on automatic. Passed rather than applied: Hearth has no idea what
   * models this agent has, so these are information, and an agent that ignores
   * them is behaving correctly.
   */
  model: string | null;
  effort: string | null;
  /**
   * The permission mode, repeated here as well as in the environment. The
   * environment is read once at spawn; a mode the user changed mid-conversation
   * rebinds the driver, but repeating it per turn means an agent that only ever
   * reads the frame is still right.
   */
  permissionMode: PermissionMode;
}

export interface ApprovalFrame {
  type: 'approval';
  approvalId: string;
  decision: ApprovalDecision;
}

export interface InterruptFrame {
  type: 'interrupt';
  turnId: string;
}

export interface ShutdownFrame {
  type: 'shutdown';
}

export type HostFrame = PromptFrame | ApprovalFrame | InterruptFrame | ShutdownFrame;

/** Encode one frame as a protocol line. The trailing newline IS the frame. */
export function encodeFrame(frame: HostFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * The prompt frame for one turn.
 *
 * Attachments are handed over as PATHS, never as bytes. The agent is already
 * sitting in the folder they were written into, so a path is both cheaper and
 * more useful than a base64 blob down a pipe, and an agent that wants the bytes
 * reads the file. `relPath` is deliberately not sent: an absolute path is what a
 * program can open without knowing Hearth's layout.
 */
export function promptFrame(
  turnId: string,
  text: string,
  attachments: readonly ChatAttachment[],
  agent: AgentTurnOptions | null,
  mode: PermissionMode,
): PromptFrame {
  return {
    type: 'prompt',
    turnId,
    text,
    attachments: attachments.map((file) => ({ path: file.path, name: file.name, mimeType: file.mimeType })),
    model: agent?.model ?? null,
    effort: agent?.effort ?? null,
    permissionMode: mode,
  };
}

export function approvalFrame(approvalId: string, decision: ApprovalDecision): ApprovalFrame {
  return { type: 'approval', approvalId, decision };
}

export function interruptFrame(turnId: string): InterruptFrame {
  return { type: 'interrupt', turnId };
}

export function shutdownFrame(): ShutdownFrame {
  return { type: 'shutdown' };
}

// ---------------------------------------------------------------------------
// Lines the agent writes
// ---------------------------------------------------------------------------

/**
 * A ceiling on one line, so an agent that writes forever without a newline
 * cannot grow this process without bound. Generous: a `tool-output-delta`
 * carrying a compiler's whole error output is a normal line.
 */
export const MAX_LINE_BYTES = 1024 * 1024;

export interface DecodedLines {
  /** Parsed JSON values, in order. Lines that were not JSON are dropped. */
  values: unknown[];
  /** The partial line left over, to be prepended to the next chunk. */
  rest: string;
  /** True when a single line went past MAX_LINE_BYTES and was abandoned. */
  overflowed: boolean;
}

/**
 * Split a stdout chunk into complete lines. Callers keep `rest` and prepend it
 * to the next chunk, because stdout has no obligation to break on frame edges.
 *
 * A line that is not JSON is DROPPED rather than reported: a program that
 * prints a startup banner to stdout before it starts speaking protocol is
 * common enough that failing the conversation over it would be the wrong call,
 * and the handshake check below is what actually catches a program that is not
 * an agent at all.
 */
export function decodeLines(buffer: string, limit = MAX_LINE_BYTES): DecodedLines {
  const lines = buffer.split('\n');
  let rest = lines.pop() ?? '';
  let overflowed = false;
  if (rest.length > limit) {
    rest = '';
    overflowed = true;
  }
  const values: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.length > limit) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      /* not protocol: see above */
    }
  }
  return { values, rest, overflowed };
}

/** What the agent said about itself on its first line. */
export interface AgentHandshake {
  protocol: number;
  /**
   * The agent's CLAIM that it will raise `approval-request` and wait. Absent or
   * false means Hearth must not pretend its permission control governs this
   * agent: see `permissionNotice`.
   */
  approvals: boolean;
  /** The modes the agent says it understands. Informational, never a gate. */
  permissionModes: string[];
}

/**
 * Read the first line as a handshake, or null when it is not one.
 *
 * Strict where the rest of this file is lenient, and deliberately so. This is
 * the one line that tells Hearth it is talking to an agent rather than to
 * whatever else the user typed into the command field, and the honest failure
 * for "that program is not an agent" is a clear error rather than a
 * conversation that silently never answers.
 */
export function parseHandshake(value: unknown): AgentHandshake | null {
  const record = asRecord(value);
  if (!record || record.type !== 'ready') return null;
  const protocol = typeof record.protocol === 'number' ? record.protocol : null;
  if (protocol === null || !Number.isFinite(protocol)) return null;
  const supports = asRecord(record.supports);
  const rawModes = supports?.permissionModes;
  const modes = Array.isArray(rawModes) ? rawModes.filter((mode): mode is string => typeof mode === 'string') : [];
  return { protocol, approvals: supports?.approvals === true, permissionModes: modes };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * An id keys a map on this side (open tool rows, pending approvals, subagent
 * cards), so it is held to a length. Everything else the agent writes is prose
 * and is passed through at whatever length it came in: an agent's output is
 * not Hearth's to truncate.
 */
const MAX_ID = 200;

function id(value: unknown): string | undefined {
  const text = str(value);
  return text !== undefined && text.length <= MAX_ID ? text : undefined;
}

const TOOL_KINDS: readonly ToolKind[] = ['command', 'file-change', 'mcp', 'web-search', 'skill', 'other'];
const TOOL_STATUSES: readonly ToolStatus[] = ['ok', 'error', 'declined'];
const APPROVAL_KINDS: readonly ApprovalKind[] = ['command', 'file-change'];
const FILE_CHANGE_KINDS: readonly FileChangeKind[] = ['edit', 'create', 'delete'];

/** How many files one `file-change` may name. A ceiling, not a policy. */
const MAX_FILES = 500;

function fileEntry(value: unknown): FileChangeEntry | null {
  const record = asRecord(value);
  const file = str(record?.path);
  if (!record || file === undefined) return null;
  const kind = FILE_CHANGE_KINDS.find((known) => known === record.kind) ?? 'edit';
  const diff = str(record.diff);
  return { path: file, kind, ...(diff !== undefined ? { diff } : {}) };
}

/**
 * One line from the agent, as a canonical `ChatEvent`, or null to drop it.
 *
 * The legacy v0 members of the union (`text-delta`, `tool-start`, `done`) are
 * NOT accepted. They exist so conversations recorded before the vocabulary was
 * extended still replay; a protocol written today has no reason to speak them,
 * and accepting them here would make two spellings of the same event both
 * correct forever.
 *
 * `approval-resolved` is not accepted either. It is Hearth's answer to an
 * approval, emitted by the driver when the user decides, and an agent that
 * could emit one could put a decision on the transcript that nobody made.
 */
export function parseAgentEvent(value: unknown): ChatEvent | null {
  const record = asRecord(value);
  if (!record) return null;
  switch (record.type) {
    case 'message-delta': {
      const text = str(record.text);
      return text === undefined ? null : { type: 'message-delta', text };
    }
    case 'reasoning-delta': {
      const text = str(record.text);
      return text === undefined ? null : { type: 'reasoning-delta', text };
    }
    case 'message-end':
      return { type: 'message-end' };
    case 'tool-begin': {
      const toolId = id(record.toolId);
      const title = str(record.title);
      if (toolId === undefined || title === undefined) return null;
      const kind = TOOL_KINDS.find((known) => known === record.kind) ?? 'other';
      const detail = str(record.detail);
      return { type: 'tool-begin', toolId, kind, title, ...(detail !== undefined ? { detail } : {}) };
    }
    case 'tool-output-delta': {
      const toolId = id(record.toolId);
      const chunk = typeof record.chunk === 'string' ? record.chunk : undefined;
      if (toolId === undefined || chunk === undefined) return null;
      return { type: 'tool-output-delta', toolId, chunk };
    }
    case 'tool-end': {
      const toolId = id(record.toolId);
      if (toolId === undefined) return null;
      const status = TOOL_STATUSES.find((known) => known === record.status) ?? 'ok';
      const summary = str(record.summary);
      const exitCode = typeof record.exitCode === 'number' && Number.isFinite(record.exitCode) ? record.exitCode : undefined;
      return {
        type: 'tool-end',
        toolId,
        status,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    case 'file-change': {
      const raw = Array.isArray(record.files) ? record.files.slice(0, MAX_FILES) : [];
      const files = raw.map(fileEntry).filter((entry): entry is FileChangeEntry => entry !== null);
      if (files.length === 0) return null;
      const toolId = id(record.toolId);
      return { type: 'file-change', ...(toolId !== undefined ? { toolId } : {}), files };
    }
    case 'approval-request': {
      const approvalId = id(record.approvalId);
      const title = str(record.title);
      if (approvalId === undefined || title === undefined) return null;
      const kind = APPROVAL_KINDS.find((known) => known === record.kind) ?? 'command';
      return { type: 'approval-request', approvalId, kind, title, detail: str(record.detail) ?? '' };
    }
    case 'subagent-start': {
      const agentId = id(record.agentId);
      const title = str(record.title);
      if (agentId === undefined || title === undefined) return null;
      const role = str(record.role);
      return { type: 'subagent-start', agentId, title, ...(role !== undefined ? { role } : {}) };
    }
    case 'subagent-delta': {
      const agentId = id(record.agentId);
      const chunk = typeof record.chunk === 'string' ? record.chunk : undefined;
      if (agentId === undefined || chunk === undefined) return null;
      return { type: 'subagent-delta', agentId, chunk };
    }
    case 'subagent-end': {
      const agentId = id(record.agentId);
      if (agentId === undefined) return null;
      const status = TOOL_STATUSES.find((known) => known === record.status) ?? 'ok';
      const summary = str(record.summary);
      return { type: 'subagent-end', agentId, status, ...(summary !== undefined ? { summary } : {}) };
    }
    case 'plan-update': {
      const text = str(record.text);
      if (text === undefined) return null;
      return { type: 'plan-update', planId: id(record.planId) ?? 'plan', text };
    }
    case 'image': {
      const toolId = id(record.toolId);
      const file = str(record.path);
      if (toolId === undefined || file === undefined) return null;
      const caption = str(record.caption);
      return { type: 'image', toolId, path: file, ...(caption !== undefined ? { caption } : {}) };
    }
    case 'notice': {
      const text = str(record.text);
      return text === undefined ? null : { type: 'notice', text };
    }
    case 'turn-complete':
      return { type: 'turn-complete' };
    case 'error':
      return { type: 'error', message: str(record.message) ?? 'The agent reported an error and said no more.' };
    default:
      // Unknown, legacy, or Hearth's own to emit. Dropped: see the head note.
      return null;
  }
}

// ---------------------------------------------------------------------------
// What Hearth says about an agent it does not control
// ---------------------------------------------------------------------------

/**
 * The one quiet line a turn carries when the agent did not claim approvals.
 *
 * The rule this exists for: Hearth may never show "Ask outside the folder"
 * while an unknown binary does whatever it likes. Hearth cannot gate another
 * program's tool calls, so it says so, once per turn, in the same `notice`
 * channel a compaction or a review mode uses. Not a banner, and not an
 * apology: it is a fact about who is enforcing what.
 */
export function permissionNotice(label: string, mode: PermissionMode): string {
  return `${label} enforces its own permissions. Hearth passed ${HEARTH_PERMISSION_MODE}=${mode} and shows what it did, but does not gate it.`;
}

/** What a turn says when the agent's process went away mid-answer. */
export function exitedMessage(label: string, reason: string): string {
  return `${label} stopped without finishing (${reason}). Your next message starts a fresh one.`;
}

/** What a bind says when the program never announced itself. */
export function handshakeMessage(label: string, commandLine: string): string {
  return `${label} did not send a Hearth agent handshake. Its first line of output must be {"type":"ready","protocol":${HEARTH_PROTOCOL_VERSION}}. Command: ${commandLine}`;
}

/** What a bind says when the program speaks a version this build does not. */
export function protocolMessage(label: string, protocol: number): string {
  return `${label} speaks Hearth agent protocol ${protocol}, and this build speaks ${HEARTH_PROTOCOL_VERSION}.`;
}
