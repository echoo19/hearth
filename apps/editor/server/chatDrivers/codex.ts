/**
 * The OpenAI backend: `codex app-server`, driven over stdio JSON-RPC.
 *
 * This is the surface OpenAI's own desktop app is built on, which is why it —
 * rather than scraping the interactive CLI — is what Hearth embeds. All wire
 * knowledge lives next door in codexWire.ts; this file owns process lifetime,
 * the request/response bookkeeping, and how a Hearth chat maps onto a codex
 * thread.
 *
 * Three things matter about the shape here:
 *
 *  1. **Credentials never leave this process.** codex holds its own tokens in
 *     `~/.codex/auth.json`; Hearth never reads them, never forwards them, and
 *     the renderer only ever learns booleans and an email address. An API key
 *     configured in Settings is passed to the child's environment and nowhere
 *     else.
 *  2. **Approvals are server->client REQUESTS that PAUSE the turn.** They are
 *     answered by id, and an unanswerable one is denied rather than dropped —
 *     a dropped approval wedges the agent forever.
 *  3. **Absence of the binary is a first-class state**, not an error. A
 *     machine without codex gets a `not-installed` status and install
 *     guidance, and driver selection quietly falls through to another backend.
 *
 * Verified against codex-cli 0.144.5 — see CODEX_TESTED_VERSION.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { composeAgentInstructions, hearthFactsPrompt } from '../agentFacts.js';
import {
  EventQueue,
  readAppSettings,
  resolveOpenAiKey,
  type AgentToolAccess,
  type AgentTurnOptions,
  type ApprovalDecision,
  type ChatAttachment,
  type ChatDriver,
  type ChatEvent,
} from '../chat.js';
import { hearthPtyEnv } from '../hearthShim.js';
import { readPersonalPrompt } from '../personalization.js';
import { loginShellPathEnv } from '../shellEnv.js';
import { CLAUDE_SKILLS_DIR, skillSources, skillsRoot } from '../skills.js';
import {
  CODEX_CLIENT_INFO,
  CODEX_TESTED_VERSION,
  codexApprovalReply,
  codexInputItems,
  codexThreadInstructions,
  codexTurnOverrides,
  decodeRpcChunk,
  describeQuestion,
  encodeRpc,
  isApprovalRequest,
  isQuestionRequest,
  mapCodexAccount,
  mapCodexApproval,
  mapCodexLoginStart,
  mapCodexModels,
  mapCodexNotification,
  type CodexAccount,
  type CodexModelInfo,
  type RpcMessage,
} from './codexWire.js';

export { CODEX_TESTED_VERSION, type CodexModelInfo };

/** What the UI needs to know about the OpenAI side, and how to fix it. */
export interface CodexStatus extends CodexAccount {
  installed: boolean;
  /** e.g. `codex-cli 0.144.5`. Null when the binary didn't answer. */
  version: string | null;
  /** An OpenAI API key is configured for this folder (or the environment). */
  hasKey: boolean;
  /**
   * Models this account can answer with, read from the binary rather than
   * hardcoded — the catalogue moves faster than our releases do. Only
   * populated when the caller asks for it (see `readCodexStatus`).
   */
  models?: CodexModelInfo[];
}

/** Shown verbatim in Settings when codex isn't on the machine. */
export const CODEX_INSTALL_HINT = 'npm i -g @openai/codex';

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * The environment to spawn codex in. A GUI-launched app inherits the minimal
 * system PATH, so a codex installed by nvm/homebrew/npm-global is invisible
 * without the user's login-shell PATH — the same problem the embedded
 * terminal solves, solved the same way.
 */
async function codexEnv(projectRoot: string): Promise<NodeJS.ProcessEnv> {
  const base = (await loginShellPathEnv()) ?? process.env;
  const key = await resolveOpenAiKey(projectRoot);
  // Only ever ADD a key; never strip one codex already has of its own.
  return key ? { ...base, CODEX_API_KEY: key, OPENAI_API_KEY: key } : { ...base };
}

/** Is this path an executable file we can actually run? */
async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(candidate);
    if (!stat.isFile()) return false;
    await fsp.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the codex binary: an explicit path in Settings wins, then PATH (as the
 * user's login shell sees it). Returns null when there is none — the caller
 * turns that into the `not-installed` state rather than an exception.
 */
export async function resolveCodexBinary(projectRoot: string): Promise<string | null> {
  const override = (await readAppSettings(projectRoot)).codexPath?.trim();
  if (override) return (await isExecutable(override)) ? override : null;
  const env = await codexEnv(projectRoot);
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'codex');
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** `codex --version`, or null when the binary won't answer promptly. */
export async function readCodexVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(bin, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, 5_000);
      timer.unref?.();
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        finish(out.trim() === '' ? null : out.trim());
      });
    } catch {
      finish(null);
    }
  });
}

