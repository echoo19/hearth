/**
 * The conversation backend.
 *
 * The app's primary surface is a conversation with an agent that builds a game
 * in the project folder. What actually answers is behind one interface —
 * `ChatDriver` — so the UI never learns which agent it is talking to:
 *
 *  - `StubDriver`   — always available. Replies with short guidance on how to
 *                     connect a real agent. This is what runs with no key.
 *  - `AgentSdkDriver` — @anthropic-ai/claude-agent-sdk, running with the
 *                     project folder as its cwd. Resolved at RUNTIME (a
 *                     non-literal import specifier) so the editor typechecks,
 *                     tests, and boots identically whether or not the package
 *                     is installed.
 *  - `CodexDriver`  — OpenAI's `codex app-server` over stdio JSON-RPC (see
 *                     chatDrivers/codex.ts). Authenticated by a ChatGPT sign-in
 *                     or an API key, both held by the codex binary itself.
 *
 * Events are a plain async iterable of `ChatEvent`, which ws.ts forwards over
 * the socket's `chat` channel one frame per event. A driver is per-socket and
 * per-project: `start()` binds it, `send()` queues a turn, `stop()` ends it.
 *
 * The event vocabulary is deliberately PROVIDER-AGNOSTIC. Two very different
 * agents (an Anthropic SDK stream, a Codex JSON-RPC stream) are mapped onto
 * one union here, so the transcript UI renders a command execution, a file
 * change, a subagent or an approval the same way regardless of who is doing
 * the work. Adding a third backend means writing a mapping, not a renderer.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { composeAgentInstructions, hearthFactsPrompt } from './agentFacts.js';
import { isInlineImage, type ChatAttachment } from './chatAttachments.js';
import { hearthPtyEnv } from './hearthShim.js';
import { readPersonalPrompt } from './personalization.js';
import { syncSkillsIntoProject } from './skills.js';

export type { ChatAttachment } from './chatAttachments.js';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/**
 * What a tool call fundamentally IS, for rendering purposes.
 *
 * `skill` is here rather than in a channel of its own because a skill IS a
 * tool call to both backends, and routing it through the existing tool path
 * means it settles, errors and replays by the code that already does that for
 * every other call. What it is NOT is a generic tool: the app asks people to
 * install and curate skills, so "the agent used the one you switched on" has
 * to be visible, and a row titled `Skill` next to `Read` and `Bash` said
 * nothing.
 */
export type ToolKind = 'command' | 'file-change' | 'mcp' | 'web-search' | 'skill' | 'other';

/** How a tool call, or a subagent, finished. */
export type ToolStatus = 'ok' | 'error' | 'declined';

/** The two things an agent can be made to ask permission for. */
export type ApprovalKind = 'command' | 'file-change';

/** The user's answer to an approval request. Provider-neutral on purpose:
 * codex spells these accept/decline, the Agent SDK allow/deny. */
export type ApprovalDecision = 'allow' | 'deny';

export type FileChangeKind = 'edit' | 'create' | 'delete';

/** One file touched by a turn. `diff` is unified-diff text when the backend
 * gives us one; absent is normal, not an error. */
export interface FileChangeEntry {
  path: string;
  kind: FileChangeKind;
  diff?: string;
}

/**
 * One thing that happened in a turn.
 *
 * The union is ADDITIVE: the four v0 members at the bottom are still valid,
 * because they are what is already written into every existing
 * `.hearth/chats/*.jsonl`. Nothing renames them and nothing rewrites those
 * files; instead `normalizeChatEvent` upgrades a legacy event to its
 * canonical equivalent at read time, so replay and the live stream go through
 * one fold. Drivers only ever EMIT canonical events.
 *
 * `turn-complete` ends a turn; `error` also ends it.
 */
