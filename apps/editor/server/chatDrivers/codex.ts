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
import os from 'node:os';
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
  type InputResponse,
  type SlashCommandInfo,
} from '../chat.js';
import { hearthPtyEnv } from '../hearthShim.js';
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../permissionMode.js';
import { readPersonalPrompt } from '../personalization.js';
import { projectShellEnv } from '../shellEnv.js';
import { CLAUDE_SKILLS_DIR, skillSources, syncSkillsIntoProject } from '../skills.js';
import {
  CODEX_CLIENT_INFO,
  CODEX_TESTED_VERSION,
  classifyCodexServerRequest,
  codexApprovalChoiceReply,
  codexApprovalChoiceResolution,
  codexApprovalReply,
  codexCurrentTimeReply,
  codexElicitationReply,
  codexInputItems,
  codexPermissionParams,
  codexThreadInstructions,
  codexTurnOverrides,
  codexUserInputReply,
  decodeRpcChunk,
  encodeRpc,
  mapCodexAccount,
  mapCodexApprovalRequest,
  mapCodexLoginStart,
  mapCodexModels,
  mapCodexNotification,
  mapCodexQuestionRequest,
  type CodexAccount,
  type CodexModelInfo,
  type InputRequestDescriptor,
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
  const base = await projectShellEnv(projectRoot);
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
  private killing = false;

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
    this.killing = false;
    for (const [, pending] of this.pendingRequests) pending.reject(new Error(reason));
    this.pendingRequests.clear();
    this.onClose(reason);
    this.transport = null;
  }

  private write(line: string): void {
    if (this.closed || this.killing || !this.transport) return;
    this.transport.write(line);
  }

  notify(method: string, params?: unknown): void {
    this.write(encodeRpc({ method, params: params ?? {} }));
  }

  /** Reply to a server->client request. */
  respond(id: number | string, result: unknown): void {
    this.write(encodeRpc({ id, result }));
  }

  /** Reject a server->client request using JSON-RPC's standard error shape. */
  respondError(id: number | string, code: number, message: string): void {
    this.write(encodeRpc({ id, error: { code, message } }));
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
    if (this.closed) {
      this.transport?.kill();
      this.transport = null;
      return;
    }
    if (this.killing) return;
    this.killing = true;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('codex app-server was stopped'));
    }
    this.pendingRequests.clear();
    const transport = this.transport;
    if (transport) transport.kill();
    else this.fail('codex app-server was stopped');
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
      const kind = classifyCodexServerRequest(method);
      if (kind === 'approval') conn.respond(id, codexApprovalReply(method, 'deny'));
      else if (kind === 'current-time') conn.respond(id, codexCurrentTimeReply());
      else conn.respondError(id, -32601, `Unsupported codex server request: ${method}`);
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
      const kind = classifyCodexServerRequest(method);
      if (kind === 'approval') conn.respond(id, codexApprovalReply(method, 'deny'));
      else if (kind === 'current-time') conn.respond(id, codexCurrentTimeReply());
      else conn.respondError(id, -32601, `Unsupported codex server request: ${method}`);
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
  private resolveClosed: () => void = () => undefined;
  readonly closed: Promise<void> = new Promise((resolve) => {
    this.resolveClosed = resolve;
  });
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
  private approvals = new Map<
    string,
    { id: number | string; method: string; decisionsById: ReadonlyMap<string, unknown> }
  >();
  private nextApproval = 0;
  /** Blocking questions and MCP elicitations awaiting an answer in Hearth. */
  private inputs = new Map<string, { id: number | string; method: string }>();
  private inputByRequestId = new Map<string, string>();
  private nextInput = 0;
  private projectRoot = '';
  private chatId = '';
  /** Preserves provider notification order while external images are staged. */
  private notifications: Promise<void> = Promise.resolve();
  private nextArtifact = 0;
  private knownCommands = new Set(['compact', 'review']);
  private commandListeners = new Set<(commands?: SlashCommandInfo[]) => void>();

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
    /**
     * How much this project's agent may do without asking. Fixed at bind time
     * because codex fixes the policy when the thread starts or resumes: there
     * is no per-turn field for it, so a mode change is a rebind (ws.ts).
     */
    private readonly permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
  ) {}

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }

  /**
   * True once the pipe to the child is gone or the driver was torn down. ws.ts
   * refuses to hand a turn to a session whose driver reads dead: see the
   * transport-loss handler in `start`.
   */
  get dead(): boolean {
    return this.stopped;
  }

  async start(sessionId: string, projectRoot: string): Promise<void> {
    this.chatId = sessionId;
    this.projectRoot = projectRoot;
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
        this.resolveClosed();
        if (this.stopped) return;
        // The pipe to the child is gone, so this conversation is over: say so,
        // then tear the driver down properly.
        //
        // This used to close the queue and nothing else. `stopped` stayed
        // false, so the driver still LOOKED alive to everyone holding it, and
        // ws.ts kept the session in `chatSessions`. The next message was
        // appended to the transcript, handed to `send()` on a corpse, pushed
        // into a closed queue by the rejection handler, and dropped. Nothing
        // ever reached the window, so the composer stayed busy and diverted
        // every message after it into a queue that was never drained: one
        // message orphaned unanswered, the rest gone without ever touching
        // disk. Ending the stream is what lets ws.ts retire the session and
        // bind a fresh backend for the next thing the user types.
        this.queue.push({ type: 'error', message: reason });
        this.stop();
      },
    );
    this.conn = conn;
    conn.attach(this.connect(this.bin, projectRoot, this.env));
    await conn.initialize();

    // Point codex at the SAME mirror the Agent SDK reads, so both backends see
    // one library rather than two.
    //
    // This used to be `[skillsRoot()]`, Hearth's own folder and nothing else,
    // and that made the Skills list a half-truth. The list also shows the
    // skills it discovered in `~/.claude/skills` and `~/.codex/skills`, and
    // those reached Claude (the mirror carries every enabled skill whatever
    // its source) while codex never saw a single one of them. It also meant a
    // skill switched OFF stayed live here, because a whole directory was
    // handed over and the switch is not a property of the directory.
    //
    // The mirror answers both. It holds exactly the enabled skills, from every
    // source, and switching one off removes it. Its path is `.claude/skills`
    // only because the Agent SDK cannot be pointed anywhere else and something
    // had to give the folder a name; codex can be pointed anywhere, so it is
    // pointed here rather than given a second copy to disagree with.
    //
    // Sent, not awaited: the app-server handles stdin requests in order, so
    // this is applied before the `thread/start` below it either way, and
    // waiting for a reply would hang the whole bind against a build that never
    // sends one.
    const skillRoot = path.join(projectRoot, CLAUDE_SKILLS_DIR);
    const mirroredSkills = await syncSkillsIntoProject(projectRoot).catch(() => []);
    void conn.request('skills/extraRoots/set', { extraRoots: [skillRoot] }).catch(() => {
      /* an older codex simply has no extra roots */
    });

    // The house facts first, then the user's standing preferences — read
    // fresh at bind for the same reason the skills above are. See
    // `codexThreadInstructions` for why this rides on `thread/start` alone
    // and not on the resume beside it.
    const instructions = composeAgentInstructions(
      hearthFactsPrompt({ probeCli: this.tools?.probeCli === true, skills: mirroredSkills.length > 0 }),
      await readPersonalPrompt(),
    );

    // What the agent may do without asking, and how far its sandbox reaches.
    // Sent on BOTH methods: a resumed thread that inherited codex's own default
    // for an untrusted folder is read-only, and an approved patch against a
    // read-only sandbox fails after the user has already said yes. See
    // `codexPermissionParams`.
    const permissions = codexPermissionParams(this.permissionMode);

    // Resume when we know this conversation's thread, else start a new one.
    // A resume against a thread codex has forgotten must not strand the
    // conversation, so it falls back to a fresh thread.
    let thread: unknown = null;
    let resumed = false;
    let resumeFailed = false;
    if (this.resumeThreadId) {
      try {
        thread = await conn.request('thread/resume', {
          threadId: this.resumeThreadId,
          cwd: projectRoot,
          ...permissions,
        });
        resumed = thread !== null && thread !== undefined;
        resumeFailed = !resumed;
      } catch {
        thread = null;
        resumeFailed = true;
      }
    }
    if (!thread) {
      if (resumeFailed) {
        this.queue.push({
          type: 'notice',
          text: 'Codex could not resume the saved thread, so this continues in a fresh Codex thread.',
        });
      }
      thread = await conn.request('thread/start', {
        cwd: projectRoot,
        ...permissions,
        ...codexThreadInstructions(instructions),
      });
    }
    // A successful resume IS the thread we asked to resume, whatever shape the
    // reply arrived in.
    const id = readThreadId(thread) ?? (resumed ? this.resumeThreadId : null);
    if (!id) {
      // FAIL the bind rather than come up half-connected. `ready` used to be
      // set regardless, and `startTurn` opened with a bare `if (!conn ||
      // !this.threadId) return;`, so against a codex build whose reply shape
      // had drifted, every message was written to the transcript, rendered in
      // the window, and thrown away in total silence. A bind that throws is
      // reported on the conversation, which is the difference between a broken
      // install and an app that appears to be ignoring you.
      throw new Error('codex started a thread but did not say which one. Your codex build may be newer than this one.');
    }
    this.threadId = id;
    if (id !== this.resumeThreadId) this.onThreadId(id);
    this.ready = true;
    for (const queued of this.backlog.splice(0)) this.send(queued.text, queued.agent, queued.attachments);
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.stopped) return;
    // SkillsChanged is an invalidation, not a replacement list. Codex's
    // generated protocol has used both the schema name and JSON-RPC spelling
    // across app-server releases, so accept either and re-read skills/list.
    if (method === 'SkillsChanged' || method === 'skills/changed') {
      for (const listener of this.commandListeners) listener();
    }
    if (method === 'serverRequest/resolved') {
      const requestId = readServerRequestId(params);
      if (requestId !== null) this.withdrawServerRequest(requestId);
    }
    if (method === 'turn/started') {
      const p = (params ?? {}) as { turn?: { id?: string } };
      this.turnId = p.turn?.id ?? null;
    }
    if (method === 'turn/completed') this.turnId = null;
    const events = mapCodexNotification(method, params, this.skillRoots);
    this.notifications = this.notifications
      .then(async () => {
        for (const event of events) {
          if (event.type === 'image') {
            try {
              const staged = await this.stageImage(event.path);
              this.queue.push({ ...event, path: staged });
            } catch (err) {
              this.queue.push({
                type: 'notice',
                text: `Could not stage a Codex artifact: ${(err as Error).message}`,
              });
            }
          } else {
            this.queue.push(event);
          }
        }
      })
      .catch((err: Error) => {
        if (!this.stopped) this.queue.push({ type: 'notice', text: `Could not stage a Codex artifact: ${err.message}` });
      });
  }

  private async stageImage(source: string): Promise<string> {
    const absolute = source.startsWith(`~${path.sep}`) || source.startsWith('~/')
      ? path.resolve(os.homedir(), source.slice(2))
      : path.isAbsolute(source)
        ? path.resolve(source)
        : path.resolve(this.projectRoot, source);
    const relative = path.relative(this.projectRoot, absolute);
    if (relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
    const stat = await fsp.stat(absolute);
    if (!stat.isFile() || stat.size > 24 * 1024 * 1024) throw new Error('the image is not a bounded regular file');
    const safeName = path.basename(absolute).replace(/[^A-Za-z0-9._-]/g, '_').slice(-120) || 'image';
    const dir = path.join(this.projectRoot, '.hearth', 'chats', 'attachments', this.chatId);
    await fsp.mkdir(dir, { recursive: true });
    const name = `codex-${Date.now()}-${++this.nextArtifact}-${safeName}`;
    const destination = path.join(dir, name);
    const temp = `${destination}.part`;
    try {
      await fsp.copyFile(absolute, temp, fsConstants.COPYFILE_EXCL);
      await fsp.rename(temp, destination);
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
    }
    return path.relative(this.projectRoot, destination).split(path.sep).join('/');
  }

  /**
   * An approval pauses codex until it is answered. We surface it, remember the
   * request id, and reply when the user decides. Anything we can't describe is
   * denied immediately — silence would wedge the turn.
   */
  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const conn = this.conn;
    if (!conn) return;
    const kind = classifyCodexServerRequest(method);
    if (kind === 'current-time') {
      conn.respond(id, codexCurrentTimeReply());
      return;
    }
    if (kind === 'question') {
      const inputId = `ci${++this.nextInput}`;
      const request = mapCodexQuestionRequest(method, inputId, params);
      if (!request || this.stopped) {
        conn.respondError(id, -32602, `Invalid codex server request: ${method}`);
        this.queue.push({ type: 'notice', text: 'Codex sent an interactive request Hearth could not safely display.' });
        return;
      }
      this.inputs.set(inputId, { id, method });
      this.inputByRequestId.set(requestKey(id), inputId);
      this.queue.push(inputEvent(request));
      return;
    }
    if (kind === 'unsupported') {
      conn.respondError(id, -32601, `Unsupported codex server request: ${method}`);
      this.queue.push({ type: 'notice', text: `Codex asked Hearth to handle an unsupported request: ${method}.` });
      return;
    }
    // `skip` means the user already answered, once, for the whole project. The
    // thread was started with `approvalPolicy: 'never'`, so codex should not be
    // asking at all, but "should not" is not a guarantee: `never` governs
    // commands and patches, and this protocol has other things it can ask about
    // (a permissions request, an MCP elicitation, a tool wanting input). Any one
    // of those arriving would put an Allow / Deny prompt on screen underneath a
    // pill reading "No checks", which is the app contradicting itself about the
    // one subject where it must not.
    //
    // Answered here rather than shown, which is what the Agent SDK side already
    // does: `sdkApprovalFor` returns null under `skip` and `askPermission`
    // allows. The two backends now behave the same way for the same reason.
    if (this.permissionMode === 'skip') {
      const mapped = mapCodexApprovalRequest(method, params);
      conn.respond(id, mappedDecision(mapped?.decisionsById, 'allow') ?? codexApprovalReply(method, 'allow'));
      return;
    }
    const mapped = mapCodexApprovalRequest(method, params);
    if (!mapped || this.stopped) {
      conn.respond(id, codexApprovalReply(method, 'deny'));
      return;
    }
    const approvalId = `c${++this.nextApproval}`;
    this.approvals.set(approvalId, { id, method, decisionsById: mapped.decisionsById });
    const { decisions, ...approval } = mapped.approval;
    this.queue.push({
      type: 'approval-request',
      approvalId,
      ...approval,
      ...(decisions && decisions.length > 0 ? { choices: decisions } : {}),
    });
  }

  approve(approvalId: string, decision: ApprovalDecision, choiceId?: string): void {
    const pending = this.approvals.get(approvalId);
    if (!pending || !this.conn) return;
    this.approvals.delete(approvalId);
    this.conn.respond(
      pending.id,
      (choiceId ? codexApprovalChoiceReply(pending.decisionsById, choiceId) : null) ??
        mappedDecision(pending.decisionsById, decision) ??
        codexApprovalReply(pending.method, decision),
    );
    this.queue.push({
      type: 'approval-resolved',
      approvalId,
      decision:
        (choiceId ? codexApprovalChoiceResolution(pending.decisionsById, choiceId) : null) ?? decision,
    });
  }

  answerInput(inputId: string, response: InputResponse): void {
    const pending = this.inputs.get(inputId);
    if (!pending || !this.conn) return;
    this.inputs.delete(inputId);
    this.inputByRequestId.delete(requestKey(pending.id));
    if (pending.method === 'item/tool/requestUserInput') {
      this.conn.respond(pending.id, codexUserInputReply(response.action === 'submit' ? (response.answers ?? {}) : {}));
    } else {
      this.conn.respond(
        pending.id,
        response.action === 'submit'
          ? codexElicitationReply('accept', response.answers ?? {})
          : codexElicitationReply('cancel'),
      );
    }
    this.queue.push({ type: 'input-resolved', inputId, action: response.action });
  }

  private withdrawServerRequest(requestId: number | string): void {
    const inputId = this.inputByRequestId.get(requestKey(requestId));
    if (inputId) {
      this.inputByRequestId.delete(requestKey(requestId));
      this.inputs.delete(inputId);
      this.queue.push({ type: 'input-resolved', inputId, action: 'withdrawn' });
      return;
    }
    for (const [approvalId, pending] of this.approvals) {
      if (requestKey(pending.id) !== requestKey(requestId)) continue;
      this.approvals.delete(approvalId);
      this.queue.push({ type: 'approval-resolved', approvalId, decision: 'withdrawn' });
      return;
    }
  }

  send(text: string, agent?: AgentTurnOptions, attachments?: readonly ChatAttachment[]): void {
    if (this.stopped) return;
    if (!this.ready) {
      this.backlog.push({ text, agent, attachments });
      return;
    }
    const parsed = attachments?.length ? null : codexCommand(text);
    const command = parsed && this.knownCommands.has(parsed.name) ? parsed : null;
    if (command?.name === 'compact') {
      if (!this.conn || !this.threadId) return;
      void this.conn
        .request('thread/compact/start', { threadId: this.threadId })
        .then(() => this.queue.push({ type: 'turn-complete' }))
        .catch((err: Error) => this.queue.push({ type: 'error', message: err.message }));
      return;
    }
    if (command?.name === 'review') {
      if (!this.conn || !this.threadId) return;
      const target = command.args
        ? { type: 'baseBranch', branch: command.args }
        : { type: 'uncommittedChanges' };
      void this.conn
        .request('review/start', { threadId: this.threadId, target, delivery: 'inline' })
        .catch((err: Error) => this.queue.push({ type: 'error', message: err.message }));
      return;
    }
    this.startTurn(command ? `$${command.name}${command.args ? ` ${command.args}` : ''}` : text, agent, attachments);
  }

  async commands(): Promise<SlashCommandInfo[]> {
    if (!this.conn || !this.projectRoot) return [];
    try {
      const commands = codexSlashCommands(
        await this.conn.request('skills/list', { cwds: [this.projectRoot], forceReload: true }, 15_000),
      );
      this.knownCommands = new Set(commands.map((command) => command.name));
      return commands;
    } catch {
      return codexSlashCommands(null);
    }
  }

  onCommandsChanged(listener: (commands?: SlashCommandInfo[]) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  private startTurn(text: string, agent?: AgentTurnOptions, attachments?: readonly ChatAttachment[]): void {
    const conn = this.conn;
    if (!conn || !this.threadId) {
      // Belt and braces: `start` now refuses to become ready without a thread,
      // so nothing should reach here with one missing. Saying it out loud is
      // still the only acceptable behaviour, because the message has already
      // been written to the transcript and drawn on screen by the time this
      // runs, and a silent return is how it ends up looking answered-in-a-void.
      if (!this.stopped) {
        this.queue.push({ type: 'error', message: 'The codex backend is not connected. Send again to start a fresh one.' });
      }
      return;
    }
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
    if (this.stopped) return;
    this.stopped = true;
    // Answer anything still blocking codex so the child can unwind cleanly
    // rather than sitting on a paused turn while we kill it. Codex itself is
    // told `deny` (its protocol has no third word for an ask nobody answered),
    // but the event stream — and through it the transcript — records
    // `withdrawn`: the session ended before the person decided, and writing
    // `deny` there would forge a decision they never made. A prompt on screen
    // is only ever taken down by its `approval-resolved`, so the resolution
    // still goes onto the queue before the close.
    for (const [approvalId, pending] of this.approvals) {
      this.conn?.respond(
        pending.id,
        mappedDecision(pending.decisionsById, 'deny') ?? codexApprovalReply(pending.method, 'deny'),
      );
      this.queue.push({ type: 'approval-resolved', approvalId, decision: 'withdrawn' });
    }
    this.approvals.clear();
    for (const [inputId, pending] of this.inputs) {
      this.conn?.respond(
        pending.id,
        pending.method === 'item/tool/requestUserInput'
          ? codexUserInputReply({})
          : codexElicitationReply('cancel'),
      );
      this.queue.push({ type: 'input-resolved', inputId, action: 'withdrawn' });
    }
    this.inputs.clear();
    this.inputByRequestId.clear();
    this.conn?.kill();
    this.conn = null;
    void this.notifications.finally(() => this.queue.close());
  }
}

