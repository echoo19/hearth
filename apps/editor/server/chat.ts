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
 * Those are the backends the conversation offers, and deliberately all of them:
 * any other agent is run by the person in the embedded terminal, where it has
 * the same folder and the same shell without Hearth pretending to describe a
 * program it does not know.
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
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from './permissionMode.js';
import { readPersonalPrompt } from './personalization.js';
import { projectShellEnv } from './shellEnv.js';
import { syncSkillsIntoProject } from './skills.js';

export type { ChatAttachment } from './chatAttachments.js';
export type { PermissionMode } from './permissionMode.js';

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

/**
 * How an approval can END UP, which is a wider question than how a person can
 * answer one. `withdrawn` is written when the resolution came from a teardown —
 * the session was stopped, the backend died, the turn was interrupted — and
 * not from anyone pressing a button. Teardowns used to write `deny`, which
 * forged a decision: a transcript reread later said "Denied" about a question
 * that was simply never answered, and the difference matters to somebody
 * working out why the agent skipped a step. The backend underneath still gets
 * a deny either way (nothing may run on a question nobody answered); only the
 * RECORD tells the two apart. Old transcripts hold only allow/deny and render
 * exactly as they always did.
 */
export type ApprovalResolution = ApprovalDecision | 'withdrawn';

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

export interface InputQuestion {
  id: string;
  label: string;
  type: 'choice' | 'text' | 'number' | 'boolean' | 'url';
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  multiple?: boolean;
  allowOther?: boolean;
  options?: InputOption[];
  min?: number;
  max?: number;
}

export interface InputResponse {
  action: InputAction;
  answers?: Record<string, InputAnswer>;
}

