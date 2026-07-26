/**
 * The codex app-server wire format — and the ONLY module that knows it.
 *
 * `codex app-server` speaks newline-delimited JSON-RPC 2.0 over stdio. It is
 * the same surface OpenAI's own desktop app drives, and it is explicitly
 * still evolving: method names have moved (`execCommandApproval` ->
 * `item/commandExecution/requestApproval`), error codes are overloaded, and
 * new notification kinds appear between releases. Every piece of that
 * knowledge is quarantined here so codex.ts holds session logic and nothing
 * else, and so a protocol change is a one-file edit.
 *
 * Tested against **codex-cli 0.144.5** (`codex --version`). The type shapes
 * below were generated from that build's own
 * `codex app-server generate-ts` output rather than transcribed from docs.
 *
 * Degradation rules, applied throughout:
 *  - An unknown notification method yields NO events instead of throwing.
 *    A newer codex inventing a kind must never break a running conversation.
 *  - Every field is probed, never trusted. A shape that doesn't match yields
 *    nothing rather than a half-built event.
 *  - Both the v2 approval methods and the legacy pre-v2 ones are handled, so
 *    the driver works across the versions in the wild.
 *
 * The protocol shape, for orientation:
 *
 *   initialize -> initialized  (handshake)
 *   thread/start | thread/resume -> a threadId
 *   turn/start -> notifications... -> turn/completed
 *   server -> client REQUESTS pause the turn until answered (approvals)
 */
import type {
  AgentTurnOptions,
  ApprovalDecision,
  ApprovalKind,
  ChatEvent,
  FileChangeEntry,
  ToolKind,
  ToolStatus,
} from '../chat.js';

/** The codex build this adapter was written and verified against. */
export const CODEX_TESTED_VERSION = '0.144.5';