/** `thread/start` and `thread/resume` both answer with a `thread` object. */
function readThreadId(result: unknown): string | null {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
  const thread = record?.thread;
  const id = thread && typeof thread === 'object' ? (thread as Record<string, unknown>).id : record?.threadId;
  return typeof id === 'string' && id !== '' ? id : null;
}

function requestKey(id: number | string): string {
  return `${typeof id}:${String(id)}`;
}

function readServerRequestId(params: unknown): number | string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const id = record.requestId ?? record.id;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

function inputEvent(request: InputRequestDescriptor): ChatEvent {
  return {
    type: 'input-request',
    inputId: request.inputId,
    ...(request.title ? { title: request.title } : {}),
    ...(request.description ? { description: request.description } : {}),
    questions: request.questions,
    ...(request.allowCancel === undefined ? {} : { allowCancel: request.allowCancel }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.externalAction === undefined ? {} : { externalAction: request.externalAction }),
  };
}

function codexCommand(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: (match[2] ?? '').trim() };
}

/** Runtime command catalogue: native app-server acts plus every enabled skill. */
export function codexSlashCommands(raw: unknown): SlashCommandInfo[] {
  const commands: SlashCommandInfo[] = [
    { name: 'compact', description: 'Compact this Codex thread', source: 'builtin' },
    {
      name: 'review',
      description: 'Review uncommitted changes, or changes against a base branch',
      argumentHint: '[base branch]',
      source: 'builtin',
    },
  ];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return commands;
  const data = (raw as Record<string, unknown>).data;
  if (!Array.isArray(data)) return commands;
  const seen = new Set(commands.map((command) => command.name));
  for (const entry of data) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const skills = (entry as Record<string, unknown>).skills;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill)) continue;
      const record = skill as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (!name || record.enabled === false || seen.has(name)) continue;
      seen.add(name);
      commands.push({
        name,
        description:
          (typeof record.description === 'string' && record.description.trim()) ||
          (typeof record.shortDescription === 'string' && record.shortDescription.trim()) ||
          'Run this Codex skill',
        source: 'skill',
      });
    }
  }
  return commands;
}

/**
 * Hearth's shared approval UI currently exposes allow/deny. Preserve Codex's
 * exact server-authored scalar when one is available; richer choices remain
 * server-only until the shared approval contract grows a choice id.
 */
function mappedDecision(
  decisionsById: ReadonlyMap<string, unknown> | undefined,
  decision: ApprovalDecision,
): { decision: unknown } | null {
  if (!decisionsById) return null;
  const wanted = decision === 'allow' ? ['accept', 'acceptForSession'] : ['decline', 'cancel'];
  for (const expected of wanted) {
    for (const [choiceId, wire] of decisionsById) {
      if (wire !== expected) continue;
      return codexApprovalChoiceReply(decisionsById, choiceId);
    }
  }
  return null;
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
    /** This project's permission mode, read at bind time by ws.ts. */
    permissionMode?: PermissionMode | null;
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
    opts?.permissionMode ?? DEFAULT_PERMISSION_MODE,
  );
}