export type ChatEvent =
  // --- canonical vocabulary ------------------------------------------------
  /** Agent prose, streamed. */
  | { type: 'message-delta'; text: string }
  /** Visible chain-of-thought summary, streamed. Rendered muted + collapsed. */
  | { type: 'reasoning-delta'; text: string }
  /** A tool call started. `title` is the one-line human summary. */
  | { type: 'tool-begin'; toolId: string; kind: ToolKind; title: string; detail?: string }
  /** Captured stdout/stderr for a running tool call. */
  | { type: 'tool-output-delta'; toolId: string; chunk: string }
  /** A tool call settled. */
  | { type: 'tool-end'; toolId: string; status: ToolStatus; exitCode?: number; summary?: string }
  /** Files the turn changed. Carries `toolId` when it came from one call. */
  | { type: 'file-change'; toolId?: string; files: FileChangeEntry[] }
  /** The turn is BLOCKED until the user answers. */
  | { type: 'approval-request'; approvalId: string; kind: ApprovalKind; title: string; detail: string }
  /** …and the answer, echoed so every window watching the chat agrees. */
  | { type: 'approval-resolved'; approvalId: string; decision: ApprovalDecision }
  /** A nested agent was spawned. */
  | { type: 'subagent-start'; agentId: string; role?: string; title: string }
  | { type: 'subagent-delta'; agentId: string; chunk: string }
  | { type: 'subagent-end'; agentId: string; status: ToolStatus; summary?: string }
  /**
   * The agent's plan for the work, replaced whole each time it changes. Both
   * backends have one — codex streams a `plan` item, the Agent SDK writes a
   * todo list through a tool — and until now neither reached the transcript,
   * which meant the app showed less of what the agent was doing than the
   * terminal it replaced.
   */
  | { type: 'plan-update'; planId: string; text: string }
  /**
   * An image the agent made or looked at, as a path in the project. Rendered,
   * not named: a generated sprite the user cannot see is not a result.
   */
  | { type: 'image'; toolId: string; path: string; caption?: string }
  /**
   * Something happened that isn't an action and isn't prose — the context was
   * compacted, the agent waited, a review mode opened. One quiet line, because
   * these explain later behaviour that would otherwise look like a bug.
   */
  | { type: 'notice'; text: string }
  | { type: 'turn-complete' }
  | { type: 'error'; message: string }
  // --- legacy v0 members, read-only ----------------------------------------
  // Never emitted by a driver any more; still parsed, so a conversation held
  // before the vocabulary was extended replays exactly as it did.
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; id: string; name: string; detail?: string }
  | { type: 'tool-end'; id: string; ok: boolean; detail?: string }
  | { type: 'done' };

/**
 * Upgrade a legacy v0 event to its canonical equivalent; pass a canonical one
 * through untouched. This is the ONE place the old vocabulary is understood,
 * which is what keeps the rest of the server and the whole client on a single
 * set of names.
 *
 * `tool-end` is the only tag carrying two shapes (v0's `{id, ok}` and the
 * canonical `{toolId, status}`), so it is discriminated on the presence of
 * `toolId` rather than on the tag.
 */
export function normalizeChatEvent(event: ChatEvent): ChatEvent {
  switch (event.type) {
    case 'text-delta':
      return { type: 'message-delta', text: event.text };
    case 'tool-start':
      return { type: 'tool-begin', toolId: event.id, kind: 'other', title: event.name, detail: event.detail };
    case 'tool-end':
      if ('toolId' in event) return event;
      return { type: 'tool-end', toolId: event.id, status: event.ok ? 'ok' : 'error', summary: event.detail };
    case 'done':
      return { type: 'turn-complete' };
    default:
      return event;
  }
}

/** True when this event ends the turn it belongs to. */
export function endsTurn(event: ChatEvent): boolean {
  const type = normalizeChatEvent(event).type;
  return type === 'turn-complete' || type === 'error';
}

export type ChatDriverKind = 'stub' | 'agent-sdk' | 'codex';

/** Which vendor answers. Auth for each is configured independently. */
export type ChatProvider = 'anthropic' | 'openai';

/**
 * How hard a reasoning model should think. Only Codex exposes this, and the
 * vocabulary is genuinely OPEN: `ReasoningEffort` in the binary's own
 * `codex app-server generate-ts` output is `string`, and a real `model/list`
 * on CODEX_TESTED_VERSION returns six of them for one model —
 * `low medium high xhigh max ultra` — with the supported set and the default
 * differing per model.
 *
 * So this is not a union. A closed one would silently drop the efforts the
 * user's own account offers, which is the same failure as inventing model ids:
 * the authoritative list comes from the binary, per model, and the picker only
 * ever offers what a model declared.
 */
export type ReasoningEffort = string;

/**
 * Who should answer THIS turn, and how. The composer sends it with every user
 * message, so the choice travels with the turn rather than living in settings.
 *
 * Every field is optional and every driver applies only what it actually
 * supports — a frame with no `agent` at all must behave exactly as it did
 * before this existed, which is what keeps an older client working against a
 * newer server and vice versa.
 */
export interface AgentTurnOptions {
  provider?: ChatProvider;
  /** Wire model id, e.g. `claude-opus-5`. Null/absent = the provider default. */
  model?: string | null;
  effort?: ReasoningEffort | null;
}

/**
 * Is this a plausible effort token? Shape only, never a list of known words:
 * the words are the model's to name (see ReasoningEffort). This exists so a
 * number, an object or a paragraph can't be forwarded to codex as an effort,
 * not to second-guess the catalogue the picker read out of the binary.
 */
const EFFORT_TOKEN = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * Read the `agent` field off a wire frame. Tolerant on purpose: an unknown
 * provider, a non-string model or an unusable effort are dropped rather than
 * failing the turn, and a frame with nothing usable yields null (which every
 * caller treats as "no choice expressed").
 */
export function parseAgentOptions(raw: unknown): AgentTurnOptions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const out: AgentTurnOptions = {};
  if (record.provider === 'anthropic' || record.provider === 'openai') out.provider = record.provider;
  if (typeof record.model === 'string' && record.model.trim() !== '') out.model = record.model.trim();
  if (typeof record.effort === 'string' && EFFORT_TOKEN.test(record.effort.trim())) out.effort = record.effort.trim();
  return Object.keys(out).length > 0 ? out : null;
}

