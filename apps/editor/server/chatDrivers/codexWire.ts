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
  ChatAttachment,
  ChatEvent,
  FileChangeEntry,
  ToolKind,
  ToolStatus,
} from '../chat.js';
import { isInlineImage } from '../chatAttachments.js';
import type { PermissionMode } from '../permissionMode.js';

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

/**
 * Item types this file handles somewhere OTHER than as a tool row: streamed
 * prose, the plan card, images, notices, subagents. Everything else — known or
 * not — becomes a tool row, which is what stops a codex release adding an item
 * type that silently disappears from the transcript.
 */
const NON_TOOL_ITEMS = new Set([
  'agentMessage',
  'reasoning',
  'userMessage',
  'plan',
  'subAgentActivity',
  'collabAgentToolCall',
  'imageGeneration',
  'imageView',
  'contextCompaction',
  'sleep',
  'enteredReviewMode',
  'exitedReviewMode',
]);

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
      // Not "unknown, so drop it" — unknown, so show it plainly. A row titled
      // with the item's own type is a worse label than a hand-written one and
      // a far better outcome than nothing.
      return NON_TOOL_ITEMS.has(itemType) ? null : 'other';
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
    case 'hookPrompt':
      return 'hook';
    default:
      return String(item.type ?? 'tool');
  }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * Which skill a shell command is reading, or null.
 *
 * This is inference, and it is inference because codex offers nothing else.
 * The protocol has `skills/list`, `skills/extraRoots/set`, `skills/config/write`
 * and a `skills/changed` invalidation ping, and `UserInput` has a `skill`
 * variant for a person picking one in a composer, but `ThreadItem`, the union
 * every transcript row is built from, has NO skill member on
 * CODEX_TESTED_VERSION. Skills reach the model as prose in the system prompt,
 * and codex's own instructions for using one are: "the main agent must read
 * its `SKILL.md` completely before taking task actions." Reading that file
 * through the shell IS the invocation, and the path in the command names the
 * skill.
 *
 * So this reads the path rather than guessing at intent, and refuses anything
 * ambiguous: the command has to name exactly one `<root>/<id>/SKILL.md`, one
 * level under a known skills root, with `<id>` shaped like a folder name. A
 * sweep across several skills at once (a grep over a glob of skill folders)
 * names none of them in particular and yields null, which leaves the ordinary
 * command row in place.
 *
 * Separators are normalised and the comparison is case-folded so a Windows
 * command reading a backslashed path under `.hearth\skills` still matches the
 * root it came from.
 */