/** What we announce ourselves as in `initialize`. */
export const CODEX_CLIENT_INFO = { name: 'hearth', title: 'Hearth', version: '0.1.0' };

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Encode one message as a protocol line (the trailing newline IS the frame). */
export function encodeRpc(message: RpcMessage): string {
  return `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;
}

/**
 * Split a stdout chunk into complete lines, returning the parsed messages and
 * whatever partial line is left over. Callers keep the remainder and prepend
 * it to the next chunk — stdout has no obligation to break on frame edges.
 */
export function decodeRpcChunk(buffer: string): { messages: RpcMessage[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const messages: RpcMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) messages.push(parsed as RpcMessage);
    } catch {
      // codex writes human-readable startup noise to stdout on some builds;
      // a line that isn't JSON is not a protocol error.
    }
  }
  return { messages, rest };
}

// ---------------------------------------------------------------------------
// Probing helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** codex's `ThreadItem.type` -> our provider-agnostic tool kind. */
export function codexItemKind(itemType: string): ToolKind | null {
  switch (itemType) {
    case 'commandExecution':
      return 'command';
    case 'fileChange':
      return 'file-change';
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return 'mcp';
    case 'webSearch':
      return 'web-search';
    default:
      return null;
  }
}

/** codex's per-item status strings -> our settled status. */
export function codexStatus(raw: unknown): ToolStatus {
  switch (raw) {
    case 'failed':
      return 'error';
    case 'declined':
      return 'declined';
    default:
      return 'ok';
  }
}

/** codex's `PatchChangeKind` -> our file-change kind. */
export function codexChangeKind(raw: unknown): FileChangeEntry['kind'] {
  const type = asRecord(raw)?.type ?? raw;
  if (type === 'add') return 'create';
  if (type === 'delete') return 'delete';
  return 'edit';
}

/** The `changes` array of a fileChange item, as our file entries. */
export function codexFileChanges(item: Record<string, unknown>): FileChangeEntry[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const files: FileChangeEntry[] = [];
  for (const raw of changes) {
    const change = asRecord(raw);
    const filePath = str(change?.path);
    if (!change || !filePath) continue;
    files.push({ path: filePath, kind: codexChangeKind(change.kind), diff: str(change.diff) });
  }
  return files;
}

/** A one-line human title for an item that is about to run. */
export function codexItemTitle(item: Record<string, unknown>): string {
  switch (item.type) {
    case 'commandExecution':
      return str(item.command) ?? 'command';
    case 'fileChange': {
      const files = codexFileChanges(item);
      return files.length === 1 ? files[0].path : `${files.length} files`;
    }
    case 'mcpToolCall':
      return [str(item.server), str(item.tool)].filter(Boolean).join(' · ') || 'tool';
    case 'dynamicToolCall':
      return str(item.tool) ?? 'tool';
    case 'webSearch':
      return str(item.query) ?? 'web search';
    default:
      return String(item.type ?? 'tool');
  }
}

// ---------------------------------------------------------------------------
// Notifications -> ChatEvents
// ---------------------------------------------------------------------------

/**
 * Map ONE server notification onto zero or more ChatEvents. Pure, so the whole
 * mapping is unit-testable by feeding it protocol lines with no subprocess in
 * sight.
 *
 * `agentMessage` and `reasoning` items are streamed via their delta
 * notifications, so their `item/started` and `item/completed` are deliberately
 * ignored — emitting the completed item's full text as well would print every
 * answer twice.
 */
export function mapCodexNotification(method: string, params: unknown): ChatEvent[] {
  const p = asRecord(params);
  if (!p) return [];

  switch (method) {
    case 'item/agentMessage/delta': {
      const text = str(p.delta);
      return text ? [{ type: 'message-delta', text }] : [];
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const text = str(p.delta);
      return text ? [{ type: 'reasoning-delta', text }] : [];
    }
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta': {
      const toolId = str(p.itemId);
      const chunk = decodeDelta(p.delta);
      return toolId && chunk ? [{ type: 'tool-output-delta', toolId, chunk }] : [];
    }
    case 'item/started':
      return mapItemStarted(asRecord(p.item));
    case 'item/completed':
      return mapItemCompleted(asRecord(p.item));
    case 'turn/completed':
      return [{ type: 'turn-complete' }];
    case 'error': {
      const error = asRecord(p.error);
      // `willRetry` means codex is handling it itself; surfacing that as a
      // turn-ending error would be a lie.
      if (p.willRetry === true) return [];
      return [{ type: 'error', message: str(error?.message) ?? 'The agent ended with an error.' }];
    }
    default:
      return []; // unknown / uninteresting: log-and-ignore is the contract
  }
}

/**
 * Output deltas are plain strings on 0.144.5, but older builds sent
 * base64-encoded bytes. Accept both rather than rendering base64 at the user.
 */
function decodeDelta(raw: unknown): string | undefined {
  const value = str(raw);
  if (!value) return undefined;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0 && value.length > 8) {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      // Only trust the decode when it round-trips and looks like text.
      if (Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) {
        return decoded;
      }
    } catch {
      /* not base64 after all */
    }
  }
  return value;
}

function mapItemStarted(item: Record<string, unknown> | null): ChatEvent[] {
  if (!item) return [];
  const id = str(item.id);
  if (!id) return [];
  if (item.type === 'subAgentActivity') {
    if (item.kind !== 'started') return [];
    return [{ type: 'subagent-start', agentId: id, role: str(item.agentPath), title: str(item.agentPath) ?? 'Subagent' }];
  }
  const kind = codexItemKind(String(item.type ?? ''));
  if (!kind) return [];
  const events: ChatEvent[] = [
    { type: 'tool-begin', toolId: id, kind, title: codexItemTitle(item), detail: str(item.cwd) },
  ];
  // A file change is announced with its full patch up front, so the card can
  // render before the apply finishes.
  if (kind === 'file-change') {
    const files = codexFileChanges(item);
    if (files.length > 0) events.push({ type: 'file-change', toolId: id, files });
  }
  return events;
}

function mapItemCompleted(item: Record<string, unknown> | null): ChatEvent[] {
  if (!item) return [];
  const id = str(item.id);
  if (!id) return [];
  if (item.type === 'subAgentActivity') {
    return [{ type: 'subagent-end', agentId: id, status: item.kind === 'interrupted' ? 'error' : 'ok' }];
  }
  const kind = codexItemKind(String(item.type ?? ''));
  if (!kind) return [];
  const events: ChatEvent[] = [];
  // The completed patch is authoritative (it carries the applied diff), so a
  // file-change card is refreshed rather than left at its announced state.
  if (kind === 'file-change') {
    const files = codexFileChanges(item);
    if (files.length > 0) events.push({ type: 'file-change', toolId: id, files });
  }
  const exit = item.exitCode;
  events.push({
    type: 'tool-end',
    toolId: id,
    status: codexStatus(item.status),
    exitCode: typeof exit === 'number' ? exit : undefined,
    summary: str(item.aggregatedOutput)?.slice(-400),
  });
  return events;
}

// ---------------------------------------------------------------------------
// Approvals (server -> client REQUESTS, which pause the turn)
// ---------------------------------------------------------------------------

/** Every method name that means "the agent is asking permission". */
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  // pre-v2 spellings, still emitted by older builds
  'execCommandApproval',
  'applyPatchApproval',
]);

export function isApprovalRequest(method: string): boolean {
  return APPROVAL_METHODS.has(method);
}

export interface CodexApproval {
  kind: ApprovalKind;
  title: string;
  detail: string;
}

/**
 * Describe an approval request for the transcript. Returns null when the
 * method isn't an approval or the params are unusable — the caller answers a
 * request it can't describe with a `deny` rather than hanging the turn.
 */
export function mapCodexApproval(method: string, params: unknown): CodexApproval | null {
  if (!isApprovalRequest(method)) return null;
  const p = asRecord(params) ?? {};
  const reason = str(p.reason);
  const isCommand = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval';
  if (isCommand) {
    // v2 carries the command on the item; the legacy method carried it inline.
    const command = Array.isArray(p.command) ? p.command.join(' ') : str(p.command);
    return {
      kind: 'command',
      title: reason ?? 'Run this command?',
      detail: command ?? str(p.itemId) ?? 'a command',
    };
  }
  const changes = asRecord(p.fileChanges);
  const paths = changes ? Object.keys(changes) : [];
  const grant = str(p.grantRoot);
  return {
    kind: 'file-change',
    title: reason ?? 'Apply these changes?',
    detail: paths.length > 0 ? paths.join('\n') : (grant ?? str(p.itemId) ?? 'file changes'),
  };
}

/**
 * The reply body for an approval request. The vocabularies genuinely differ
 * by method — v2 wants `accept`/`decline`, the legacy methods want a
 * `ReviewDecision` (`approved`/`denied`) — and getting it wrong leaves the
 * turn wedged, so the mapping is explicit rather than clever.
 */
export function codexApprovalReply(method: string, decision: ApprovalDecision): { decision: string } {
  const isLegacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
  if (isLegacy) return { decision: decision === 'allow' ? 'approved' : 'denied' };
  return { decision: decision === 'allow' ? 'accept' : 'decline' };
}

// ---------------------------------------------------------------------------
// Models and per-turn overrides
// ---------------------------------------------------------------------------

/** One model the codex account can answer with, as the selector shows it. */
export interface CodexModelInfo {
  id: string;
  label: string;
  note?: string;
}

/**
 * The model/effort fields to put on a `turn/start`, given the user's choice.
 *
 * `TurnStartParams` on CODEX_TESTED_VERSION carries `model?: string | null`
 * and `effort?: ReasoningEffort | null`, both documented as overriding the
 * thread's setting for this turn and subsequent ones. Absent fields mean "keep
 * whatever codex is configured with", so a turn with no expressed choice sends
 * NEITHER key rather than an explicit null — a null would be a deliberate
 * reset, which is not what "the user didn't pick" means.
 */
export function codexTurnOverrides(agent: AgentTurnOptions | null | undefined): { model?: string; effort?: string } {
  const out: { model?: string; effort?: string } = {};
  if (!agent) return out;
  // A choice aimed at the other vendor carries an anthropic model id; sending
  // it to codex would just fail the turn.
  if (agent.provider === 'anthropic') return out;
  if (typeof agent.model === 'string' && agent.model !== '') out.model = agent.model;
  if (agent.effort) out.effort = agent.effort;
  return out;
}

/**
 * Read `model/list`'s result into the selector's vocabulary. Hidden models are
 * dropped (codex hides them from its own picker for a reason), and the
 * account's default is noted so the UI can say which one "Default" means.
 */
export function mapCodexModels(result: unknown): CodexModelInfo[] {
  const data = asRecord(result)?.data;
  if (!Array.isArray(data)) return [];
  const models: CodexModelInfo[] = [];
  for (const raw of data) {
    const model = asRecord(raw);
    if (!model || model.hidden === true) continue;
    const id = str(model.id) ?? str(model.model);
    if (!id) continue;
    const entry: CodexModelInfo = { id, label: str(model.displayName) ?? id };
    if (model.isDefault === true) entry.note = 'Default';
    models.push(entry);
  }
  return models;
}

// ---------------------------------------------------------------------------
// Account / auth
// ---------------------------------------------------------------------------

export interface CodexAccount {
  loggedIn: boolean;
  authMode: 'chatgpt' | 'apikey' | null;
  email: string | null;
  planType: string | null;
}

/** Read `account/read`'s result. Absent account = installed but signed out. */
export function mapCodexAccount(result: unknown): CodexAccount {
  const account = asRecord(asRecord(result)?.account);
  if (!account) return { loggedIn: false, authMode: null, email: null, planType: null };
  const type = account.type;
  if (type === 'apiKey') return { loggedIn: true, authMode: 'apikey', email: null, planType: null };
  if (type === 'chatgpt') {
    return {
      loggedIn: true,
      authMode: 'chatgpt',
      email: str(account.email) ?? null,
      planType: str(account.planType) ?? null,
    };
  }
  // A third credential source (Bedrock, and whatever comes next) is still a
  // signed-in state; we just have no vocabulary for naming it.
  return { loggedIn: true, authMode: null, email: null, planType: null };
}

/** The browser URL from `account/login/start`, when the flow needs one. */
export function mapCodexLoginStart(result: unknown): { authUrl: string | null; loginId: string | null } {
  const r = asRecord(result);
  return { authUrl: str(r?.authUrl) ?? null, loginId: str(r?.loginId) ?? null };
}
