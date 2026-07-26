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
 *
 * Events are a plain async iterable of `ChatEvent`, which ws.ts forwards over
 * the socket's `chat` channel one frame per event. A driver is per-socket and
 * per-project: `start()` binds it, `send()` queues a turn, `stop()` ends it.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One thing that happened in a turn. `done` ends a turn; `error` also ends it. */
export type ChatEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; id: string; name: string; detail?: string }
  | { type: 'tool-end'; id: string; ok: boolean; detail?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type ChatDriverKind = 'stub' | 'agent-sdk';

export interface ChatDriver {
  /** Which backend this is, surfaced to the UI so it can name what it's talking to. */
  readonly kind: ChatDriverKind;
  /** Bind the driver to a conversation and a working directory. */
  start(sessionId: string, projectRoot: string): Promise<void>;
  /** Queue one user turn. Events for it arrive on `events`. */
  send(text: string): void;
  /** Everything the driver emits, in order, until `stop()`. */
  readonly events: AsyncIterable<ChatEvent>;
  /** Tear down: ends `events` and abandons any in-flight turn. */
  stop(): void;
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
  // An empty string clears the key rather than persisting a useless blank.
  if (next.apiKey !== undefined && next.apiKey.trim() === '') delete next.apiKey;
  const file = appSettingsPath(projectRoot);
  await fsp.mkdir(path.dirname(file), { recursive: true });
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

// ---------------------------------------------------------------------------
// StubDriver
// ---------------------------------------------------------------------------

export const STUB_REPLY = [
  'No agent is connected yet, so nothing is building.',
  '',
  'Two ways to connect one:',
  '  1. Set an Anthropic API key in Settings (or export ANTHROPIC_API_KEY before launching).',
  '  2. Open the Terminal tab and run your own agent CLI there — it already has the project folder as its working directory.',
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
      this.queue.push({ type: 'text-delta', text: `${line}\n` });
    }
    this.queue.push({ type: 'done' });
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
 * Map ONE SDK message onto zero or more ChatEvents. Pure and defensive: the
 * SDK's message union is not typed here (it is resolved at runtime), so every
 * field is probed rather than trusted, and an unrecognised shape yields no
 * events instead of throwing mid-stream. Exported for direct unit testing.
 */
export function mapSdkMessage(message: unknown): ChatEvent[] {
  const msg = asRecord(message);
  if (!msg) return [];
  const out: ChatEvent[] = [];

  // Partial text, when the SDK is asked for partial messages.
  if (msg.type === 'stream_event') {
    const event = asRecord(msg.event);
    const delta = asRecord(event?.delta);
    if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      out.push({ type: 'text-delta', text: delta.text });
    }
    return out;
  }

  if (msg.type === 'assistant') {
    const inner = asRecord(msg.message);
    const content = Array.isArray(inner?.content) ? inner.content : [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        out.push({ type: 'tool-start', id: block.id, name: block.name, detail: describeToolInput(block.input) });
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
      out.push({ type: 'tool-end', id: block.tool_use_id, ok: block.is_error !== true });
    }
    return out;
  }

  if (msg.type === 'result') {
    if (msg.is_error === true) {
      const text = typeof msg.result === 'string' ? msg.result : 'The agent ended with an error.';
      out.push({ type: 'error', message: text });
    } else {
      out.push({ type: 'done' });
    }
  }
  return out;
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
 * The real backend. Runs the Agent SDK in streaming-input mode with the
 * project folder as cwd, so everything the agent writes lands in the user's
 * project. `acceptEdits` is the default permission mode: the whole point of
 * the app is that the agent builds the game without a confirmation per file,
 * and the cwd jail keeps that scoped to the open project.
 */
export class AgentSdkDriver implements ChatDriver {
  readonly kind = 'agent-sdk' as const;
  private queue = new EventQueue<ChatEvent>();
  private turns = new EventQueue<unknown>();
  private stopped = false;
  private pump: Promise<void> | null = null;

  constructor(
    private readonly sdk: { query: (args: unknown) => AsyncIterable<unknown> },
    private readonly apiKey: string,
  ) {}

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }

  async start(_sessionId: string, projectRoot: string): Promise<void> {
    const stream = this.sdk.query({
      prompt: this.turns,
      options: {
        cwd: projectRoot,
        permissionMode: 'acceptEdits',
        includePartialMessages: true,
        env: { ...process.env, ANTHROPIC_API_KEY: this.apiKey },
      },
    });
    // One long-lived pump for the whole session: the SDK yields messages for
    // every queued turn on the same stream.
    this.pump = (async () => {
      try {
        for await (const message of stream) {
          if (this.stopped) break;
          for (const event of mapSdkMessage(message)) this.queue.push(event);
        }
      } catch (err) {
        if (!this.stopped) this.queue.push({ type: 'error', message: (err as Error).message });
      }
    })();
  }

  send(text: string): void {
    if (this.stopped) return;
    this.turns.push({ type: 'user', message: { role: 'user', content: text } });
  }

  stop(): void {
    this.stopped = true;
    this.turns.close();
    this.queue.close();
    this.pump = null;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Pick the driver for a project: the Agent SDK when both the package and a key
 * are present, otherwise the stub. Never throws — a broken agent backend
 * degrades to guidance rather than an unusable conversation column.
 */
export async function createChatDriver(projectRoot: string): Promise<ChatDriver> {
  const key = await resolveApiKey(projectRoot);
  if (!key) return new StubDriver();
  const sdk = await loadAgentSdk();
  if (!sdk) return new StubDriver();
  return new AgentSdkDriver(sdk, key);
}