export interface InputExternalAction {
  type: 'open-url';
  url: string;
  elicitationId: string;
}

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
  /**
   * The end of one piece of prose, carrying no text of its own.
   *
   * A turn is not one long answer. Backends emit several separate messages
   * across it, and the deltas that stream them say nothing about where one
   * stops. Appending blind glues the next message's first character onto the
   * previous message's last one, which is how a transcript ends up reading
   * "a visual game/UI task.Some of what we're working on" with the sentence
   * boundary eaten. Worse than the missing space, the whole turn arrives as
   * one undifferentiated wall instead of the paragraphs it was written as.
   */
  | { type: 'message-end' }
  /** Visible chain-of-thought summary, streamed. Rendered muted + collapsed. */
  | { type: 'reasoning-delta'; text: string }
  /** A tool call started. `title` is the one-line human summary. */
  | {
      type: 'tool-begin';
      toolId: string;
      kind: ToolKind;
      title: string;
      detail?: string;
    }
  /** Captured stdout/stderr for a running tool call. */
  | { type: 'tool-output-delta'; toolId: string; chunk: string }
  /** A tool call settled. */
  | {
      type: 'tool-end';
      toolId: string;
      status: ToolStatus;
      exitCode?: number;
      summary?: string;
    }
  /** Files the turn changed. Carries `toolId` when it came from one call. */
  | { type: 'file-change'; toolId?: string; files: FileChangeEntry[] }
  /** The turn is BLOCKED until the user answers. */
  | {
      type: 'approval-request';
      approvalId: string;
      kind: ApprovalKind;
      title: string;
      detail: string;
      choices?: ApprovalChoice[];
    }
  /** …and the answer, echoed so every window watching the chat agrees. A
   * `withdrawn` resolution is a teardown speaking, not a person — see
   * ApprovalResolution. */
  | {
      type: 'approval-resolved';
      approvalId: string;
      decision: ApprovalResolution;
    }
  /** The agent needs information, not permission to act. */
  | {
      type: 'input-request';
      inputId: string;
      title?: string;
      description?: string;
      questions: InputQuestion[];
      allowCancel?: boolean;
      timeoutMs?: number;
      externalAction?: InputExternalAction;
    }
  /** Values are deliberately absent: project transcripts may be public. */
  | { type: 'input-resolved'; inputId: string; action: InputResolution }
  /** A nested agent was spawned. */
  | { type: 'subagent-start'; agentId: string; role?: string; title: string }
  | { type: 'subagent-delta'; agentId: string; chunk: string }
  | {
      type: 'subagent-end';
      agentId: string;
      status: ToolStatus;
      summary?: string;
    }
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
      return {
        type: 'tool-begin',
        toolId: event.id,
        kind: 'other',
        title: event.name,
        detail: event.detail,
      };
    case 'tool-end':
      if ('toolId' in event) return event;
      return {
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

/** True when this event ends the turn it belongs to. */
export function endsTurn(event: ChatEvent): boolean {
  const type = normalizeChatEvent(event).type;
  return type === 'turn-complete' || type === 'error';
}

/** Which backend answered. */
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
 * The efforts the Agent SDK accepts, which unlike codex's IS a closed set:
 * `EffortLevel` in the installed sdk.d.ts is
 * `'low' | 'medium' | 'high' | 'xhigh' | 'max'`, and `applyFlagSettings` is
 * typed against exactly that.
 *
 * Held here rather than in claudeModels.ts because both ends of the feature
 * need the same five words — the catalogue decides which of them a model is
 * OFFERED, and the driver decides which of them may be SENT — and two copies
 * of a vocabulary drift the first time one grows.
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/**
 * Is this a word the SDK would accept? Checked rather than forwarded, because
 * the effort on a turn is whatever the composer had selected: a stored codex
 * effort (`ultra` is a real one) surviving a switch to Claude would otherwise
 * be handed to a backend that refuses it, and the turn would fail for a reason
 * the user could not have predicted.
 */
export function isClaudeEffort(value: unknown): value is ClaudeEffortLevel {
  return typeof value === 'string' && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

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

/**
 * One slash command the ACTIVE agent actually offers.
 *
 * Read from the agent, never invented. The two agents have genuinely different
 * vocabularies and Hearth does not paper over that: Claude Code answers
 * `supportedCommands()` with its full list, and codex has no slash commands in
 * its protocol at all (they are a feature of its TUI, which Hearth does not
 * run), so its menu is assembled from `skills/list` plus the few acts its
 * app-server really exposes. A command Hearth cannot honour is not offered.
 *
 * THE LIST IS NOT STATIC, which is the whole reason it is fetched rather than
 * hardcoded. Plugins grant skills, and skills appear as slash commands, so the
 * set changes while a session is open: Claude pushes a full replacement list
 * (`commands_changed`) and codex pushes an invalidation (`SkillsChanged`) that
 * means re-read. A menu built once at connect time would go stale the first
 * time somebody installed a plugin.
 */
export interface SlashCommandInfo {
  /** The word after the slash, e.g. `compact`. Never carries the slash. */
  name: string;
  description: string;
  /** What the command expects after it, e.g. `<file>`. */
  argumentHint?: string;
  /** Other names that resolve to this one, e.g. /cost and /stats for /usage. */
  aliases?: string[];
  /**
   * Where it came from. Skills are grouped apart from an agent's built-ins
   * because they are the user's own material and the ones a plugin adds.
   */
  source: 'builtin' | 'skill';
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
  /**
   * Everything the driver emits, in order, until `stop()` or until the backend
   * goes away. It ENDS either way: a driver that can no longer answer must end
   * its stream, because that is the only signal ws.ts has that the conversation
   * needs a fresh backend. See `dead`.
   */
  readonly events: AsyncIterable<ChatEvent>;
  /** Tear down: ends `events` and abandons any in-flight turn. */
  stop(): void;
  /**
   * Settles once the provider process/stream has actually closed after stop.
   * Teardowns that transfer ownership (notably Continue in CLI) wait for this
   * instead of assuming a synchronous `stop()` means the child is gone.
   */
  readonly closed?: Promise<void>;
  /**
   * True once this driver can no longer answer, so `send()` would be a no-op.
   *
   * Optional, and absent reads as alive: a driver with nothing to lose (the
   * stub) has no way to die. ws.ts checks it before handing a turn to a session
   * it already holds. The drain loop retires a dead session on its own, but
   * that runs a tick after the backend went away and a person can type inside
   * that tick, and a message lost to it is lost for good.
   */
  readonly dead?: boolean;
  /**
   * The slash commands this backend actually offers, right now.
   *
   * Optional, because "none" is a real answer and a driver with no command
   * vocabulary should not have to pretend otherwise. Asked fresh rather than
   * cached by the caller: plugins grant skills, skills appear as slash
   * commands, and both backends can gain them while a session is open.
   */
  commands?(): Promise<SlashCommandInfo[]>;
  /**
   * Subscribe to a provider-side command catalogue replacement/invalidation.
   *
   * The callback receives the replacement when the provider supplied one,
   * otherwise no value means re-read `commands()`. This stays out of
   * `ChatEvent`: command discovery is live UI state, not conversation history.
   */
  onCommandsChanged?(listener: (commands?: SlashCommandInfo[]) => void): () => void;
  /**
   * Run one command returned by `commands()`. Drivers keep provider-specific
   * syntax here: Claude receives `/name`, while Codex skills use `$name` and
   * app-server actions such as compact/review are real RPCs.
   */
  invokeCommand?(name: string, args?: string): void;
  /**
   * Answer an `approval-request`. Optional: a backend that never asks (the
   * stub) does not implement it.
   */
  approve?(approvalId: string, decision: ApprovalDecision, choiceId?: string): void;
  /** Answer a blocking provider question or MCP elicitation. */
  answerInput?(inputId: string, response: InputResponse): void;
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

  /**
   * Put a value back at the FRONT of the queue.
   *
   * This exists for exactly one consumer: a query attempt that was abandoned
   * with a turn already in flight (see AgentSdkDriver.promptFeed). The turn
   * was taken off the queue but never delivered, so it goes back ahead of
   * anything typed since — the order people wrote things in is the order the
   * agent must read them. It still wakes a waiting consumer, because the
   * retry's own read may already be parked in `waiting` and a value dropped
   * into the buffer would otherwise sit there with nothing left to wake it.
   */
  requeue(value: T): void {
    if (this.closed) return;
    const wake = this.waiting.shift();
    if (wake) wake({ value, done: false });
    else this.buffer.unshift(value);
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
  /** Absolute path to the user's Claude Code binary, when it isn't on PATH. */
  claudePath?: string;
}

/** Settings fields that are secrets: blanked rather than persisted empty, and
 * never echoed back to the renderer. */
const SECRET_FIELDS = ['apiKey', 'openaiApiKey'] as const;

/** Settings fields that are plain strings and clear when saved blank. */
const BLANKABLE_FIELDS = [...SECRET_FIELDS, 'codexPath', 'claudePath'] as const;

export async function resolveClaudeExecutable(projectRoot: string, override?: string): Promise<string | null> {
  const explicit = override?.trim();
  if (explicit) {
    try {
      await fsp.access(explicit, 1);
      return explicit;
    } catch {
      return null;
    }
  }
  const env = await projectShellEnv(projectRoot);
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try {
      await fsp.access(candidate, 1);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

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
  '  1. Sign in to Claude Code, and Hearth answers on that account. An Anthropic API key in Settings works too.',
  '  2. Sign in with ChatGPT in Settings, if you have the codex CLI installed.',
  '  3. Open a new terminal from the sidebar and run any agent there. It starts in this project folder.',
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
export async function loadAgentSdk(): Promise<{
  query: (args: unknown) => AsyncIterable<unknown>;
} | null> {
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
  return {
    skill: skill.trim(),
    args: typeof args === 'string' && args.trim() !== '' ? args.trim() : undefined,
  };
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
      ? [...before.split('\n').map((line) => `-${line}`), ...after.split('\n').map((line) => `+${line}`)].join('\n')
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

  if (msg.type === 'system') {
    const taskId =
      typeof msg.tool_use_id === 'string' && msg.tool_use_id !== ''
        ? msg.tool_use_id
        : typeof msg.task_id === 'string'
          ? msg.task_id
          : '';
    const description =
      typeof msg.description === 'string' && msg.description.trim() !== '' ? msg.description.trim() : 'Background task';
    const summary = typeof msg.summary === 'string' && msg.summary.trim() !== '' ? msg.summary.trim() : undefined;
    if (msg.subtype === 'task_started' && taskId && msg.skip_transcript !== true) {
      if (typeof msg.subagent_type === 'string' && msg.subagent_type.trim() !== '') {
        out.push({
          type: 'subagent-start',
          agentId: taskId,
          role: msg.subagent_type,
          title: description,
        });
      } else {
        const workflow =
          typeof msg.workflow_name === 'string' && msg.workflow_name.trim() !== '' ? msg.workflow_name.trim() : undefined;
        out.push({
          type: 'tool-begin',
          toolId: taskId,
          kind: 'other',
          title: description,
          detail: workflow ? `Workflow: ${workflow}` : undefined,
        });
      }
      return out;
    }
    if (msg.subtype === 'task_progress' && taskId) {
      const chunk = summary ?? description;
      if (typeof msg.subagent_type === 'string' && msg.subagent_type.trim() !== '') {
        out.push({ type: 'subagent-delta', agentId: taskId, chunk });
      } else {
        out.push({ type: 'tool-output-delta', toolId: taskId, chunk });
      }
      return out;
    }
    if (msg.subtype === 'task_notification' && taskId && msg.skip_transcript !== true) {
      const status: ToolStatus =
        msg.status === 'completed' ? 'ok' : msg.status === 'stopped' ? 'declined' : 'error';
      out.push({ type: 'tool-end', toolId: taskId, status, summary });
      return out;
    }
    if (msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
      const tasks = msg.tasks
        .map((raw) => asRecord(raw)?.description)
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        .map((value) => value.trim());
      out.push({
        type: 'notice',
        text:
          tasks.length === 0
            ? 'Background work finished.'
            : `Background work running: ${tasks.join(', ')}`,
      });
      return out;
    }
    if (msg.subtype === 'compact_boundary') {
      const metadata = asRecord(msg.compact_metadata);
      const trigger = metadata?.trigger === 'manual' ? ' manually' : '';
      const before = typeof metadata?.pre_tokens === 'number' ? metadata.pre_tokens : null;
      const after = typeof metadata?.post_tokens === 'number' ? metadata.post_tokens : null;
      const counts = before !== null && after !== null ? ` (${before} → ${after} tokens)` : '';
      out.push({ type: 'notice', text: `Claude compacted the conversation${trigger}${counts}.` });
      return out;
    }
  }

  if (msg.type === 'prompt_suggestion' && typeof msg.suggestion === 'string' && msg.suggestion.trim() !== '') {
    out.push({ type: 'notice', text: `Suggested next prompt: ${msg.suggestion.trim()}` });
    return out;
  }

  // Partial text, when the SDK is asked for partial messages.
  if (msg.type === 'stream_event') {
    const event = asRecord(msg.event);
    const delta = asRecord(event?.delta);
    if (event?.type !== 'content_block_delta' || !delta) return out;
    const parentId =
      typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id !== ''
        ? msg.parent_tool_use_id
        : typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id !== ''
          ? event.parent_tool_use_id
          : null;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      out.push(
        parentId
          ? { type: 'subagent-delta', agentId: parentId, chunk: delta.text }
          : { type: 'message-delta', text: delta.text },
      );
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      out.push(
        parentId
          ? { type: 'subagent-delta', agentId: parentId, chunk: delta.thinking }
          : { type: 'reasoning-delta', text: delta.thinking },
      );
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
      const { id, name, input } = block as {
        id: string;
        name: string;
        input: unknown;
      };
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
      out.push({
        type: 'tool-begin',
        toolId: id,
        kind,
        title: sdkToolTitle(name, input),
        detail,
      });
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
      out.push({
        type: 'tool-end',
        toolId: block.tool_use_id,
        status,
        summary: text,
      });
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
 * The SDK's own `permissionMode` for a Hearth mode.
 *
 * Verified against the installed binary's `--help` on the Agent SDK this app
 * ships with: `acceptEdits`, `bypassPermissions`, `default` and `plan` are all
 * accepted. Pure and separate from the policy below because the two are not the
 * same lever: this one decides what the SDK decides on its own, the other
 * decides what Hearth asks about. They have to agree, and they only agree if
 * they are read side by side.
 */
export function sdkPermissionMode(mode: PermissionMode): 'default' | 'acceptEdits' | 'bypassPermissions' {
  if (mode === 'ask') return 'default';
  if (mode === 'skip') return 'bypassPermissions';
  return 'acceptEdits';
}

/**
 * The approval policy, given the mode the user chose for this project.
 *
 *  - `auto` (the default) is what Hearth has always done: work inside the open
 *    project folder proceeds without interrupting the user (that is the whole
 *    point of the app, the agent builds the game and doesn't ask nine times per
 *    file), and anything reaching OUTSIDE the folder becomes a real inline
 *    prompt.
 *  - `ask` drops the inside-the-folder exemption. Every file change and every
 *    command is raised, wherever it points.
 *  - `skip` never raises anything, which is the whole promise of the mode. The
 *    SDK is also in `bypassPermissions`, so in practice this callback is barely
 *    consulted; returning null anyway means the two levers cannot disagree.
 *
 * `ask` raises for commands and file changes, and for MCP tool calls, which it
 * raises AS commands: an `mcp__*` tool is somebody else's code doing
 * who-knows-what to whatever the server behind it reaches, and a mode that
 * promises "every command asks" cannot quietly wave those through — they used
 * to return null here and auto-pass even in `ask`. They ride the `command`
 * kind rather than a new one because `ApprovalKind` is the vocabulary the
 * transcript and the client are built on, and widening it is a contract change
 * for both halves of the app, not a policy tweak — which is also why a read or
 * a web search still has no kind to be raised as.
 *
 * Pure, so the policy is unit-testable without an SDK. Returns null when the
 * call is auto-allowed, or the approval to raise.
 */
export function sdkApprovalFor(
  toolName: string,
  input: unknown,
  projectRoot: string,
  mode: PermissionMode = DEFAULT_PERMISSION_MODE,
): { kind: ApprovalKind; title: string; detail: string } | null {
  if (mode === 'skip') return null;
  const kind = sdkToolKind(toolName);
  const record = asRecord(input);
  if (kind === 'file-change') {
    const file = record?.file_path ?? record?.path ?? record?.notebook_path;
    if (typeof file === 'string' && !isInsideRoot(file, projectRoot)) {
      return {
        kind: 'file-change',
        title: 'Write outside the project folder?',
        detail: file,
      };
    }
    if (mode === 'ask') {
      return {
        kind: 'file-change',
        title: 'Write this file?',
        detail: typeof file === 'string' ? file : toolName,
      };
    }
    return null; // acceptEdits, jailed to the folder
  }
  if (kind === 'command') {
    const command = typeof record?.command === 'string' ? record.command : toolName;
    // A command runs with the folder as cwd, but nothing stops it naming an
    // absolute path elsewhere, so the cwd jail is not a real boundary here.
    // Commands that only mention paths inside the folder are the common case
    // and stay quiet; anything else asks.
    return mode === 'ask' || !commandLooksContained(command, projectRoot)
      ? { kind: 'command', title: 'Run this command?', detail: command }
      : null;
  }
  if (kind === 'mcp') {
    // Only `ask` raises these. `auto` keeps its long-standing behaviour (MCP
    // servers are things the user wired up on purpose, and Hearth's own tools
    // arrive this way), and `skip` was answered at the top. The title names
    // the tool because "Run this command?" over an opaque payload is not a
    // question anyone can answer — the mcp__server__tool name is the one
    // thing the user can recognise.
    if (mode === 'ask') {
      return {
        kind: 'command',
        title: `Use ${toolName}?`,
        detail: describeToolInput(input) ?? toolName,
      };
    }
    return null;
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
          source: {
            type: 'base64',
            media_type: attachment.mimeType,
            data: bytes.toString('base64'),
          },
        });
        continue;
      } catch {
        blocks.push({
          type: 'text',
          text: `[attached image could not be read: ${attachment.path}]`,
        });
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
 * project. The project's permission mode sets two things that have to agree:
 * the SDK's own `permissionMode` (see `sdkPermissionMode`) and what Hearth
 * raises through `canUseTool`, which is the approval seam. `auto`, the default,
 * runs `acceptEdits`: the whole point of the app is that the agent builds the
 * game without a confirmation per file, and the cwd jail keeps that scoped to
 * the open project. Work that reaches outside the folder raises an
 * `approval-request` and blocks the turn on the answer.
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

/**
 * What the conversation is told when the SDK's stream ends on its own. The
 * cause is not knowable from here (the subprocess exiting is all we see), so
 * this says what happened and what to do rather than guessing why.
 */
export const SDK_EXITED_MESSAGE =
  'The Anthropic agent stopped without finishing. Your next message starts a fresh one.';

/**
 * What the conversation is told when a remembered Claude session would not
 * resume and the driver fell back to a fresh one. Said out loud because the
 * transcript on screen still reads as one continuous conversation while the
 * agent's own memory of it is gone — an agent that silently lost its context
 * reads as one lying about the conversation it was in.
 */
export const CLAUDE_RESUME_FAILED_NOTICE =
  'Claude could not pick up where it left off, so it is starting fresh. The transcript is still here, but the agent no longer remembers the earlier conversation.';

/**
 * The half of the SDK's query handle Hearth actually calls.
 *
 * Structural rather than imported: `loadAgentSdk` resolves the package at
 * runtime and this file deliberately never takes a compile-time dependency on
 * it (see AGENT_SDK_SPECIFIER). `supportedCommands` is optional because an
 * older installed SDK will not have it, and a missing method must read as "no
 * commands" rather than throwing inside a menu.
 */
interface SdkQueryHandle extends AsyncIterable<unknown> {
  supportedCommands?(): Promise<unknown>;
  /**
   * Ends the RUNNING TURN without ending the session — the SDK's own Stop
   * (sdk.d.ts: `Query.interrupt()`, a control request on the live query).
   * Optional for the same reason `supportedCommands` is: an older installed
   * SDK may predate it, and a missing method must fall back to the coarse
   * teardown rather than throw into the Stop button.
   */
  interrupt?(): Promise<unknown>;
  /**
   * Merges into the SDK's flag settings layer mid-session, which is the only
   * surface that changes the effort of a query that is already running. Null
   * clears a key back to the user's own settings; `undefined` is dropped by
   * JSON serialization and does nothing at all, which is why the driver is
   * careful to send the null.
   */
  applyFlagSettings?(settings: { effortLevel: ClaudeEffortLevel | null }): Promise<unknown>;
}

/**
 * One SDK command, in Hearth's words.
 *
 * Everything is checked rather than trusted. This crosses a process boundary
 * from a binary the user installed and can upgrade underneath us, and a menu
 * row built from a missing `name` would be a slash with nothing after it.
 */
export function sdkSlashCommands(raw: unknown): SlashCommandInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashCommandInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (name === '') continue;
    const hint = typeof record.argumentHint === 'string' ? record.argumentHint.trim() : '';
    const aliases = Array.isArray(record.aliases)
      ? record.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
      : [];
    out.push({
      // The SDK's own field says "without the leading slash", but it costs
      // nothing to be sure: two slashes in a menu row is the kind of thing
      // nobody notices until it is in a screenshot.
      name: name.replace(/^\/+/, ''),
      description: typeof record.description === 'string' ? record.description : '',
      ...(hint !== '' ? { argumentHint: hint } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      // The SDK does not separate its built-ins from skills, and guessing from
      // the name would be a rule that breaks the first time somebody writes a
      // skill called `review`. Everything it reports is offered as a command.
      source: 'builtin',
    });
  }
  return out;
}

interface PendingInput {
  answer(response: InputResponse): void;
  withdraw(): void;
}

interface ElicitationField {
  question: InputQuestion;
  path: string[];
  json: boolean;
  choices?: (string | number | boolean)[];
}

function pointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function schemaType(schema: Record<string, unknown>): string | null {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    return schema.type.find((type): type is string => typeof type === 'string' && type !== 'null') ?? null;
  }
  return null;
}

/**
 * Flatten an MCP elicitation's JSON Schema into Hearth's typed controls.
 *
 * MCP form schemas are ordinary JSON Schema and may contain nested objects.
 * The renderer intentionally has no generic object editor, so object
 * properties become JSON-pointer-labelled primitive fields and are rebuilt
 * before the response goes back to the server. Unsupported leaf shapes retain
 * full fidelity through a JSON text field instead of being dropped.
 */
function elicitationFields(schemaValue: unknown): ElicitationField[] {
  const root = asRecord(schemaValue);
  if (!root) return [];
  const fields: ElicitationField[] = [];
  const walk = (schema: Record<string, unknown>, fieldPath: string[], required: boolean): void => {
    const type = schemaType(schema);
    const properties = asRecord(schema.properties);
    if ((type === 'object' || properties) && properties) {
      const requiredNames = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((name): name is string => typeof name === 'string')
          : [],
      );
      for (const [name, raw] of Object.entries(properties)) {
        const child = asRecord(raw);
        if (child) walk(child, [...fieldPath, name], required && requiredNames.has(name));
      }
      return;
    }

    const id = `/${fieldPath.map(pointerSegment).join('/')}`;
    const label =
      typeof schema.title === 'string' && schema.title.trim() !== ''
        ? schema.title
        : (fieldPath[fieldPath.length - 1] ?? 'Response');
    const description = typeof schema.description === 'string' ? schema.description : undefined;
    const enumValues = Array.isArray(schema.enum)
      ? schema.enum.filter((value): value is string | number | boolean =>
          ['string', 'number', 'boolean'].includes(typeof value),
        )
      : [];
    const itemSchema = asRecord(schema.items);
    const itemEnum = Array.isArray(itemSchema?.enum)
      ? itemSchema.enum.filter((value): value is string | number | boolean =>
          ['string', 'number', 'boolean'].includes(typeof value),
        )
      : [];
    let question: InputQuestion;
    let json = false;
    let choices: (string | number | boolean)[] | undefined;
    if (enumValues.length > 0) {
      choices = enumValues;
      question = {
        id,
        label,
        type: 'choice',
        required,
        options: enumValues.map((value) => ({
          value: String(value),
          label: String(value),
        })),
      };
    } else if (type === 'array' && itemEnum.length > 0) {
      choices = itemEnum;
      question = {
        id,
        label,
        type: 'choice',
        required,
        multiple: true,
        options: itemEnum.map((value) => ({
          value: String(value),
          label: String(value),
        })),
      };
    } else if (type === 'boolean') {
      question = { id, label, type: 'boolean', required };
    } else if (type === 'number' || type === 'integer') {
      question = {
        id,
        label,
        type: 'number',
        required,
        ...(typeof schema.minimum === 'number' ? { min: schema.minimum } : {}),
        ...(typeof schema.maximum === 'number' ? { max: schema.maximum } : {}),
      };
    } else if (type === 'string' || type === null) {
      const format = typeof schema.format === 'string' ? schema.format : '';
      question = {
        id,
        label,
        type: format === 'uri' || format === 'url' || format === 'uri-reference' ? 'url' : 'text',
        required,
        ...(format === 'password' || schema.writeOnly === true ? { secret: true } : {}),
        ...(description ? { placeholder: description } : {}),
      };
    } else {
      json = true;
      question = {
        id,
        label,
        type: 'text',
        required,
        placeholder: description ?? 'JSON',
      };
    }
    fields.push({ question, path: fieldPath, json, choices });
  };

  const rootProperties = asRecord(root.properties);
  if (rootProperties) {
    const requiredNames = new Set(
      Array.isArray(root.required) ? root.required.filter((name): name is string => typeof name === 'string') : [],
    );
    for (const [name, raw] of Object.entries(rootProperties)) {
      const child = asRecord(raw);
      if (child) walk(child, [name], requiredNames.has(name));
    }
  } else {
    walk(root, [], true);
  }
  return fields;
}

function setNestedValue(target: Record<string, unknown>, pathParts: readonly string[], value: unknown): void {
  if (pathParts.length === 0) {
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(target, value);
    return;
  }
  let cursor = target;
  for (const part of pathParts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[pathParts[pathParts.length - 1]] = value;
}

export class AgentSdkDriver implements ChatDriver {
  readonly kind = 'agent-sdk' as const;
  private queue = new EventQueue<ChatEvent>();
  private turns = new EventQueue<unknown>();
  private stopped = false;
  /** Set once the pump has ended, whatever ended it. Backs `dead`. */
  private finished = false;
  private pump: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  /** The live query handle, for control requests like `supportedCommands`. */
  private stream: SdkQueryHandle | null = null;
  private projectRoot = '';
  /** tool_use ids opened as a `Task`, so their result closes a subagent card. */
  private subagents = new Set<string>();
  /** Live menu listeners. Command changes are UI state, never transcript rows. */
  private commandListeners = new Set<(commands?: SlashCommandInfo[]) => void>();
  private latestCommands: SlashCommandInfo[] | null = null;
  /**
   * Approvals awaiting an answer from the UI, by approvalId. Each entry can
   * settle two ways, and the transcript tells them apart: `answer` is a
   * person deciding, `withdraw` is the session going away underneath the
   * question. Both unblock the SDK (a withdrawal denies the call — nothing may
   * run on a question nobody answered), but only `answer` records a decision
   * anyone actually made. See ApprovalResolution.
   */
  private pending = new Map<
    string,
    { answer: (decision: ApprovalDecision, choiceId?: string) => void; withdraw: () => void }
  >();
  private nextApproval = 0;
  /** Provider questions and MCP elicitations, kept separate from permissions. */
  private pendingInputs = new Map<string, PendingInput>();
  private nextInput = 0;
  /**
   * The session id the SDK last named for this conversation. Seeded with the
   * one this driver was asked to resume, so a resume that succeeds (the init
   * message echoes the same id) is not re-persisted on every bind; a fresh or
   * fallen-back session announces a different one, and `captureSessionId`
   * hands that to the caller to remember.
   */
  private sessionId: string | null = null;
  /** Serializes sends that have to read attachments before they can queue. */
  private sends: Promise<void> = Promise.resolve();
  /**
   * The effort the session is currently running at, as far as this driver
   * knows. Held so a turn that expresses none can CLEAR one an earlier turn
   * set: `applyFlagSettings` is a merge into a layer that outlives the turn, so
   * without this an effort chosen once would quietly apply to the rest of the
   * conversation.
   */
  private effort: ClaudeEffortLevel | null = null;

  constructor(
    private readonly sdk: { query: (args: unknown) => AsyncIterable<unknown> },
    /**
     * An API key to answer with, or null to let the CLI underneath use
     * whatever the person is already signed into. Null is the ordinary case
     * on a machine with Claude Code on it.
     */
    private readonly apiKey: string | null,
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
    /**
     * How much this project's agent may do without asking. Fixed at bind time
     * for the same reason the model is: `permissionMode` is a `query()` option,
     * and this driver runs ONE query for the whole session. Changing the mode
     * mid-conversation therefore means rebinding, which is what ws.ts does.
     */
    private readonly permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
    /**
     * The Claude session this conversation already IS, when the SDK has
     * answered it before. The codex thread id's twin (see chatStore's
     * `claudeSessionId` and CodexDriver's `resumeThreadId`): the CLI persists
     * every session under ~/.claude and `query({options: {resume}})` reloads
     * one, so reopening a chat continues the agent's own memory instead of
     * handing a stranger the transcript. Null is a fresh conversation.
     */
    private readonly resumeSessionId: string | null = null,
    /**
     * Called with the session id the SDK binds (from its init message), so
     * the caller can persist it against the chat — the `onThreadId` seam,
     * mirrored for this backend.
     */
    private readonly onSessionId: (sessionId: string) => void = () => undefined,
    /** Prefer the user's installed CLI so its workflows/plugins/features survive. */
    private readonly claudeExecutable: string | null = null,
  ) {
    this.sessionId = resumeSessionId;
  }

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }

  get dead(): boolean {
    return this.finished;
  }

  get closed(): Promise<void> {
    return this.pump ?? Promise.resolve();
  }

  async start(_sessionId: string, projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    // The SDK discovers skills from the filesystem around its cwd and offers
    // no way to point it elsewhere, so Hearth's skills are mirrored into the
    // folder first. Done per BIND, not per message: this query is long-lived,
    // so a skill switched off mid-conversation is felt by the next one.
    const mirroredSkills = await syncSkillsIntoProject(projectRoot).catch(() => []);
    // The user's standing preferences, read fresh for the same reason the
    // skills are: they are files a person edits while Hearth is running.
    const personal = await readPersonalPrompt();
    // The house facts come first, then the person's own voice — see
    // agentFacts.ts for what is (and deliberately is not) said there.
    const append = composeAgentInstructions(
      hearthFactsPrompt({
        probeCli: this.tools?.probeCli === true,
        skills: mirroredSkills.length > 0,
      }),
      personal,
    );
    // The base env is the login-shell-merged one, never raw process.env. The
    // packaged app is launched from Finder, so this process inherits the
    // minimal system PATH — and the Bash the agent runs inherits it in turn,
    // which made `node`, `npm` and `git` installed via nvm or homebrew
    // invisible to the agent even though they work in the embedded terminal.
    // Same problem the pty path and the codex spawn already solve, solved the
    // same way (see shellEnv.ts). Never throws; a shell that won't answer
    // degrades to process.env.
    const baseEnv = await projectShellEnv(projectRoot);
    // The shim dir carries `hearth` and (when present) `hearth-probe`, so the
    // Bash the agent runs finds the same tools the embedded terminal does.
    const env = this.tools?.shimDir ? hearthPtyEnv(baseEnv, this.tools.shimDir) : { ...baseEnv };
    const abortController = new AbortController();
    this.abortController = abortController;
    const open = (resume: string | null): SdkQueryHandle =>
      this.sdk.query({
        // A per-attempt view of the turn queue, never the queue itself: a
        // query the SDK abandons must not close (or swallow from) the queue a
        // resume-fallback retry still has to read. See promptFeed.
        prompt: this.promptFeed(),
        options: {
          cwd: projectRoot,
          abortController,
          permissionMode: sdkPermissionMode(this.permissionMode),
          ...(this.permissionMode === 'skip' ? { allowDangerouslySkipPermissions: true } : {}),
          includePartialMessages: true,
          // Match the native Claude Code session's durable and observable
          // behavior. These are additive SDK switches: unknown lifecycle
          // events remain safely ignored by mapSdkMessage, while the session
          // itself keeps checkpoints and complete subagent activity.
          enableFileCheckpointing: true,
          includeHookEvents: true,
          forwardSubagentText: true,
          promptSuggestions: true,
          // Keep Claude Code's own user/project/local configuration surface:
          // CLAUDE.md, plugins, hooks, dynamic workflows and feature flags
          // (including ultracode) must behave as they do in the standalone CLI.
          settingSources: ['user', 'project', 'local'],
          ...(this.claudeExecutable ? { pathToClaudeCodeExecutable: this.claudeExecutable } : {}),
          // The key is ADDED when there is one and left out entirely when there
          // is not. Passing an empty ANTHROPIC_API_KEY is not the same as
          // passing none: it overrides the CLI's own credentials with a key that
          // cannot authenticate, which turns "answer on my subscription" into an
          // auth failure.
          env: this.apiKey ? { ...env, ANTHROPIC_API_KEY: this.apiKey } : env,
          ...(this.model ? { model: this.model } : {}),
          // Continue the session the SDK already holds for this conversation.
          // `resume` loads its persisted history (sdk.d.ts), so a reopened
          // chat keeps the agent's own memory — the same promise codex's
          // `thread/resume` makes next door.
          ...(resume ? { resume } : {}),
          // APPEND to the preset, never replace it. `systemPrompt` also accepts
          // a bare string, and passing one here would substitute a paragraph of
          // house rules for the entire working prompt — the tool instructions
          // included — which reads as "the agent stopped being able to edit
          // files" rather than as a settings bug. The append always carries the
          // house facts; personalization rides after them when set.
          ...(append
            ? {
                systemPrompt: {
                  type: 'preset' as const,
                  preset: 'claude_code' as const,
                  append,
                },
              }
            : {}),
          canUseTool: (
            toolName: string,
            input: unknown,
            options?: { suggestions?: unknown[]; signal?: AbortSignal },
          ) => this.askPermission(toolName, input, options),
          onElicitation: (request: unknown, options: { signal: AbortSignal }) =>
            this.askElicitation(request, options.signal),
        },
      });
    // One long-lived pump for the whole session: the SDK yields messages for
    // every queued turn on the same stream.
    //
    // Ending it ALWAYS ends the event stream, and it says why first. The pump
    // used to do neither, and the SDK's generator RETURNS as readily as it
    // throws: its subprocess exiting cleanly (which is what an auth failure the
    // SDK handles internally looks like from here) pushed no error and closed
    // nothing, so ws.ts's drain sat on `queue.next()` forever. The session
    // therefore never reached a cleanup path, `send()` kept pushing turns into
    // `this.turns` with nothing on the other end, and the window spun on a turn
    // that was never coming. A driver that cannot answer has to say so.
    this.pump = (async () => {
      // The session tried first is the remembered one. A resume the CLI
      // refuses (its session file pruned, a chat copied to another machine)
      // must not strand the conversation, so ONE retry drops back to a fresh
      // session — never a dead chat. The stale stored id heals itself: the
      // fresh session's init message names its own id and captureSessionId
      // persists that over the old one.
      let resume = this.resumeSessionId;
      try {
        for (;;) {
          const stream = open(resume);
          // Held so `commands()` and `interrupt()` talk to the live session.
          // The handle is the same object the pump iterates; both are control
          // requests on it, not a second connection.
          this.stream = stream;
          let sawMessage = false;
          let failure: Error | null = null;
          try {
            for await (const message of stream) {
              if (this.stopped) break;
              sawMessage = true;
              this.captureSessionId(message);
              this.captureCommandsChanged(message);
              for (const event of mapSdkMessage(message)) {
                const retargeted = this.retarget(event);
                if (retargeted) this.queue.push(retargeted);
              }
            }
          } catch (err) {
            failure = err as Error;
          }
          if (this.stopped) return;
          // The stream ended before saying ANYTHING, against a remembered
          // session: that is what a failed resume looks like from out here
          // (the CLI exits without ever sending its init). Retry fresh, and
          // say so — the transcript on screen still reads as one continuous
          // conversation, and an agent that silently lost its memory of it
          // reads as one lying about the conversation it was in.
          if (!sawMessage && resume) {
            resume = null;
            this.queue.push({
              type: 'notice',
              text: CLAUDE_RESUME_FAILED_NOTICE,
            });
            continue;
          }
          if (failure) {
            this.queue.push({ type: 'error', message: failure.message });
          } else {
            // Returned rather than threw, and nobody asked it to stop: the
            // backend is gone. Reported as an error because that is what it is
            // to the person waiting, and because an error is what ends the
            // turn.
            this.queue.push({ type: 'error', message: SDK_EXITED_MESSAGE });
          }
          return;
        }
      } finally {
        this.finished = true;
        this.abortController = null;
        this.stream = null;
        // Nothing will read queued turns again, and nothing will emit again.
        this.turns.close();
        this.queue.close();
      }
    })();
  }

  /**
   * Remember which Claude session this conversation IS, read off the init
   * message the SDK opens every session with (sdk.d.ts: `system`/`init`
   * carries `session_id`, resumable later via `query({options: {resume}})`).
   * Only a CHANGED id is handed back: a successful resume echoes the id that
   * was asked for, and re-persisting it on every bind would rewrite the chat
   * index for nothing.
   */
  private captureSessionId(message: unknown): void {
    const msg = asRecord(message);
    if (msg?.type !== 'system' || msg.subtype !== 'init') return;
    const sessionId = msg.session_id;
    if (typeof sessionId !== 'string' || sessionId === '' || sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.onSessionId(sessionId);
  }

  private captureCommandsChanged(message: unknown): void {
    const msg = asRecord(message);
    if (msg?.type !== 'system' || msg.subtype !== 'commands_changed') return;
    const commands = sdkSlashCommands(msg.commands);
    this.latestCommands = commands;
    for (const listener of this.commandListeners) listener(commands);
  }

  /**
   * A view of the turn queue for ONE query attempt.
   *
   * The SDK iterates its prompt with `for await`, and a `for await` that exits
   * abruptly (the subprocess died, a resume the CLI refused) calls `return()`
   * on the iterator it was handed — which on EventQueue means `close()`. The
   * queue has to outlive the attempt: a failed resume is retried against a
   * fresh session, and the retry reads the SAME queue, or every turn typed
   * during the first attempt is silently gone. So each attempt gets a view
   * that (a) never propagates `return()` to the shared queue, and (b) puts a
   * value back at the front if one was already in flight when the attempt was
   * abandoned, so the retry delivers it instead of losing it.
   */
  private promptFeed(): AsyncIterable<unknown> {
    const queue = this.turns;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => {
        const inner = queue[Symbol.asyncIterator]();
        let abandoned = false;
        return {
          next: (): Promise<IteratorResult<unknown>> => {
            if (abandoned) return Promise.resolve({ value: undefined as never, done: true });
            return inner.next().then((result) => {
              if (!abandoned || result.done) return result;
              queue.requeue(result.value);
              return { value: undefined as never, done: true };
            });
          },
          return: (): Promise<IteratorResult<unknown>> => {
            abandoned = true;
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }

  /**
   * `mapSdkMessage` is pure and can't know which tool_use ids were `Task`
   * calls, so it emits a tool event for every result. The driver holds that
   * memory and rewrites those into subagent events here — keeping the mapper
   * testable in isolation while the transcript still gets the right shape.
   */
  private retarget(event: ChatEvent): ChatEvent | null {
    if (event.type === 'subagent-start') {
      // `Task` first appears as an assistant tool_use and can later be echoed
      // by the SDK's task_started lifecycle stream. They describe one task.
      if (this.subagents.has(event.agentId)) return null;
      this.subagents.add(event.agentId);
      return event;
    }
    if (event.type === 'tool-begin' && this.subagents.has(event.toolId)) {
      return null;
    }
    if (event.type === 'tool-end' && 'toolId' in event && this.subagents.has(event.toolId)) {
      this.subagents.delete(event.toolId);
      return {
        type: 'subagent-end',
        agentId: event.toolId,
        status: event.status,
        summary: event.summary,
      };
    }
    if (event.type === 'tool-output-delta' && this.subagents.has(event.toolId)) {
      return { type: 'subagent-delta', agentId: event.toolId, chunk: event.chunk };
    }
    return event;
  }

  /**
   * The SDK's permission callback. Auto-allow inside the project root (the
   * acceptEdits tier), otherwise raise an inline approval and WAIT — the
   * promise this returns is what holds the agent's turn open until the user
   * answers, which is exactly the blocking semantics the transcript shows.
   */
  private askPermission(
    toolName: string,
    input: unknown,
    options?: { suggestions?: unknown[]; signal?: AbortSignal },
  ): Promise<unknown> {
    // Asking for information is not a permission check. In particular,
    // bypassPermissions must never auto-answer it: skip mode means "do the
    // work without approvals", not "invent answers on the user's behalf".
    if (toolName === 'AskUserQuestion') return this.askUserQuestion(input);
    const approval = sdkApprovalFor(toolName, input, this.projectRoot, this.permissionMode);
    if (!approval || this.stopped) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const approvalId = `a${++this.nextApproval}`;
    const suggestions = Array.isArray(options?.suggestions) ? options.suggestions : [];
    this.queue.push({
      type: 'approval-request',
      approvalId,
      ...approval,
      ...(suggestions.length > 0
        ? {
            choices: [
              { id: 'allow-once', label: 'Allow once', tone: 'allow' as const },
              { id: 'allow-remember', label: 'Allow and remember', tone: 'allow' as const },
              { id: 'deny', label: 'Deny', tone: 'deny' as const },
            ],
          }
        : {}),
    });
    return new Promise((resolve) => {
      this.pending.set(approvalId, {
        answer: (decision, choiceId) => {
          this.queue.push({ type: 'approval-resolved', approvalId, decision });
          resolve(
            decision === 'allow'
              ? {
                  behavior: 'allow',
                  updatedInput: input,
                  ...(choiceId === 'allow-remember' ? { updatedPermissions: suggestions } : {}),
                }
              : { behavior: 'deny', message: 'The user declined this.' },
          );
        },
        // A withdrawal is NOT a decision. The SDK still gets a deny — nothing
        // may run on a question nobody answered — but the transcript records
        // that the session ended under the question, not that the user
        // refused it. See ApprovalResolution.
        withdraw: () => {
          this.queue.push({
            type: 'approval-resolved',
            approvalId,
            decision: 'withdrawn',
          });
          resolve({
            behavior: 'deny',
            message: 'The session ended before the user answered.',
          });
        },
      });
    });
  }

  private askUserQuestion(input: unknown): Promise<unknown> {
    const record = asRecord(input);
    const rawQuestions = Array.isArray(record?.questions) ? record.questions : [];
    const source: { text: string; id: string }[] = [];
    const questions: InputQuestion[] = [];
    for (const raw of rawQuestions) {
      const question = asRecord(raw);
      const text = typeof question?.question === 'string' ? question.question.trim() : '';
      if (text === '') continue;
      const id = `q${questions.length}`;
      const options = Array.isArray(question?.options)
        ? question.options.flatMap((rawOption) => {
            const option = asRecord(rawOption);
            const label = typeof option?.label === 'string' ? option.label.trim() : '';
            if (label === '') return [];
            return [
              {
                value: label,
                label,
                ...(typeof option?.description === 'string' ? { description: option.description } : {}),
              },
            ];
          })
        : [];
      questions.push({
        id,
        label: text,
        type: options.length > 0 ? 'choice' : 'text',
        required: true,
        ...(options.length > 0 ? { options, allowOther: true } : {}),
        ...(question?.multiSelect === true ? { multiple: true } : {}),
      });
      source.push({ text, id });
    }
    if (this.stopped || questions.length === 0) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'The question could not be displayed.',
      });
    }

    const inputId = `i${++this.nextInput}`;
    this.queue.push({
      type: 'input-request',
      inputId,
      title: 'Claude needs your input',
      questions,
      allowCancel: true,
    });
    return new Promise((resolve) => {
      this.pendingInputs.set(inputId, {
        answer: (response) => {
          this.queue.push({
            type: 'input-resolved',
            inputId,
            action: response.action,
          });
          if (response.action === 'cancel') {
            resolve({
              behavior: 'deny',
              message: 'The user cancelled this question.',
            });
            return;
          }
          const answers: Record<string, string> = {};
          for (const item of source) {
            const answer = response.answers?.[item.id];
            if (answer === undefined) continue;
            answers[item.text] = Array.isArray(answer) ? answer.join(', ') : String(answer);
          }
          resolve({ behavior: 'allow', updatedInput: { ...record, answers } });
        },
        withdraw: () => {
          this.queue.push({
            type: 'input-resolved',
            inputId,
            action: 'withdrawn',
          });
          resolve({
            behavior: 'deny',
            message: 'The session ended before the user answered.',
          });
        },
      });
    });
  }

  private askElicitation(requestValue: unknown, signal: AbortSignal): Promise<unknown> {
    const request = asRecord(requestValue);
    const mode = request?.mode === 'url' ? 'url' : 'form';
    const serverName =
      typeof request?.serverName === 'string' && request.serverName.trim() !== '' ? request.serverName : 'MCP server';
    const message = typeof request?.message === 'string' ? request.message : '';
    if (this.stopped) return Promise.resolve({ action: 'cancel' });

    const inputId = `i${++this.nextInput}`;
    const fields = mode === 'form' ? elicitationFields(request?.requestedSchema) : [];
    const questions: InputQuestion[] =
      mode === 'url'
        ? [
            {
              id: 'confirmed',
              label: 'I completed authorization',
              type: 'boolean',
              required: true,
            },
          ]
        : fields.map((field) => field.question);
    if (questions.length === 0) {
      return Promise.resolve({ action: 'decline' });
    }
    const url = typeof request?.url === 'string' ? request.url : '';
    const elicitationId = typeof request?.elicitationId === 'string' ? request.elicitationId : '';
    let externalAction: InputExternalAction | undefined;
    if (mode === 'url' && url && elicitationId) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          externalAction = { type: 'open-url', url: parsed.toString(), elicitationId };
        }
      } catch {
        /* malformed provider URLs are displayed as text, never opened */
      }
    }
    this.queue.push({
      type: 'input-request',
      inputId,
      title:
        typeof request?.title === 'string' && request.title.trim() !== ''
          ? request.title
          : typeof request?.displayName === 'string' && request.displayName.trim() !== ''
            ? request.displayName
            : serverName,
      description: mode === 'url' && url ? [message, url].filter(Boolean).join('\n') : message,
      questions,
      allowCancel: true,
      ...(externalAction ? { externalAction } : {}),
    });

    return new Promise((resolve) => {
      const onAbort = (): void => this.withdrawInput(inputId);
      signal.addEventListener('abort', onAbort, { once: true });
      const clean = (): void => signal.removeEventListener('abort', onAbort);
      this.pendingInputs.set(inputId, {
        answer: (response) => {
          clean();
          this.queue.push({
            type: 'input-resolved',
            inputId,
            action: response.action,
          });
          if (response.action === 'cancel') {
            resolve({ action: 'cancel' });
            return;
          }
          if (mode === 'url') {
            resolve(response.answers?.confirmed === true ? { action: 'accept' } : { action: 'decline' });
            return;
          }
          const content: Record<string, unknown> = {};
          for (const field of fields) {
            const raw = response.answers?.[field.question.id];
            if (raw === undefined) continue;
            let value: unknown = raw;
            if (field.choices) {
              const restore = (entry: string): string | number | boolean =>
                field.choices?.find((choice) => String(choice) === entry) ?? entry;
              value = Array.isArray(raw) ? raw.map(restore) : restore(String(raw));
            } else if (field.json && typeof raw === 'string') {
              try {
                value = JSON.parse(raw);
              } catch {
                value = raw;
              }
            }
            setNestedValue(content, field.path, value);
          }
          resolve({ action: 'accept', content });
        },
        withdraw: () => {
          clean();
          this.queue.push({
            type: 'input-resolved',
            inputId,
            action: 'withdrawn',
          });
          resolve({ action: 'cancel' });
        },
      });
      if (signal.aborted) this.withdrawInput(inputId);
    });
  }

  answerInput(inputId: string, response: InputResponse): void {
    const pending = this.pendingInputs.get(inputId);
    if (!pending) return;
    this.pendingInputs.delete(inputId);
    pending.answer(response);
  }

  private withdrawInput(inputId: string): void {
    const pending = this.pendingInputs.get(inputId);
    if (!pending) return;
    this.pendingInputs.delete(inputId);
    pending.withdraw();
  }

  /**
   * Ask the live session. Never throws into the menu: an older SDK without the
   * method, a control request that times out, or a backend already gone all
   * mean the same thing to a composer trying to draw a list, and that is an
   * empty one.
   */
  async commands(): Promise<SlashCommandInfo[]> {
    if (this.latestCommands) return this.latestCommands;
    const handle = this.stream;
    if (!handle?.supportedCommands) return [];
    try {
      return sdkSlashCommands(await handle.supportedCommands());
    } catch {
      return [];
    }
  }

  onCommandsChanged(listener: (commands?: SlashCommandInfo[]) => void): () => void {
    this.commandListeners.add(listener);
    if (this.latestCommands) queueMicrotask(() => {
      if (this.commandListeners.has(listener) && this.latestCommands) listener(this.latestCommands);
    });
    return () => this.commandListeners.delete(listener);
  }

  invokeCommand(name: string, args = ''): void {
    const command = name.replace(/^\/+/, '').trim();
    if (!command) return;
    this.send(`/${command}${args.trim() ? ` ${args.trim()}` : ''}`);
  }

  approve(approvalId: string, decision: ApprovalDecision, choiceId?: string): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;
    this.pending.delete(approvalId);
    pending.answer(decision, choiceId);
  }

  /**
   * Withdraw everything still blocking the agent: each callback resolves as a
   * deny so the SDK's own turn unwinds instead of hanging on a promise nobody
   * will settle, and every window is told the question is moot — as
   * `withdrawn`, never as a Deny the user did not press.
   */
  private withdrawPending(): void {
    for (const [, pending] of this.pending) pending.withdraw();
    this.pending.clear();
    for (const [, pending] of this.pendingInputs) pending.withdraw();
    this.pendingInputs.clear();
  }

  /**
   * End the RUNNING TURN, keep the session — what Stop should mean. The SDK's
   * `interrupt()` is a control request on the live query: the stream stays
   * open, and the next send continues the same conversation with its memory
   * intact. This driver used to have no interrupt at all, so ws.ts fell back
   * to tearing the whole backend down, and every Stop on a Claude chat cost
   * the agent everything it had in context.
   *
   * Anything blocking on an approval is withdrawn first: the interrupt ends
   * the turn the question belonged to, and the SDK's own abort is waiting on
   * the same callback.
   */
  interrupt(): void {
    if (this.stopped) return;
    const handle = this.stream;
    if (handle?.interrupt) {
      this.withdrawPending();
      void handle.interrupt().catch(() => {
        /* the turn keeps running; Stop stays available, and so does teardown */
      });
      return;
    }
    // No live handle, or an installed SDK too old to have the method: the
    // coarse teardown is the only honest stop left. The turn is reported over
    // FIRST (withdrawals ahead of it — the client stops applying events to an
    // ended turn), then the stream ends, which is what makes ws.ts retire the
    // session so the next send binds afresh. The same shape ws.ts itself
    // takes for a driver with no interrupt at all.
    this.withdrawPending();
    this.queue.push({ type: 'turn-complete' });
    this.stop();
  }

  /**
   * Put this turn's effort on the session before the turn goes out.
   *
   * The model is fixed when the stream opens (see the constructor), but the
   * effort is not: `applyFlagSettings` merges into a settings layer on the
   * LIVE query, which is the SDK's own answer to changing it mid-session.
   *
   * Three things this is careful about, each of them a way the naive version
   * breaks a turn:
   *
   *  - **Only the five words the SDK names.** A codex effort (`ultra`) or junk
   *    is dropped rather than forwarded — see isClaudeEffort.
   *  - **No effort CLEARS a previous one**, with an explicit null. The layer
   *    persists, so "the user turned the dial back to Automatic" has to be
   *    said out loud or the last choice sticks for the session.
   *  - **It never throws into the turn.** An older SDK without the method or a
   *    control request that fails means the turn runs at whatever effort the
   *    session already had, which is a far better outcome than a message that
   *    was never sent.
   */
  private async applyEffort(requested: ReasoningEffort | null | undefined): Promise<void> {
    const handle = this.stream;
    if (!handle?.applyFlagSettings) return;
    const wanted = isClaudeEffort(requested) ? requested : null;
    if (wanted === this.effort) return;
    try {
      await handle.applyFlagSettings({ effortLevel: wanted });
      // Recorded only once the backend took it, so a failed call is retried by
      // the next turn rather than remembered as applied.
      this.effort = wanted;
    } catch {
      /* the session keeps the effort it had */
    }
  }

  send(text: string, agent?: AgentTurnOptions, attachments?: readonly ChatAttachment[]): void {
    if (this.stopped) return;
    // EVERY turn goes through the chain, including the ones with nothing
    // attached. Sending the plain ones straight to the queue was the obvious
    // optimisation and it reordered the conversation: a message typed while a
    // few images were still being read off disk reached the model FIRST, so
    // the agent answered the follow-up without the pictures and then found
    // pictures attached to nothing.
    this.sends = this.sends
      .then(async () => {
        // Inside the same chain as the queueing below, so the effort is on the
        // session BEFORE the turn it belongs to is pushed. Applying it outside
        // would race the turn it was chosen for.
        await this.applyEffort(agent?.effort ?? null);
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
    if (this.stopped) return;
    this.stopped = true;
    this.finished = true;
    // Anything still blocking the agent is withdrawn: the SDK's own turn
    // unwinds (each callback resolves as a deny) and the transcript records a
    // teardown rather than a Deny nobody pressed.
    this.withdrawPending();
    this.turns.close();
    this.abortController?.abort();
    // Withdrawals were queued first, so readers still receive them. Closing
    // here also makes teardown observable when a malformed/test query ignores
    // AbortSignal forever; `closed` remains pending in that case, and an
    // ownership transfer refuses to resume the same provider session.
    this.queue.close();
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Pick the driver for a project.
 *
 * An explicit `provider` wins when that provider is actually usable; otherwise
 * whichever one is configured answers, and with neither the stub explains how
 * to connect one. This never throws: a broken vendor backend degrades to
 * guidance rather than an unusable conversation column.
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
    /**
     * The Claude session this conversation already had, for the Agent SDK's
     * `resume`. The codex pair above, mirrored for the other backend — each
     * driver reads only its own and ignores the other's.
     */
    resumeSessionId?: string | null;
    /** Called with the session the Agent SDK bound, so it can be persisted. */
    onSessionId?: (sessionId: string) => void;
    /** The turn that is binding this driver, when it expressed a choice. */
    agent?: AgentTurnOptions | null;
    /** Hearth tooling on this machine (shim dir + probe), from ws.ts. */
    tools?: AgentToolAccess | null;
    /**
     * How much this project's agent may do without asking. Read by the caller
     * (ws.ts) at bind time rather than here, because the same caller is what
     * has to notice a change and rebind: both backends fix the policy when the
     * session opens, so a driver that read it itself would still be wrong the
     * moment the user moved the switch.
     */
    permissionMode?: PermissionMode | null;
    loadAgentSdk?: typeof loadAgentSdk;
    createCodexDriver?: (
      projectRoot: string,
      opts?: {
        resumeThreadId?: string | null;
        onThreadId?: (threadId: string) => void;
        agent?: AgentTurnOptions | null;
        tools?: AgentToolAccess | null;
        permissionMode?: PermissionMode | null;
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
        permissionMode?: PermissionMode | null;
      },
    ) => {
      // Imported lazily so a project that never uses OpenAI never pays for
      // resolving the module (and so this file stays free of node:child_process).
      const mod = await import('./chatDrivers/codex.js');
      return mod.createCodexDriver(root, opts);
    });

  const agent = options?.agent ?? null;
  // One mode for whichever backend answers: the user chose how much the AGENT
  // may do, not how much this vendor's agent may do, so the fall-through below
  // must not be able to change the answer.
  const permissionMode = options?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const anthropic = async (): Promise<ChatDriver | null> => {
    // A key is an OPTION here, not a requirement, and treating it as one is
    // why Claude read "Not set up" on machines that had been talking to Claude
    // all day. The SDK runs the Claude Code CLI, and that CLI authenticates
    // with whatever the person already signed into: given no key it reports
    // `apiKeySource: "none"` and answers on their subscription, exactly as
    // ChatGPT answers through codex's own sign-in. Refusing to bind without a
    // key made Hearth demand a paid API key for an agent the person was
    // already entitled to use, and the "Set up in Settings" row said so.
    //
    // Binding is still not a promise that it will answer. A machine with
    // neither a key nor a login fails at the first turn with the CLI's own
    // words, which names the real problem better than a backend that silently
    // was not there.
    const key = await resolveApiKey(projectRoot);
    const sdk = await loadSdk();
    const claudeExecutable = await resolveClaudeExecutable(projectRoot, settings.claudePath);
    // Only an anthropic-targeted choice names an anthropic model; a codex
    // model id must never reach the SDK.
    const model = agent && (agent.provider ?? 'anthropic') === 'anthropic' ? (agent.model ?? null) : null;
    return sdk
      ? new AgentSdkDriver(
          sdk,
          key,
          model,
          options?.tools ?? null,
          permissionMode,
          options?.resumeSessionId ?? null,
          options?.onSessionId,
          claudeExecutable,
        )
      : null;
  };
  const openai = async (): Promise<ChatDriver | null> => {
    try {
      return await makeCodex(projectRoot, {
        resumeThreadId: options?.resumeThreadId ?? null,
        onThreadId: options?.onThreadId,
        agent,
        tools: options?.tools ?? null,
        permissionMode,
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