// ---------------------------------------------------------------------------
// One app-server connection
// ---------------------------------------------------------------------------

type ServerRequestHandler = (id: number | string, method: string, params: unknown) => void;

/**
 * Everything CodexConnection needs from the outside world: a byte pipe that
 * can be written to, read from, and closed.
 *
 * The indirection is what makes the protocol testable. A test stands a
 * scripted app-server behind this interface and drives the real connection,
 * the real handshake and the real mapping — with no subprocess, no codex
 * install, and no network. Production passes `spawnCodexTransport`.
 */
export interface CodexTransport {
  write(line: string): void;
  onData(handler: (chunk: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  kill(): void;
}

/** The real transport: a `codex app-server` child on stdio. */
export function spawnCodexTransport(bin: string, cwd: string, env: NodeJS.ProcessEnv): CodexTransport {
  const child: ChildProcessWithoutNullStreams = spawn(bin, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  // codex logs diagnostics to stderr; it is not protocol and not an error.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => undefined);
  return {
    write: (line) => {
      if (child.stdin.writable) child.stdin.write(line);
    },
    onData: (handler) => child.stdout.on('data', (chunk: string) => handler(chunk)),
    onClose: (handler) => {
      child.on('error', (err) => handler(err.message));
      child.on('close', (code) => handler(`codex app-server exited (${code ?? 'signal'})`));
    },
    kill: () => child.kill(),
  };
}

/**
 * A live `codex app-server` child, with the JSON-RPC bookkeeping around it.
 *
 * Requests are correlated by a monotonic id; notifications and inbound server
 * REQUESTS are handed to callbacks. Nothing here interprets a payload — that
 * is codexWire.ts's job.
 */
export class CodexConnection {
  private transport: CodexTransport | null = null;
  private buffer = '';
  private nextId = 0;
  private pendingRequests = new Map<number | string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onServerRequest: ServerRequestHandler,
    private readonly onClose: (reason: string) => void,
  ) {}

  /** Bind the connection to a byte pipe and start reading frames from it. */
  attach(transport: CodexTransport): void {
    this.transport = transport;
    transport.onData((chunk) => this.ingest(chunk));
    transport.onClose((reason) => this.fail(reason));
  }

  private ingest(chunk: string): void {
    const { messages, rest } = decodeRpcChunk(this.buffer + chunk);
    this.buffer = rest;
    for (const message of messages) this.dispatch(message);
  }

  private dispatch(message: RpcMessage): void {
    // A response to something we asked.
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'codex request failed'));
      else pending.resolve(message.result);
      return;
    }
    // A request FROM the server — approvals and the like. It has an id and
    // expects a reply; leaving one unanswered pauses codex forever.
    if (message.id !== undefined && message.method !== undefined) {
      this.onServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method !== undefined) this.onNotification(message.method, message.params);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pendingRequests) pending.reject(new Error(reason));
    this.pendingRequests.clear();
    this.onClose(reason);
  }

  private write(line: string): void {
    if (this.closed || !this.transport) return;
    this.transport.write(line);
  }

  notify(method: string, params?: unknown): void {
    this.write(encodeRpc({ method, params: params ?? {} }));
  }

  /** Reply to a server->client request. */
  respond(id: number | string, result: unknown): void {
    this.write(encodeRpc({ id, result }));
  }

  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('codex app-server is not running'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingRequests.delete(id)) return;
        reject(new Error(`codex ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write(encodeRpc({ id, method, params: params ?? {} }));
    });
  }

  /** The handshake every connection opens with. */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
  }

  kill(): void {
    this.closed = true;
    this.pendingRequests.clear();
    this.transport?.kill();
    this.transport = null;
  }
}

/**
 * Run one short-lived app-server connection for a question that isn't a
 * conversation (status, login). Always tears the child down.
 */
async function withConnection<T>(
  projectRoot: string,
  run: (conn: CodexConnection, notifications: EventQueue<{ method: string; params: unknown }>) => Promise<T>,
): Promise<T | null> {
  const bin = await resolveCodexBinary(projectRoot);
  if (!bin) return null;
  const env = await codexEnv(projectRoot);
  const notifications = new EventQueue<{ method: string; params: unknown }>();
  const conn = new CodexConnection(
    (method, params) => notifications.push({ method, params }),
    // A short-lived connection never runs a turn, so nothing should ask it
    // for permission; deny anything that does rather than hanging.
    (id, method) => {
      if (isApprovalRequest(method)) conn.respond(id, codexApprovalReply(method, 'deny'));
    },
    () => notifications.close(),
  );
  try {
    conn.attach(spawnCodexTransport(bin, projectRoot, env));
    await conn.initialize();
    return await run(conn, notifications);
  } finally {
    conn.kill();
    notifications.close();
  }
}

// ---------------------------------------------------------------------------
// Status and login
// ---------------------------------------------------------------------------

/**
 * What Settings shows for OpenAI. Never throws: every failure mode (no
 * binary, a binary that won't handshake, a protocol change) collapses into a
 * status the UI can render and act on.
 */
export async function readCodexStatus(
  projectRoot: string,
  opts?: {
    /**
     * Also ask the binary which models the account can use. Off by default:
     * it is one extra round trip on the same connection, and only the
     * providers read-out (which fills the model selector) needs it — binding a
     * driver does not.
     */
    withModels?: boolean;
  },
): Promise<CodexStatus> {
  const hasKey = (await resolveOpenAiKey(projectRoot)) !== null;
  const bin = await resolveCodexBinary(projectRoot);
  if (!bin) {
    return { installed: false, version: null, loggedIn: false, authMode: null, email: null, planType: null, hasKey };
  }
  const env = await codexEnv(projectRoot);
  const version = await readCodexVersion(bin, env);
  try {
    const probe = await withConnection(projectRoot, async (conn) => {
      const account = mapCodexAccount(await conn.request('account/read', {}, 15_000));
      let models: CodexModelInfo[] = [];
      if (opts?.withModels === true && account.loggedIn) {
        try {
          models = mapCodexModels(await conn.request('model/list', {}, 15_000));
        } catch {
          // An older build without model/list is not a broken install; the
          // caller falls back to its curated list.
        }
      }
      return { account, models };
    });
    if (probe) {
      return {
        installed: true,
        version,
        hasKey,
        ...probe.account,
        ...(probe.models.length > 0 ? { models: probe.models } : {}),
      };
    }
  } catch {
    /* installed but not answering: report it as signed out, not as broken */
  }
  // An API key alone is a usable credential even when `account/read` is quiet.
  return {
    installed: true,
    version,
    loggedIn: hasKey,
    authMode: hasKey ? 'apikey' : null,
    email: null,
    planType: null,
    hasKey,
  };
}

/**
 * Begin a ChatGPT sign-in. Returns the URL the client should open; the flow
 * completes in the browser against codex's own localhost callback, and this
 * connection stays up until the `account/login/completed` notification lands
 * so the caller can report the result.
 *
 * Driving it through the protocol (rather than shelling out to `codex login`)
 * is what lets the app report completion instead of asking the user whether it
 * worked. `onComplete` fires once, with the outcome.
 */
export async function startCodexLogin(
  projectRoot: string,
  onComplete: (result: { ok: boolean; error?: string }) => void,
): Promise<{ authUrl: string | null; error?: string }> {
  const bin = await resolveCodexBinary(projectRoot);
  if (!bin) return { authUrl: null, error: `codex isn't installed. Install it with: ${CODEX_INSTALL_HINT}` };
  const env = await codexEnv(projectRoot);

  let settled = false;
  const finish = (result: { ok: boolean; error?: string }): void => {
    if (settled) return;
    settled = true;
    conn.kill();
    onComplete(result);
  };
  const conn = new CodexConnection(
    (method, params) => {
      if (method !== 'account/login/completed') return;
      const p = (params ?? {}) as { success?: boolean; error?: string | null };
      finish({ ok: p.success === true, error: p.error ?? undefined });
    },
    (id, method) => {
      if (isApprovalRequest(method)) conn.respond(id, codexApprovalReply(method, 'deny'));
    },
    (reason) => finish({ ok: false, error: reason }),
  );

  try {
    conn.attach(spawnCodexTransport(bin, projectRoot, env));
    await conn.initialize();
    const result = await conn.request('account/login/start', { type: 'chatgpt' }, 30_000);
    const { authUrl } = mapCodexLoginStart(result);
    // The browser half can take a while; don't hold the child forever if the
    // user abandons the tab.
    const timer = setTimeout(() => finish({ ok: false, error: 'Sign-in timed out.' }), 10 * 60_000);
    timer.unref?.();
    return { authUrl };
  } catch (err) {
    conn.kill();
    return { authUrl: null, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * One Hearth conversation, backed by one codex thread.
 *
 * A thread outlives the process, so the thread id is handed back to the caller
 * (`onThreadId`) to persist against the chat — reopening a conversation
 * resumes it rather than starting a stranger.
 */
export class CodexDriver implements ChatDriver {
  readonly kind = 'codex' as const;
  private queue = new EventQueue<ChatEvent>();
  private conn: CodexConnection | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private stopped = false;
  /**
   * Every folder a skill could be read from, resolved at bind. codex reports
   * no skill of its own (see `codexSkillRead`), so recognising one means
   * recognising its path, and these are the paths.
   */
  private skillRoots: string[] = [];
  /** Turns queued before the thread finished starting. */
  private backlog: { text: string; agent?: AgentTurnOptions; attachments?: readonly ChatAttachment[] }[] = [];
  private ready = false;
  /** Inbound approval requests awaiting the user, by our approvalId. */
  private approvals = new Map<string, { id: number | string; method: string }>();
  private nextApproval = 0;

  constructor(
    private readonly bin: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly resumeThreadId: string | null,
    private readonly onThreadId: (threadId: string) => void,
    /** How to open the pipe. Overridden in tests by a scripted app-server. */
    private readonly connect: (bin: string, cwd: string, env: NodeJS.ProcessEnv) => CodexTransport = spawnCodexTransport,
    /**
     * The choice this conversation was bound with. Used for any turn that
     * doesn't carry its own, so a model picked before the first message still
     * applies to it.
     */
    private readonly defaultAgent: AgentTurnOptions | null = null,
    /** Hearth tooling this machine offers the agent. Null means none. */
    private readonly tools: AgentToolAccess | null = null,
  ) {}

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }

  async start(_sessionId: string, projectRoot: string): Promise<void> {
    // Hearth's own folder plus the two agents' folders we discover from, and
    // the project mirror the Agent SDK reads: a skill can be reached through
    // any of them, and a row that only recognised one root would go quiet
    // depending on where the user happened to keep the skill.
    this.skillRoots = [
      ...skillSources().map((source) => source.dir),
      path.join(projectRoot, CLAUDE_SKILLS_DIR),
    ];
    const conn = new CodexConnection(
      (method, params) => this.handleNotification(method, params),
      (id, method, params) => this.handleServerRequest(id, method, params),
      (reason) => {
        if (this.stopped) return;
        this.queue.push({ type: 'error', message: reason });
        this.queue.close();
      },
    );
    this.conn = conn;
    conn.attach(this.connect(this.bin, projectRoot, this.env));
    await conn.initialize();

    // Point codex at Hearth's skills folder. `skills/extraRoots/set` is a real
    // method on this protocol (verified against CODEX_TESTED_VERSION by
    // probing the binary's own generated schema).
    //
    // Sent, not awaited: the app-server handles stdin requests in order, so
    // this is applied before the `thread/start` below it either way, and
    // waiting for a reply would hang the whole bind against a build that never
    // sends one.
    void conn.request('skills/extraRoots/set', { extraRoots: [skillsRoot()] }).catch(() => {
      /* an older codex simply has no extra roots */
    });

    // The house facts first, then the user's standing preferences — read
    // fresh at bind for the same reason the skills above are. See
    // `codexThreadInstructions` for why this rides on `thread/start` alone
    // and not on the resume beside it.
    const instructions = composeAgentInstructions(
      hearthFactsPrompt({ probeCli: this.tools?.probeCli === true }),
      await readPersonalPrompt(),
    );

    // Resume when we know this conversation's thread, else start a new one.
    // A resume against a thread codex has forgotten must not strand the
    // conversation, so it falls back to a fresh thread.
    let thread: unknown = null;
    if (this.resumeThreadId) {
      try {
        thread = await conn.request('thread/resume', { threadId: this.resumeThreadId, cwd: projectRoot });
      } catch {
        thread = null;
      }
    }
    if (!thread) {
      thread = await conn.request('thread/start', { cwd: projectRoot, ...codexThreadInstructions(instructions) });
    }
    const id = readThreadId(thread);
    if (id) {
      this.threadId = id;
      if (id !== this.resumeThreadId) this.onThreadId(id);
    }
    this.ready = true;
    for (const queued of this.backlog.splice(0)) this.startTurn(queued.text, queued.agent, queued.attachments);
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.stopped) return;
    if (method === 'turn/started') {
      const p = (params ?? {}) as { turn?: { id?: string } };
      this.turnId = p.turn?.id ?? null;
    }
    if (method === 'turn/completed') this.turnId = null;
    for (const event of mapCodexNotification(method, params, this.skillRoots)) this.queue.push(event);
  }

  /**
   * An approval pauses codex until it is answered. We surface it, remember the
   * request id, and reply when the user decides. Anything we can't describe is
   * denied immediately — silence would wedge the turn.
   */
  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const conn = this.conn;
    if (!conn) return;
    if (isQuestionRequest(method)) {
      // The agent is asking, not acting. Show what it asked before answering
      // with nothing, so the user can reply in their next message instead of
      // wondering why it carried on without them.
      const asked = describeQuestion(params);
      if (asked) this.queue.push({ type: 'notice', text: asked });
      conn.respond(id, {});
      return;
    }
    if (!isApprovalRequest(method)) {
      // An unknown server request still needs SOME reply; an empty result is
      // the least-surprising one, and unknown methods are expected on a
      // protocol that is still moving.
      conn.respond(id, {});
      return;
    }
    const approval = mapCodexApproval(method, params);
    if (!approval || this.stopped) {
      conn.respond(id, codexApprovalReply(method, 'deny'));
      return;
    }
    const approvalId = `c${++this.nextApproval}`;
    this.approvals.set(approvalId, { id, method });
    this.queue.push({ type: 'approval-request', approvalId, ...approval });
  }

  approve(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.approvals.get(approvalId);
    if (!pending || !this.conn) return;
    this.approvals.delete(approvalId);
    this.conn.respond(pending.id, codexApprovalReply(pending.method, decision));
    this.queue.push({ type: 'approval-resolved', approvalId, decision });
  }

  send(text: string, agent?: AgentTurnOptions, attachments?: readonly ChatAttachment[]): void {
    if (this.stopped) return;
    if (!this.ready) {
      this.backlog.push({ text, agent, attachments });
      return;
    }
    this.startTurn(text, agent, attachments);
  }

  private startTurn(text: string, agent?: AgentTurnOptions, attachments?: readonly ChatAttachment[]): void {
    const conn = this.conn;
    if (!conn || !this.threadId) return;
    void conn
      .request('turn/start', {
        threadId: this.threadId,
        input: codexInputItems(text, attachments ?? []),
        // `model` and `effort` are real TurnStartParams fields on the app-server
        // protocol (verified against CODEX_TESTED_VERSION's own
        // `generate-ts` output): both override the thread's setting for this
        // turn and the ones after it. Omitted entirely when the user expressed
        // no choice, so codex keeps using its own configured default.
        ...codexTurnOverrides(agent ?? this.defaultAgent),
      })
      .catch((err: Error) => {
        if (!this.stopped) this.queue.push({ type: 'error', message: err.message });
      });
  }

  /** Stop the running turn, keeping the thread alive for the next send. */
  interrupt(): void {
    if (!this.conn || !this.threadId || !this.turnId) return;
    this.conn.notify('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  stop(): void {
    this.stopped = true;
    // Answer anything still blocking codex so the child can unwind cleanly
    // rather than sitting on a paused turn while we kill it.
    for (const [, pending] of this.approvals) {
      this.conn?.respond(pending.id, codexApprovalReply(pending.method, 'deny'));
    }
    this.approvals.clear();
    this.conn?.kill();
    this.conn = null;
    this.queue.close();
  }
}

/** `thread/start` and `thread/resume` both answer with a `thread` object. */
function readThreadId(result: unknown): string | null {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
  const thread = record?.thread;
  const id = thread && typeof thread === 'object' ? (thread as Record<string, unknown>).id : record?.threadId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Build a CodexDriver for a project, or null when codex isn't installed or
 * has no usable credential — which is what makes driver selection fall
 * through to the next backend instead of failing the conversation.
 */
export async function createCodexDriver(
  projectRoot: string,
  opts?: {
    resumeThreadId?: string | null;
    onThreadId?: (threadId: string) => void;
    /** The choice the binding turn expressed, applied to turns that omit one. */
    agent?: AgentTurnOptions | null;
    /** Hearth tooling on this machine (shim dir + probe), from ws.ts. */
    tools?: AgentToolAccess | null;
  },
): Promise<ChatDriver | null> {
  const bin = await resolveCodexBinary(projectRoot);
  if (!bin) return null;
  let env = await codexEnv(projectRoot);
  // Same PATH the embedded terminal gets: `hearth`, and `hearth-probe` when
  // this machine has one, resolve inside every shell codex runs.
  if (opts?.tools?.shimDir) env = hearthPtyEnv(env, opts.tools.shimDir);
  const status = await readCodexStatus(projectRoot);
  if (!status.loggedIn) return null;
  return new CodexDriver(
    bin,
    env,
    opts?.resumeThreadId ?? null,
    opts?.onThreadId ?? (() => undefined),
    spawnCodexTransport,
    opts?.agent ?? null,
    opts?.tools ?? null,
  );
}