export interface ChatDriver {
  /** Which backend this is, surfaced to the UI so it can name what it's talking to. */
  readonly kind: ChatDriverKind;
  /** Bind the driver to a conversation and a working directory. */
  start(sessionId: string, projectRoot: string): Promise<void>;
  /**
   * Queue one user turn. Events for it arrive on `events`. `agent` carries the
   * per-turn model/effort choice; a driver applies what its backend supports
   * and ignores the rest.
   *
   * `attachments` are files already written into the conversation's folder.
   * Both real backends take images inline and everything else as a path — see
   * `sdkUserContent` here and `codexInputItems` in chatDrivers/codex.ts. `text`
   * may be empty when there is at least one attachment: an image on its own is
   * a message.
   */
  send(text: string, agent?: AgentTurnOptions, attachments?: readonly ChatAttachment[]): void;
  /** Everything the driver emits, in order, until `stop()`. */
  readonly events: AsyncIterable<ChatEvent>;
  /** Tear down: ends `events` and abandons any in-flight turn. */
  stop(): void;
  /**
   * Answer an `approval-request`. Optional: a backend that never asks (the
   * stub) does not implement it.
   */
  approve?(approvalId: string, decision: ApprovalDecision): void;
  /**
   * End the RUNNING TURN but keep the session alive, so the next send
   * continues the same conversation. Optional — a backend without a real
   * interrupt is torn down instead (see ws.ts).
   */
  interrupt?(): void;
}

// ---------------------------------------------------------------------------
// Queue: a push-driven async iterable. Producers call push/close; the consumer
// (ws.ts) does `for await (...)`. Values pushed before anyone iterates are
// buffered, so no event is lost to a late consumer.
// ---------------------------------------------------------------------------