export function codexSkillRead(command: string | undefined, roots: readonly string[]): string | null {
  if (!command || roots.length === 0) return null;
  const haystack = command.replace(/\\/g, '/');
  const prefixes = roots.map((root) => `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`.toLowerCase());
  const found = new Set<string>();
  for (const match of haystack.matchAll(/([^\s'"`;|&<>()]+)\/SKILL\.md/gi)) {
    const dir = match[1];
    const cut = dir.lastIndexOf('/');
    if (cut <= 0) continue;
    const id = dir.slice(cut + 1);
    // A glob or a traversal segment is not a skill the row can name.
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) continue;
    const parent = `${dir.slice(0, cut)}/`.toLowerCase();
    if (prefixes.includes(parent)) found.add(id);
  }
  return found.size === 1 ? [...found][0] : null;
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
 *
 * `skillRoots` are the folders skills live in on this machine, used only to
 * recognise a shell command that is reading one (see `codexSkillRead`).
 * Optional: without them every command stays a command, which is exactly what
 * this did before skills were surfaced.
 */
export function mapCodexNotification(method: string, params: unknown, skillRoots: readonly string[] = []): ChatEvent[] {
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
    case 'item/plan/delta':
    case 'turn/plan/updated': {
      // The plan arrives as whole text, not as an append, so the card is
      // replaced rather than grown.
      const text = str(p.text) ?? str(p.plan) ?? str(p.delta);
      const planId = str(p.itemId) ?? 'plan';
      return text ? [{ type: 'plan-update', planId, text }] : [];
    }
    case 'thread/compacted':
      return [{ type: 'notice', text: 'Earlier turns were summarised to make room.' }];
    case 'item/started':
      return mapItemStarted(asRecord(p.item), skillRoots);
    case 'item/completed':
      return mapItemCompleted(asRecord(p.item), skillRoots);
    case 'turn/completed':
      return mapTurnCompleted(asRecord(p.turn));
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

/**
 * The item types that are their own thing rather than a tool row, mapped for
 * both `item/started` and `item/completed`. Returns null when the item is not
 * one of them, so the caller falls through to the tool-row path.
 */
function mapSpecialItem(item: Record<string, unknown>, id: string, done: boolean): ChatEvent[] | null {
  switch (item.type) {
    case 'subAgentActivity':
      if (done) return [{ type: 'subagent-end', agentId: id, status: item.kind === 'interrupted' ? 'error' : 'ok' }];
      if (item.kind !== 'started') return [];
      return [
        { type: 'subagent-start', agentId: id, role: str(item.agentPath), title: str(item.agentPath) ?? 'Subagent' },
      ];
    // A collab call IS a nested agent — the same card, so a delegated task
    // reads the same whichever mechanism codex used to delegate it.
    case 'collabAgentToolCall':
      if (done) {
        return [{ type: 'subagent-end', agentId: id, status: codexStatus(item.status), summary: str(item.prompt) }];
      }
      return [
        {
          type: 'subagent-start',
          agentId: id,
          role: str(item.tool),
          title: str(item.prompt)?.slice(0, 120) ?? str(item.tool) ?? 'Agent',
        },
      ];
    case 'plan': {
      const text = str(item.text);
      return text ? [{ type: 'plan-update', planId: id, text }] : [];
    }
    case 'imageGeneration': {
      if (!done) return [{ type: 'tool-begin', toolId: id, kind: 'other', title: 'Generating an image' }];
      const saved = str(item.savedPath);
      const events: ChatEvent[] = [];
      if (saved) events.push({ type: 'image', toolId: id, path: saved, caption: str(item.revisedPrompt) });
      events.push({ type: 'tool-end', toolId: id, status: codexStatus(item.status) });
      return events;
    }
    case 'imageView': {
      if (done) return [];
      const viewed = str(item.path);
      return viewed ? [{ type: 'image', toolId: id, path: viewed, caption: 'Looked at this' }] : [];
    }
    case 'contextCompaction':
      return done ? [{ type: 'notice', text: 'Earlier turns were summarised to make room.' }] : [];
    case 'sleep': {
      if (done) return [];
      const ms = typeof item.durationMs === 'number' ? item.durationMs : 0;
      return [{ type: 'notice', text: `Waiting ${Math.max(1, Math.round(ms / 1000))}s.` }];
    }
    case 'enteredReviewMode':
      return done ? [] : [{ type: 'notice', text: 'Reviewing the changes.' }];
    case 'exitedReviewMode':
      return done ? [{ type: 'notice', text: 'Finished reviewing.' }] : [];
    default:
      return null;
  }
}

/**
 * The end of a turn, which is not the same thing as a turn that worked.
 *
 * There is no `turn/failed` in this protocol. Every turn ends on
 * `turn/completed`, and the Turn it carries holds a `status` of
 * `completed | interrupted | failed | inProgress` with `error` populated only
 * on `failed` (verified against the binary's own schema, codex-cli 0.144.5,
 * `codex app-server generate-json-schema`). Reading the method and ignoring
 * the status treats all four the same.
 *
 * That is the bug this exists to close, and it is a bad one because of how it
 * presents: a turn that failed reported as a turn that finished. Jake hit it
 * approving a file-change patch that codex then could not write, and what he
 * saw was the conversation simply stopping mid-thought with nothing said. A
 * silent stop sends you looking for the fault in your own prompt, which is the
 * one place it is not.
 *
 * `turn-complete` still follows the error, because the turn IS over either way
 * and the composer has to come back. What changes is that the reason is said
 * out loud first.
 */
function mapTurnCompleted(turn: Record<string, unknown> | null): ChatEvent[] {
  const status = str(turn?.status);
  if (status === 'failed') {
    const error = asRecord(turn?.error);
    const detail = str(error?.additionalDetails);
    const message = str(error?.message) ?? 'The agent stopped without saying why.';
    return [{ type: 'error', message: detail ? `${message} ${detail}` : message }, { type: 'turn-complete' }];
  }
  // Interrupted is a stop someone asked for, so it is not an error, but it is
  // also not silence: a turn that ends early with no word reads as a crash.
  if (status === 'interrupted') {
    return [{ type: 'notice', text: 'The turn was interrupted.' }, { type: 'turn-complete' }];
  }
  return [{ type: 'turn-complete' }];
}

function mapItemStarted(item: Record<string, unknown> | null, skillRoots: readonly string[]): ChatEvent[] {
  if (!item) return [];
  const id = str(item.id);
  if (!id) return [];
  const special = mapSpecialItem(item, id, false);
  if (special) return special;
  // A read of a skill's SKILL.md REPLACES the command row rather than sitting
  // beside it: the command is the mechanism, the skill is the thing that
  // happened, and printing both would say the same event twice. The command
  // itself stays as the row's detail, so opening it shows what actually ran.
  const skill = item.type === 'commandExecution' ? codexSkillRead(str(item.command), skillRoots) : null;
  if (skill) {
    return [{ type: 'tool-begin', toolId: id, kind: 'skill', title: skill, detail: str(item.command) }];
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

function mapItemCompleted(item: Record<string, unknown> | null, skillRoots: readonly string[]): ChatEvent[] {
  if (!item) return [];
  // The text already arrived through the delta stream, so the completed item's
  // own copy is deliberately dropped (printing it would double every answer).
  // What is NOT redundant is the fact that this message ENDED: nothing in the
  // delta stream says so, and a turn writes several messages. Without this the
  // next one is appended straight onto this one's last character.
  if (item.type === 'agentMessage') return [{ type: 'message-end' }];
  const id = str(item.id);
  if (!id) return [];
  const special = mapSpecialItem(item, id, true);
  if (special) return special;
  // Settles the skill row opened above. No summary: the captured output of
  // this command is the skill's own text, and a whole SKILL.md pasted into a
  // row's detail is not what "what happened" means.
  if (item.type === 'commandExecution' && codexSkillRead(str(item.command), skillRoots)) {
    return [{ type: 'tool-end', toolId: id, status: codexStatus(item.status) }];
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

/** Server requests that are the agent ASKING something rather than doing it. */
const QUESTION_METHODS = new Set(['item/tool/requestUserInput', 'mcpServer/elicitation/request']);

export function isQuestionRequest(method: string): boolean {
  return QUESTION_METHODS.has(method);
}

export type InputQuestionValue = string | number | boolean | string[];

/** The provider-neutral input vocabulary sent to Hearth's renderer. */
export interface InputQuestionDescriptor {
  id: string;
  label: string;
  type: 'choice' | 'text' | 'number' | 'boolean' | 'url';
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  multiple?: boolean;
  allowOther?: boolean;
  options?: Array<{ value: string; label: string; description?: string }>;
  min?: number;
  max?: number;
}

export interface InputRequestDescriptor {
  inputId: string;
  title?: string;
  description?: string;
  questions: InputQuestionDescriptor[];
  allowCancel?: boolean;
  timeoutMs?: number;
  externalAction?: { type: 'open-url'; url: string; elicitationId: string };
}

/**
 * Turn either Codex input request into the shared renderer vocabulary.
 *
 * The descriptor contains presentation data only. In particular, it carries
 * `secret: true` but never an answer; answers remain in the driver only long
 * enough to build the JSON-RPC response.
 */
export function mapCodexQuestionRequest(
  method: string,
  inputId: string,
  params: unknown,
): InputRequestDescriptor | null {
  if (!isQuestionRequest(method) || !inputId) return null;
  const p = asRecord(params);
  if (!p) return null;

  if (method === 'item/tool/requestUserInput') {
    const rawQuestions = Array.isArray(p.questions) ? p.questions : [];
    const questions: InputQuestionDescriptor[] = [];
    let title: string | undefined;
    for (const raw of rawQuestions) {
      const question = asRecord(raw);
      const id = str(question?.id);
      const label = str(question?.question);
      if (!id || !label) continue;
      title ??= str(question?.header);
      const rawOptions = Array.isArray(question?.options) ? question.options : [];
      const options = rawOptions.flatMap((rawOption) => {
        const option = asRecord(rawOption);
        const value = str(option?.label);
        if (!value) return [];
        const description = str(option?.description);
        return [{ value, label: value, ...(description ? { description } : {}) }];
      });
      questions.push({
        id,
        label,
        type: options.length > 0 ? 'choice' : 'text',
        required: true,
        secret: question?.isSecret === true,
        allowOther: question?.isOther === true,
        ...(options.length > 0 ? { options } : {}),
      });
    }
    if (questions.length === 0) return null;
    const timeout = typeof p.autoResolutionMs === 'number' && p.autoResolutionMs >= 0 ? p.autoResolutionMs : undefined;
    return {
      inputId,
      ...(title ? { title } : {}),
      ...(timeout === undefined ? {} : { timeoutMs: timeout }),
      questions,
      allowCancel: true,
    };
  }

  const mode = str(p.mode);
  const source = str(p.serverName);
  const message = str(p.message);
  if (!mode || !source || !message) return null;
  if (mode === 'url') {
    const url = str(p.url);
    const elicitationId = str(p.elicitationId);
    if (!url || !elicitationId) return null;
    let externalUrl: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      externalUrl = parsed.toString();
    } catch {
      return null;
    }
    return {
      inputId,
      title: source,
      description: message,
      questions: [],
      externalAction: Object.freeze({ type: 'open-url', url: externalUrl, elicitationId }),
      allowCancel: true,
    };
  }
  if (mode !== 'form' && mode !== 'openai/form') return null;
  const schema = asRecord(p.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (!schema || !properties) return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : []);
  const questions: InputQuestionDescriptor[] = [];
  for (const [id, rawProperty] of Object.entries(properties)) {
    const question = mapElicitationProperty(id, rawProperty, required.has(id));
    if (!question) return null;
    questions.push(question);
  }
  if (questions.length === 0) return null;
  return { inputId, title: source, description: message, questions, allowCancel: true };
}

function mapElicitationProperty(id: string, raw: unknown, required: boolean): InputQuestionDescriptor | null {
  const schema = asRecord(raw);
  if (!schema) return null;
  const label = str(schema.title) ?? id;
  const secret = schema.writeOnly === true || schema.format === 'password';
  const common = { id, label, required, secret };
  const description = str(schema.description);

  const plainEnum = Array.isArray(schema.enum) ? schema.enum.filter((value): value is string => typeof value === 'string') : [];
  const enumNames = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  const enumOptions =
    plainEnum.length > 0
      ? plainEnum.map((value, index) => ({
          value,
          label: str(enumNames[index]) ?? value,
          ...(description ? { description } : {}),
        }))
      : oneOf.flatMap((rawOption) => {
          const option = asRecord(rawOption);
          const value = str(option?.const);
          if (!value) return [];
          return [{ value, label: str(option?.title) ?? value, ...(description ? { description } : {}) }];
        });
  if (enumOptions.length > 0) return { ...common, type: 'choice', options: enumOptions };

  if (schema.type === 'array') {
    const items = asRecord(schema.items);
    const values = Array.isArray(items?.enum) ? items.enum : [];
    const titled = Array.isArray(items?.anyOf) ? items.anyOf : [];
    const options =
      values.length > 0
        ? values.flatMap((value) =>
            typeof value === 'string' ? [{ value, label: value, ...(description ? { description } : {}) }] : [],
          )
        : titled.flatMap((rawOption) => {
            const option = asRecord(rawOption);
            const value = str(option?.const);
            if (!value) return [];
            return [{ value, label: str(option?.title) ?? value, ...(description ? { description } : {}) }];
          });
    return options.length > 0 ? { ...common, type: 'choice', multiple: true, options } : null;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return {
      ...common,
      type: 'number',
      ...(typeof schema.minimum === 'number' ? { min: schema.minimum } : {}),
      ...(typeof schema.maximum === 'number' ? { max: schema.maximum } : {}),
    };
  }
  if (schema.type === 'boolean') return { ...common, type: 'boolean' };
  if (schema.type === 'string') return { ...common, type: schema.format === 'uri' ? 'url' : 'text' };
  return null;
}

/** Exact `ToolRequestUserInputResponse` from codex 0.144.5. */
export function codexUserInputReply(answers: Readonly<Record<string, InputQuestionValue>>): {
  answers: Record<string, { answers: string[] }>;
} {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, value]) => [id, { answers: (Array.isArray(value) ? value : [value]).map(String) }]),
    ),
  };
}

/** Exact `McpServerElicitationRequestResponse` from codex 0.144.5. */
export function codexElicitationReply(
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>,
): { action: 'accept' | 'decline' | 'cancel'; content: Record<string, unknown> | null; _meta: null } {
  return { action, content: action === 'accept' ? (content ?? {}) : null, _meta: null };
}

export type CodexServerRequestKind = 'approval' | 'question' | 'current-time' | 'unsupported';

/** Classify before replying: unknown requests must not be mistaken for success. */
export function classifyCodexServerRequest(method: string): CodexServerRequestKind {
  if (isApprovalRequest(method)) return 'approval';
  if (isQuestionRequest(method)) return 'question';
  if (method === 'currentTime/read') return 'current-time';
  return 'unsupported';
}

/** Exact `CurrentTimeReadResponse`; Codex specifies whole Unix seconds. */
export function codexCurrentTimeReply(nowMs = Date.now()): { currentTimeAt: number } {
  return { currentTimeAt: Math.floor(nowMs / 1000) };
}

/**
 * Flatten a `requestUserInput` into one readable line for the transcript.
 *
 * Hearth has no picker for these yet, and codex resolves them on its own
 * timer, so the honest thing is to SHOW what was asked: an agent that quietly
 * asked a question and moved on is the kind of gap that makes people go back
 * to the terminal. Answering in the next message still works, because the
 * agent is in the same conversation.
 */
export function describeQuestion(params: unknown): string | null {
  const p = asRecord(params) ?? {};
  const questions = Array.isArray(p.questions) ? p.questions : [];
  const lines: string[] = [];
  for (const raw of questions) {
    const question = asRecord(raw);
    const text = str(question?.question) ?? str(question?.header);
    if (!text) continue;
    const options = Array.isArray(question?.options) ? question.options : [];
    const labels = options
      .map((option) => str(asRecord(option)?.label))
      .filter((label): label is string => Boolean(label));
    lines.push(labels.length > 0 ? `${text} (${labels.join(' / ')})` : text);
  }
  // An elicitation carries a plain message rather than a question list.
  if (lines.length === 0) {
    const message = str(p.message) ?? str(asRecord(p.params)?.message);
    if (message) lines.push(message);
  }
  return lines.length > 0 ? `The agent asked: ${lines.join(' · ')}` : null;
}

export interface CodexApproval {
  kind: ApprovalKind;
  title: string;
  detail: string;
  decisions?: CodexApprovalDecisionDisplay[];
}

export interface CodexApprovalDecisionDisplay {
  id: string;
  label: string;
  tone: 'allow' | 'deny' | 'neutral';
}

/**
 * `wireDecision` never leaves the server. The browser selects the opaque
 * display id; the driver looks that id up and sends this exact server-authored
 * value back, so it can never forge an exec/network amendment.
 */
export interface CodexApprovalDecision {
  display: CodexApprovalDecisionDisplay;
  wireDecision: unknown;
}

export interface CodexApprovalRequest {
  approval: CodexApproval;
  /** Server-only lookup. Never serialize or copy this into a ChatEvent. */
  decisionsById: ReadonlyMap<string, unknown>;
}

/**
 * Describe an approval request for the transcript. Returns null when the
 * method isn't an approval or the params are unusable — the caller answers a
 * request it can't describe with a `deny` rather than hanging the turn.
 */
export function mapCodexApproval(method: string, params: unknown): CodexApproval | null {
  return mapCodexApprovalRequest(method, params)?.approval ?? null;
}

export function mapCodexApprovalRequest(method: string, params: unknown): CodexApprovalRequest | null {
  if (!isApprovalRequest(method)) return null;
  const p = asRecord(params) ?? {};
  const reason = str(p.reason);
  const isCommand = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval';
  const decisions = mapApprovalDecisions(p.availableDecisions);
  let approval: CodexApproval;
  if (isCommand) {
    // v2 carries the command on the item; the legacy method carried it inline.
    const command = Array.isArray(p.command) ? p.command.join(' ') : str(p.command);
    approval = {
      kind: 'command',
      title: reason ?? 'Run this command?',
      detail: command ?? str(p.itemId) ?? 'a command',
      ...(decisions.length > 0 ? { decisions: decisions.map((decision) => decision.display) } : {}),
    };
  } else {
    const changes = asRecord(p.fileChanges);
    const paths = changes ? Object.keys(changes) : [];
    const grant = str(p.grantRoot);
    approval = {
      kind: 'file-change',
      title: reason ?? 'Apply these changes?',
      detail: paths.length > 0 ? paths.join('\n') : (grant ?? str(p.itemId) ?? 'file changes'),
      ...(decisions.length > 0 ? { decisions: decisions.map((decision) => decision.display) } : {}),
    };
  }
  return { approval, decisionsById: new Map(decisions.map((decision) => [decision.display.id, decision.wireDecision])) };
}

function mapApprovalDecisions(raw: unknown): CodexApprovalDecision[] {
  if (!Array.isArray(raw)) return [];
  const decisions: CodexApprovalDecision[] = [];
  for (const [index, wireDecision] of raw.entries()) {
    let label: string | undefined;
    let tone: CodexApprovalDecisionDisplay['tone'] = 'allow';
    if (wireDecision === 'accept') label = 'Allow once';
    else if (wireDecision === 'acceptForSession') label = 'Allow for session';
    else if (wireDecision === 'decline') {
      label = 'Deny';
      tone = 'deny';
    } else if (wireDecision === 'cancel') {
      label = 'Cancel';
      tone = 'neutral';
    } else {
      const tagged = asRecord(wireDecision);
      const exec = asRecord(tagged?.acceptWithExecpolicyAmendment);
      const network = asRecord(tagged?.applyNetworkPolicyAmendment);
      if (
        exec &&
        Array.isArray(exec.execpolicy_amendment) &&
        exec.execpolicy_amendment.every((part) => typeof part === 'string')
      ) label = 'Allow and remember this command';
      else if (network && asRecord(network.network_policy_amendment)) label = 'Allow and remember this network access';
    }
    if (label) decisions.push({ display: { id: `decision-${index}`, label, tone }, wireDecision });
  }
  return decisions;
}

/** Reply with the exact decision value retained from the server request. */
export function codexApprovalChoiceReply(
  decisionsById: ReadonlyMap<string, unknown>,
  choiceId: string,
): { decision: unknown } | null {
  return decisionsById.has(choiceId) ? { decision: decisionsById.get(choiceId) } : null;
}

/** Provider-neutral transcript result for an opaque server-authored choice. */
export function codexApprovalChoiceResolution(
  decisionsById: ReadonlyMap<string, unknown>,
  choiceId: string,
): ApprovalDecision | null {
  if (!decisionsById.has(choiceId)) return null;
  const wire = decisionsById.get(choiceId);
  return wire === 'decline' || wire === 'cancel' ? 'deny' : 'allow';
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

/**
 * One reasoning effort a model accepts. The id is the token codex wants on
 * `turn/start`; the description is the binary's own one-liner for it. There is
 * deliberately no display name here — codex doesn't ship one, so naming these
 * is presentation, and presentation is the client's job.
 */
export interface CodexEffortOption {
  id: string;
  description?: string;
}

/**
 * One model the codex account can answer with, as the selector shows it.
 *
 * Everything past `id`/`label` is the binary's own catalogue entry, carried
 * through rather than summarised: which efforts THIS model accepts, which one
 * it uses when none is sent, and the sentence codex itself uses to describe it.
 * Offering an effort a model rejects is the same class of mistake as inventing
 * a model id, and only the binary knows the answer.
 */
export interface CodexModelInfo {
  id: string;
  label: string;
  note?: string;
  /** codex's own one-line description, e.g. "Fast and affordable…". */
  description?: string;
  /** This is the model codex picks when no model is named. */
  isDefault?: boolean;
  /** Efforts this model accepts, in the binary's order. Absent = it said none. */
  efforts?: CodexEffortOption[];
  /** The effort this model uses when the turn names none. */
  defaultEffort?: string;
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
 * The standing-instructions field to put on a `thread/start`.
 *
 * `ThreadStartParams` on CODEX_TESTED_VERSION carries TWO instruction fields
 * and they are not interchangeable:
 *
 *  - `baseInstructions` REPLACES codex's own system prompt. The binary's
 *    embedded copy of that prompt begins "You are Codex, a coding agent based
 *    on GPT-5" and runs to several thousand words of tool and editing rules;
 *    sending a user's house rules there would delete all of it.
 *  - `developerInstructions` is an ADDITIONAL developer message. This is the
 *    one we want.
 *
 * Neither field is documented in the generated schema, so the difference was
 * established by running the real binary rather than by reading the names: a
 * thread started with `developerInstructions: "always begin your reply with
 * PLATYPUS"`, in a folder whose AGENTS.md said "the codeword is TANGERINE",
 * answered "PLATYPUS. The project codeword is TANGERINE." Both were honoured,
 * which is the two things that had to be true — the text reaches the model,
 * and it does not displace the project's own instructions.
 *
 * `thread/resume` declares the same field, and it is deliberately NOT sent
 * there. Two more runs against the binary showed why: instructions given at
 * `thread/start` survive a resume on their own, and instructions passed to a
 * `thread/resume` are ignored. Sending it on resume would be a line of code
 * that looks like it does something and does not.
 *
 * Absent when there is nothing to say — an explicit null would be a request to
 * clear instructions, which is not what "the user set no preferences" means.
 */
export function codexThreadInstructions(personal: string | null): { developerInstructions?: string } {
  return personal ? { developerInstructions: personal } : {};
}

/**
 * The approval and sandbox fields for a `thread/start` or a `thread/resume`,
 * given the mode the user chose for this project.
 *
 * `ThreadStartParams` and `ThreadResumeParams` on CODEX_TESTED_VERSION both
 * carry `approvalPolicy` (`untrusted` | `on-request` | `never`, or a `granular`
 * object we deliberately do not use) and `sandbox` (`read-only` |
 * `workspace-write` | `danger-full-access`), read out of the binary's own
 * `generate-json-schema` rather than from docs.
 *
 * Two things about this are load-bearing:
 *
 *  1. **Both fields are always sent, on BOTH methods.** Hearth used to send
 *     neither, which meant codex fell back to whatever `~/.codex/config.toml`
 *     said. On a machine whose config sets no sandbox, a folder that is not in
 *     codex's `trust_level = "trusted"` list gets the read-only default, and an
 *     approved patch then cannot be written: the turn dies right after the user
 *     says yes. Hearth opens game folders the user never registered with codex,
 *     so that is the NORMAL case here, not an edge one. Omitting these from the
 *     resume alone would reproduce it on every reopened conversation and read
 *     as an intermittent bug rather than a missing parameter.
 *  2. **`ask` is `untrusted`, not `never`-with-prompts.** `untrusted` is what
 *     makes codex raise an approval for anything it does not consider trivially
 *     safe, which is the request Hearth's `ask` mode is making. The sandbox
 *     stays `workspace-write` there for the same reason as in `auto`: the point
 *     is that the user SEES each step, not that an approved step then fails.
 */
export function codexPermissionParams(mode: PermissionMode): {
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
} {
  if (mode === 'ask') return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  if (mode === 'skip') return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
}

/**
 * The `input` array for a `turn/start`, given what the user typed and what
 * they attached.
 *
 * `UserInput` on CODEX_TESTED_VERSION is a five-variant enum — `text`,
 * `image`, `localImage`, `skill`, `mention` — and two of those are exactly
 * what an attachment is. An image already on disk goes as `localImage` with
 * its path, so the bytes never travel through the JSON-RPC pipe; anything else
 * goes as `mention`, which is how codex's own UI hands the model a file it
 * should look at.
 *
 * Attachments come first, then the words, because that is the order the user
 * assembled them in — and the text item is omitted entirely when there is
 * nothing to say, since an empty string reads to a model as a question it was
 * asked to answer.
 */
export function codexInputItems(text: string, attachments: readonly ChatAttachment[]): unknown[] {
  const input: unknown[] = [];
  for (const attachment of attachments) {
    input.push(
      isInlineImage(attachment.mimeType)
        ? { type: 'localImage', path: attachment.path }
        : { type: 'mention', name: attachment.name, path: attachment.path },
    );
  }
  if (text.trim() !== '' || input.length === 0) input.push({ type: 'text', text, text_elements: [] });
  return input;
}

/**
 * The `supportedReasoningEfforts` array of one model row.
 *
 * `ReasoningEffortOption` on CODEX_TESTED_VERSION is
 * `{ reasoningEffort: string, description: string }`, and a real `model/list`
 * for a ChatGPT Plus account returns six of them for GPT-5.6-Sol
 * (`low medium high xhigh max ultra`) and four for GPT-5.4. Absent rather than
 * empty when the model declares none: "this model has no effort dial" and "we
 * don't know its efforts" both mean the same thing to the picker — don't offer
 * one — and neither is a reason to guess.
 */
function codexEfforts(raw: unknown): CodexEffortOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const efforts: CodexEffortOption[] = [];
  for (const entry of raw) {
    const option = asRecord(entry);
    const id = str(option?.reasoningEffort);
    if (!id) continue;
    const description = str(option?.description);
    efforts.push(description ? { id, description } : { id });
  }
  return efforts.length > 0 ? efforts : undefined;
}

/**
 * Read `model/list`'s result into the selector's vocabulary. Hidden models are
 * dropped (codex hides them from its own picker for a reason); everything else
 * the row declares about itself is carried through, because the alternative is
 * a picker that shows six identical rows named "Default".
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
    const description = str(model.description);
    if (description) entry.description = description;
    if (model.isDefault === true) entry.isDefault = true;
    const efforts = codexEfforts(model.supportedReasoningEfforts);
    if (efforts) entry.efforts = efforts;
    const defaultEffort = str(model.defaultReasoningEffort);
    // Only when the model actually accepts it — a default outside the
    // supported set would be a suggestion the picker could not offer.
    if (defaultEffort && efforts?.some((e) => e.id === defaultEffort)) entry.defaultEffort = defaultEffort;
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