export class EventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const wake = this.waiting.shift();
    if (wake) wake({ value, done: false });
    else this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const wake of this.waiting.splice(0)) wake({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Per-project app settings (.hearth/app.json)
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** Anthropic API key, stored per project. Never sent to the client verbatim. */
  apiKey?: string;
  /** OpenAI API key, handed to the codex binary. Never sent to the client. */
  openaiApiKey?: string;
  /** Which provider answers when both are usable. */
  provider?: ChatProvider;
  /** Absolute path to a `codex` binary, when it isn't on PATH. */
  codexPath?: string;
}

/** Settings fields that are secrets: blanked rather than persisted empty, and
 * never echoed back to the renderer. */
const SECRET_FIELDS = ['apiKey', 'openaiApiKey'] as const;

/** Settings fields that are plain strings and clear when saved blank. */
const BLANKABLE_FIELDS = [...SECRET_FIELDS, 'codexPath'] as const;

export function appSettingsPath(projectRoot: string): string {
  return path.join(projectRoot, '.hearth', 'app.json');
}

export async function readAppSettings(projectRoot: string): Promise<AppSettings> {
  try {
    const raw = await fsp.readFile(appSettingsPath(projectRoot), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as AppSettings;
  } catch {
    /* absent or unreadable: no settings */
  }
  return {};
}

export async function writeAppSettings(projectRoot: string, patch: AppSettings): Promise<AppSettings> {
  const next = { ...(await readAppSettings(projectRoot)), ...patch };
  // An empty string clears a field rather than persisting a useless blank —
  // which is also how the UI removes a stored key.
  for (const field of BLANKABLE_FIELDS) {
    const value = next[field];
    if (value !== undefined && value.trim() === '') delete next[field];
  }
  if (next.provider !== undefined && next.provider !== 'anthropic' && next.provider !== 'openai') {
    delete next.provider;
  }
  const file = appSettingsPath(projectRoot);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // app.json can hold API keys, and projects are ordinary folders a user may
  // put under git at any time. A .gitignore next to the file is the only
  // guard that travels with the folder.
  const ignoreFile = path.join(path.dirname(file), '.gitignore');
  try {
    const existing = await fsp.readFile(ignoreFile, 'utf8').catch(() => null);
    if (existing === null) await fsp.writeFile(ignoreFile, 'app.json\n');
    else if (!existing.split(/\r?\n/).includes('app.json')) {
      await fsp.writeFile(ignoreFile, existing.replace(/\n?$/, '\n') + 'app.json\n');
    }
  } catch {
    // Never let the guard block saving the settings themselves.
  }
  await fsp.writeFile(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** The key to run an agent with: the project's stored one, else the environment's. */
export async function resolveApiKey(projectRoot: string): Promise<string | null> {
  const stored = (await readAppSettings(projectRoot)).apiKey?.trim();
  if (stored) return stored;
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  return env ? env : null;
}

/** The OpenAI key to hand codex, when one is configured here or in the env. */
export async function resolveOpenAiKey(projectRoot: string): Promise<string | null> {
  const stored = (await readAppSettings(projectRoot)).openaiApiKey?.trim();
  if (stored) return stored;
  const env = process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim();
  return env ? env : null;
}

// ---------------------------------------------------------------------------
// StubDriver
// ---------------------------------------------------------------------------

export const STUB_REPLY = [
  'No agent is connected yet, so nothing is building.',
  '',
  'Three ways to connect one:',
  '  1. Set an Anthropic API key in Settings (or export ANTHROPIC_API_KEY before launching).',
  '  2. Sign in with ChatGPT in Settings, if you have the codex CLI installed.',
  '  3. Open the Terminal tab and run your own agent CLI there — it already has the project folder as its working directory.',
].join('\n');

/**
 * The no-key backend. Echoes the same short guidance for every turn, streamed
 * a line at a time so the conversation surface exercises its real streaming
 * path instead of a special-cased one.
 */
export class StubDriver implements ChatDriver {
  readonly kind = 'stub' as const;
  private queue = new EventQueue<ChatEvent>();
  private stopped = false;

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }

  async start(_sessionId: string, _projectRoot: string): Promise<void> {
    /* nothing to bind */
  }

  send(_text: string): void {
    if (this.stopped) return;
    for (const line of STUB_REPLY.split('\n')) {
      this.queue.push({ type: 'message-delta', text: `${line}\n` });
    }
    this.queue.push({ type: 'turn-complete' });
  }

  stop(): void {
    this.stopped = true;
    this.queue.close();
  }
}

// ---------------------------------------------------------------------------
// AgentSdkDriver
// ---------------------------------------------------------------------------

/** The SDK package, resolved at runtime so a missing install is not a build error. */
const AGENT_SDK_SPECIFIER = '@anthropic-ai/claude-agent-sdk';

/**
 * Load the Agent SDK, or null when it isn't installed. The specifier is held
 * in a variable on purpose: a literal would make TypeScript resolve the module
 * at compile time, which fails the editor's typecheck on a machine that hasn't
 * run `npm install` for it yet.
 */
export async function loadAgentSdk(): Promise<{ query: (args: unknown) => AsyncIterable<unknown> } | null> {
  try {
    const specifier: string = AGENT_SDK_SPECIFIER;
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    const query = mod.query ?? (mod.default as Record<string, unknown> | undefined)?.query;
    return typeof query === 'function' ? { query: query as (args: unknown) => AsyncIterable<unknown> } : null;
  } catch {
    return null;
  }
}

/** Narrow an unknown SDK message to the fields this mapping cares about. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * What kind of thing an Agent SDK tool name IS. The SDK's vocabulary is its
 * own; this is the seam that maps it onto the provider-agnostic kinds so a
 * `Bash` call and a codex `commandExecution` render as the same row.
 */
export function sdkToolKind(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'command';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'file-change';
    case 'WebFetch':
    case 'WebSearch':
      return 'web-search';
    // The SDK invokes a skill as an ordinary tool named `Skill`, whose input
    // carries the skill's own name. Established by reading the tool's schema
    // out of the shipped binary, not guessed:
    //   skill: string  "The name of a skill from the available-skills list"
    //   args:  string  optional
    case 'Skill':
      return 'skill';
    default:
      return 'other';
  }
}

/**
 * The skill a `Skill` call names, and the words it was handed. Null for
 * anything else, and for a call whose input arrived without a usable name:
 * "the agent used a skill but we cannot say which" is not worth a row.
 */
export function sdkSkillCall(name: string, input: unknown): { skill: string; args?: string } | null {
  if (name !== 'Skill') return null;
  const record = asRecord(input);
  const skill = record?.skill;
  if (typeof skill !== 'string' || skill.trim() === '') return null;
  const args = record?.args;
  return { skill: skill.trim(), args: typeof args === 'string' && args.trim() !== '' ? args.trim() : undefined };
}

/** Plain-language one-liner for a tool call, e.g. `npm test` for a Bash call. */
export function sdkToolTitle(name: string, input: unknown): string {
  const record = asRecord(input);
  const command = record?.command;
  if (sdkToolKind(name) === 'command' && typeof command === 'string' && command.trim() !== '') return command;
  return sdkSkillCall(name, input)?.skill ?? name;
}

/** The file a file-change tool touched, and whether it created it. */
export function sdkFileChange(name: string, input: unknown): FileChangeEntry | null {
  const record = asRecord(input);
  if (!record) return null;
  const file = record.file_path ?? record.path ?? record.notebook_path;
  if (typeof file !== 'string' || file.trim() === '') return null;
  if (name === 'Write') return { path: file, kind: 'create' };
  const before = record.old_string;
  const after = record.new_string;
  // A minimal, honest diff: the SDK gives us the exact strings being swapped,
  // so render those rather than inventing hunk headers we can't compute.
  const diff =
    typeof before === 'string' && typeof after === 'string'
      ? [
          ...before.split('\n').map((line) => `-${line}`),
          ...after.split('\n').map((line) => `+${line}`),
        ].join('\n')
      : undefined;
  return { path: file, kind: 'edit', diff };
}

/**
 * Map ONE SDK message onto zero or more ChatEvents. Pure and defensive: the
 * SDK's message union is not typed here (it is resolved at runtime), so every
 * field is probed rather than trusted, and an unrecognised shape yields no
 * events instead of throwing mid-stream. Exported for direct unit testing.
 *
 * `Task` tool calls become subagent events rather than tool events: a nested
 * agent is a different thing on screen from a command, and the vocabulary has
 * a shape for it.
 */
export function mapSdkMessage(message: unknown): ChatEvent[] {
  const msg = asRecord(message);
  if (!msg) return [];
  const out: ChatEvent[] = [];

  // Partial text, when the SDK is asked for partial messages.
  if (msg.type === 'stream_event') {
    const event = asRecord(msg.event);
    const delta = asRecord(event?.delta);
    if (event?.type !== 'content_block_delta' || !delta) return out;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      out.push({ type: 'message-delta', text: delta.text });
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      out.push({ type: 'reasoning-delta', text: delta.thinking });
    }
    return out;
  }

  if (msg.type === 'assistant') {
    const inner = asRecord(msg.message);
    const content = Array.isArray(inner?.content) ? inner.content : [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue;
      const { id, name, input } = block as { id: string; name: string; input: unknown };
      // The todo list is the SDK's plan. It arrives as a tool call whose
      // input IS the plan, so it becomes the plan card rather than a tool row
      // nobody would open — the terminal shows this prominently and the app
      // used to show nothing at all.
      if (name === 'TodoWrite') {
        const text = sdkTodoText(input);
        if (text) out.push({ type: 'plan-update', planId: 'todo', text });
        continue;
      }
      if (name === 'Task') {
        const params = asRecord(input);
        const role = typeof params?.subagent_type === 'string' ? params.subagent_type : undefined;
        const title =
          typeof params?.description === 'string' && params.description.trim() !== '' ? params.description : 'Subagent';
        out.push({ type: 'subagent-start', agentId: id, role, title });
        continue;
      }
      // A Skill call whose input never named a skill falls back to a plain
      // tool row: "Used Skill skill" is worse than the generic line it
      // replaced, and the row exists to name the skill or not be there.
      const call = sdkSkillCall(name, input);
      const kind = sdkToolKind(name) === 'skill' && !call ? 'other' : sdkToolKind(name);
      // A skill's detail is what it was ASKED to do. `describeToolInput` would
      // find nothing on a Skill call (its keys are paths, commands and
      // queries), so the row would be unopenable and the arguments lost.
      const detail = kind === 'skill' ? call?.args : describeToolInput(input);
      out.push({ type: 'tool-begin', toolId: id, kind, title: sdkToolTitle(name, input), detail });
      if (kind === 'file-change') {
        const change = sdkFileChange(name, input);
        if (change) out.push({ type: 'file-change', toolId: id, files: [change] });
      }
    }
    return out;
  }

  if (msg.type === 'user') {
    const inner = asRecord(msg.message);
    const content = Array.isArray(inner?.content) ? inner.content : [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const status: ToolStatus = block.is_error === true ? 'error' : 'ok';
      const text = toolResultText(block.content);
      // A subagent's result closes the subagent card, not a tool row. Which of
      // the two this is was decided when the call opened; the id is the link,
      // and emitting both would double-render. `subagent-end` is emitted for
      // ids the driver saw open as a Task (tracked by the driver, not here) —
      // this pure mapper cannot know, so it emits a tool-end and the driver
      // rewrites it. See AgentSdkDriver.pump.
      out.push({ type: 'tool-end', toolId: block.tool_use_id, status, summary: text });
    }
    return out;
  }

  if (msg.type === 'result') {
    if (msg.is_error === true) {
      const text = typeof msg.result === 'string' ? msg.result : 'The agent ended with an error.';
      out.push({ type: 'error', message: text });
    } else {
      out.push({ type: 'turn-complete' });
    }
  }
  return out;
}

/**
 * Render a TodoWrite input as the plan text. Checkbox lines, because that is
 * what a todo list is and it survives being read as plain text.
 */
export function sdkTodoText(input: unknown): string | null {
  const todos = asRecord(input)?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const lines: string[] = [];
  for (const raw of todos) {
    const todo = asRecord(raw);
    const content = todo?.content ?? todo?.activeForm;
    if (typeof content !== 'string' || content.trim() === '') continue;
    const status = typeof todo?.status === 'string' ? todo.status : 'pending';
    const mark = status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]';
    lines.push(`${mark} ${content.trim()}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Flatten a tool_result's content into a short one-line summary. */
function toolResultText(content: unknown): string | undefined {
  const flatten = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(flatten).join('');
    const record = asRecord(value);
    if (record && typeof record.text === 'string') return record.text;
    return '';
  };
  const text = flatten(content).trim();
  if (text === '') return undefined;
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

/**
 * A one-line, human-readable summary of a tool call's input — the file path
 * for file tools, the command for shell tools, else nothing. Never dumps raw
 * JSON at the reader (Hearth's uniform-typed-controls rule applies to the
 * conversation surface too).
 */
export function describeToolInput(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'query']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  }
  return undefined;
}

/**
 * Is this path inside the project folder? The auto-allow tier depends on it,
 * so it is deliberately strict: a relative path is resolved against the root,
 * and anything that climbs out (`../`) fails.
 */
export function isInsideRoot(target: string, projectRoot: string): boolean {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, target);
  if (resolved === root) return true;
  return resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The default approval policy: work inside the open project folder proceeds
 * without interrupting the user (that is the whole point of the app — the
 * agent builds the game, it doesn't ask nine times per file), and anything
 * reaching OUTSIDE the folder becomes a real inline prompt.
 *
 * Pure, so the policy is unit-testable without an SDK. Returns null when the
 * call is auto-allowed, or the approval to raise.
 */
export function sdkApprovalFor(
  toolName: string,
  input: unknown,
  projectRoot: string,
): { kind: ApprovalKind; title: string; detail: string } | null {
  const kind = sdkToolKind(toolName);
  const record = asRecord(input);
  if (kind === 'file-change') {
    const file = record?.file_path ?? record?.path ?? record?.notebook_path;
    if (typeof file === 'string' && !isInsideRoot(file, projectRoot)) {
      return { kind: 'file-change', title: 'Write outside the project folder?', detail: file };
    }
    return null; // acceptEdits, jailed to the folder
  }
  if (kind === 'command') {
    const command = typeof record?.command === 'string' ? record.command : toolName;
    // A command runs with the folder as cwd, but nothing stops it naming an
    // absolute path elsewhere, so the cwd jail is not a real boundary here.
    // Commands that only mention paths inside the folder are the common case
    // and stay quiet; anything else asks.
    return commandLooksContained(command, projectRoot)
      ? null
      : { kind: 'command', title: 'Run this command?', detail: command };
  }
  return null;
}

/**
 * Heuristic: does this shell command stay inside the project folder? Absolute
 * paths that leave the root, and the handful of verbs that reach the wider
 * machine, are what make it ask. Deliberately conservative — a false "ask" is
 * a small interruption, a false "allow" is someone's home directory.
 */
export function commandLooksContained(command: string, projectRoot: string): boolean {
  if (/(^|\s|[;&|])(sudo|ssh|scp|curl|wget|systemctl|launchctl|shutdown|reboot)(\s|$)/.test(command)) return false;
  if (/(^|\s)rm\s+(-[a-z]*\s+)*\//.test(command)) return false;
  for (const match of command.matchAll(/(^|\s)(~?\/[^\s'"|;&]*)/g)) {
    const candidate = match[2].startsWith('~') ? path.join(process.env.HOME ?? '~', match[2].slice(1)) : match[2];
    if (!isInsideRoot(candidate, projectRoot)) return false;
  }
  return true;
}

/**
 * One user turn's content for the Agent SDK, given what was attached.
 *
 * Images the API understands go inline as base64 blocks — that is the only way
 * a model actually SEES a picture. Everything else becomes a line naming its
 * path, because the agent is already sitting in the folder with Read and Bash:
 * pointing at the file is both cheaper and more useful than trying to stuff an
 * archive into the context window. A file that can't be read is announced as
 * such rather than silently dropped; a message that says "here's the sprite"
 * with no sprite is worse than one that says it went missing.
 */
export async function sdkUserContent(
  text: string,
  attachments: readonly ChatAttachment[],
  readFile: (file: string) => Promise<Buffer> = (file) => fsp.readFile(file),
): Promise<unknown[]> {
  const blocks: unknown[] = [];
  for (const attachment of attachments) {
    if (isInlineImage(attachment.mimeType)) {
      try {
        const bytes = await readFile(attachment.path);
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: attachment.mimeType, data: bytes.toString('base64') },
        });
        continue;
      } catch {
        blocks.push({ type: 'text', text: `[attached image could not be read: ${attachment.path}]` });
        continue;
      }
    }
    blocks.push({ type: 'text', text: `Attached file: ${attachment.path}` });
  }
  if (text.trim() !== '') blocks.push({ type: 'text', text });
  return blocks;
}

/**
 * The Anthropic backend. Runs the Agent SDK in streaming-input mode with the
 * project folder as cwd, so everything the agent writes lands in the user's
 * project. `acceptEdits` is the default permission mode: the whole point of
 * the app is that the agent builds the game without a confirmation per file,
 * and the cwd jail keeps that scoped to the open project. Work that reaches
 * outside the folder goes through `canUseTool`, which is the approval seam —
 * it raises an `approval-request` and blocks the turn on the answer.
 */
/**
 * What of Hearth's own tooling this machine can offer a bound agent. Resolved
 * once by the caller that owns tool paths (ws.ts, via resolveToolPaths +
 * ensureHearthShim) and injected, so this module never has to know where
 * bundles live. Absent entirely in tests and degraded setups — the drivers
 * treat that as "no tools", never as an error.
 */
export interface AgentToolAccess {
  /** Directory holding the `hearth`/`hearth-probe` launchers, for PATH. */
  shimDir: string | null;
  /** True when that directory actually contains a working `hearth-probe`. */
  probeCli: boolean;
}

export class AgentSdkDriver implements ChatDriver {
  readonly kind = 'agent-sdk' as const;
  private queue = new EventQueue<ChatEvent>();
  private turns = new EventQueue<unknown>();
  private stopped = false;
  private pump: Promise<void> | null = null;
  private projectRoot = '';
  /** tool_use ids opened as a `Task`, so their result closes a subagent card. */
  private subagents = new Set<string>();
  /** Approvals awaiting an answer from the UI, by approvalId. */
  private pending = new Map<string, (decision: ApprovalDecision) => void>();
  private nextApproval = 0;
  /** Serializes sends that have to read attachments before they can queue. */
  private sends: Promise<void> = Promise.resolve();

  constructor(
    private readonly sdk: { query: (args: unknown) => AsyncIterable<unknown> },
    private readonly apiKey: string,
    /**
     * Model id for this conversation, or null for the SDK's default. Fixed at
     * bind time: the SDK runs ONE long-lived query for the whole session, so
     * its options — model included — are chosen when the stream opens. There
     * is no per-turn surface to change it, and faking one would mean silently
     * restarting the agent mid-conversation.
     */
    private readonly model: string | null = null,
    /** Hearth tooling this machine offers the agent. Null means none. */
    private readonly tools: AgentToolAccess | null = null,
  ) {}

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }

  async start(_sessionId: string, projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    // The SDK discovers skills from the filesystem around its cwd and offers
    // no way to point it elsewhere, so Hearth's skills are mirrored into the
    // folder first. Done per BIND, not per message: this query is long-lived,
    // so a skill switched off mid-conversation is felt by the next one.
    await syncSkillsIntoProject(projectRoot).catch(() => []);
    // The user's standing preferences, read fresh for the same reason the
    // skills are: they are files a person edits while Hearth is running.
    const personal = await readPersonalPrompt();
    // The house facts come first, then the person's own voice — see
    // agentFacts.ts for what is (and deliberately is not) said there.
    const append = composeAgentInstructions(
      hearthFactsPrompt({ probeCli: this.tools?.probeCli === true }),
      personal,
    );
    // The shim dir carries `hearth` and (when present) `hearth-probe`, so the
    // Bash the agent runs finds the same tools the embedded terminal does.
    const env = this.tools?.shimDir
      ? hearthPtyEnv(process.env, this.tools.shimDir)
      : { ...process.env };
    const stream = this.sdk.query({
      prompt: this.turns,
      options: {
        cwd: projectRoot,
        permissionMode: 'acceptEdits',
        includePartialMessages: true,
        env: { ...env, ANTHROPIC_API_KEY: this.apiKey },
        ...(this.model ? { model: this.model } : {}),
        // APPEND to the preset, never replace it. `systemPrompt` also accepts
        // a bare string, and passing one here would substitute a paragraph of
        // house rules for the entire working prompt — the tool instructions
        // included — which reads as "the agent stopped being able to edit
        // files" rather than as a settings bug. The append always carries the
        // house facts; personalization rides after them when set.
        ...(append
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append } }
          : {}),
        canUseTool: (toolName: string, input: unknown) => this.askPermission(toolName, input),
      },
    });
    // One long-lived pump for the whole session: the SDK yields messages for
    // every queued turn on the same stream.
    this.pump = (async () => {
      try {
        for await (const message of stream) {
          if (this.stopped) break;
          for (const event of mapSdkMessage(message)) this.queue.push(this.retarget(event));
        }
      } catch (err) {
        if (!this.stopped) this.queue.push({ type: 'error', message: (err as Error).message });
      }
    })();
  }

  /**
   * `mapSdkMessage` is pure and can't know which tool_use ids were `Task`
   * calls, so it emits a tool event for every result. The driver holds that
   * memory and rewrites those into subagent events here — keeping the mapper
   * testable in isolation while the transcript still gets the right shape.
   */
  private retarget(event: ChatEvent): ChatEvent {
    if (event.type === 'subagent-start') {
      this.subagents.add(event.agentId);
      return event;
    }
    if (event.type === 'tool-end' && 'toolId' in event && this.subagents.has(event.toolId)) {
      this.subagents.delete(event.toolId);
      return { type: 'subagent-end', agentId: event.toolId, status: event.status, summary: event.summary };
    }
    return event;
  }

  /**
   * The SDK's permission callback. Auto-allow inside the project root (the
   * acceptEdits tier), otherwise raise an inline approval and WAIT — the
   * promise this returns is what holds the agent's turn open until the user
   * answers, which is exactly the blocking semantics the transcript shows.
   */
  private askPermission(toolName: string, input: unknown): Promise<unknown> {
    const approval = sdkApprovalFor(toolName, input, this.projectRoot);
    if (!approval || this.stopped) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const approvalId = `a${++this.nextApproval}`;
    this.queue.push({ type: 'approval-request', approvalId, ...approval });
    return new Promise((resolve) => {
      this.pending.set(approvalId, (decision) => {
        this.queue.push({ type: 'approval-resolved', approvalId, decision });
        resolve(
          decision === 'allow'
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'The user declined this.' },
        );
      });
    });
  }

  approve(approvalId: string, decision: ApprovalDecision): void {
    const resolve = this.pending.get(approvalId);
    if (!resolve) return;
    this.pending.delete(approvalId);
    resolve(decision);
  }

  send(text: string, _agent?: AgentTurnOptions, attachments?: readonly ChatAttachment[]): void {
    if (this.stopped) return;
    // EVERY turn goes through the chain, including the ones with nothing
    // attached. Sending the plain ones straight to the queue was the obvious
    // optimisation and it reordered the conversation: a message typed while a
    // few images were still being read off disk reached the model FIRST, so
    // the agent answered the follow-up without the pictures and then found
    // pictures attached to nothing.
    this.sends = this.sends
      .then(async () => {
        const content =
          attachments && attachments.length > 0
            ? await sdkUserContent(text, attachments)
            : // No attachments: a plain string, exactly as this driver has
              // always queued it.
              text;
        if (!this.stopped) this.turns.push({ type: 'user', message: { role: 'user', content } });
      })
      .catch((err: Error) => {
        if (!this.stopped) this.queue.push({ type: 'error', message: err.message });
      });
  }

  stop(): void {
    this.stopped = true;
    // Anything still blocking the agent is answered `deny`, so the SDK's own
    // turn unwinds instead of hanging on a promise nobody will settle.
    for (const [, resolve] of this.pending) resolve('deny');
    this.pending.clear();
    this.turns.close();
    this.queue.close();
    this.pump = null;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Pick the driver for a project.
 *
 * An explicit `provider` wins when that provider is actually usable;
 * otherwise whichever one is configured answers, and with neither the stub
 * explains how to connect one. Never throws — a broken agent backend degrades
 * to guidance rather than an unusable conversation column.
 *
 * The turn's own `agent.provider` outranks the stored preference: the composer
 * shows the user which model they picked, so that pick has to be what binds.
 * When it isn't usable the fall-through still applies, so choosing a provider
 * you've since signed out of quietly lands on the other one rather than
 * failing the turn.
 *
 * `deps` is a test seam so driver selection can be exercised without a real
 * SDK install or a real codex binary on the machine.
 */
export async function createChatDriver(
  projectRoot: string,
  options?: {
    /** The codex thread this conversation already had, for `thread/resume`. */
    resumeThreadId?: string | null;
    /** Called with the thread codex bound, so it can be persisted. */
    onThreadId?: (threadId: string) => void;
    /** The turn that is binding this driver, when it expressed a choice. */
    agent?: AgentTurnOptions | null;
    /** Hearth tooling on this machine (shim dir + probe), from ws.ts. */
    tools?: AgentToolAccess | null;
    loadAgentSdk?: typeof loadAgentSdk;
    createCodexDriver?: (
      projectRoot: string,
      opts?: {
        resumeThreadId?: string | null;
        onThreadId?: (threadId: string) => void;
        agent?: AgentTurnOptions | null;
        tools?: AgentToolAccess | null;
      },
    ) => Promise<ChatDriver | null>;
  },
): Promise<ChatDriver> {
  const settings = await readAppSettings(projectRoot);
  const loadSdk = options?.loadAgentSdk ?? loadAgentSdk;
  const makeCodex =
    options?.createCodexDriver ??
    (async (
      root: string,
      opts?: {
        resumeThreadId?: string | null;
        onThreadId?: (threadId: string) => void;
        agent?: AgentTurnOptions | null;
        tools?: AgentToolAccess | null;
      },
    ) => {
      // Imported lazily so a project that never uses OpenAI never pays for
      // resolving the module (and so this file stays free of node:child_process).
      const mod = await import('./chatDrivers/codex.js');
      return mod.createCodexDriver(root, opts);
    });

  const agent = options?.agent ?? null;
  const anthropic = async (): Promise<ChatDriver | null> => {
    const key = await resolveApiKey(projectRoot);
    if (!key) return null;
    const sdk = await loadSdk();
    // Only an anthropic-targeted choice names an anthropic model; a codex
    // model id must never reach the SDK.
    const model = agent && (agent.provider ?? 'anthropic') === 'anthropic' ? (agent.model ?? null) : null;
    return sdk ? new AgentSdkDriver(sdk, key, model, options?.tools ?? null) : null;
  };
  const openai = async (): Promise<ChatDriver | null> => {
    try {
      return await makeCodex(projectRoot, {
        resumeThreadId: options?.resumeThreadId ?? null,
        onThreadId: options?.onThreadId,
        agent,
        tools: options?.tools ?? null,
      });
    } catch {
      return null;
    }
  };

  const preferred = agent?.provider ?? settings.provider;
  const order: (() => Promise<ChatDriver | null>)[] =
    preferred === 'openai' ? [openai, anthropic] : [anthropic, openai];
  for (const attempt of order) {
    const driver = await attempt();
    if (driver) return driver;
  }
  return new StubDriver();
}
