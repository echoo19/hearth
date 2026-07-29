/**
 * The bring-your-own-agent backend: a program the user registered, driven over
 * newline-delimited JSON on stdio.
 *
 * All wire knowledge lives next door in customWire.ts; this file owns process
 * lifetime, the handshake, and the bookkeeping around one conversation. The
 * split is the same one codex.ts and codexWire.ts have, for the same reason: a
 * protocol change should be a one-file edit, and the whole format should be
 * testable without a subprocess.
 *
 * Four things matter about the shape here:
 *
 *  1. **The handshake is a GATE, not a formality.** A bind that never sees
 *     `{"type":"ready"}` fails loudly and kills the child. The alternative is a
 *     conversation bound to `ls`, or to a program that prints a usage message
 *     and exits, that simply never answers anybody.
 *  2. **Hearth cannot gate this agent's tool calls, and says so.** It does not
 *     own the agent's loop. When the handshake does not claim approvals, every
 *     turn carries one `notice` saying the permission mode was passed and not
 *     applied. See `permissionNotice`. Building a fake gate here would be worse
 *     than saying nothing: the transcript would imply Hearth stopped something
 *     it never saw.
 *  3. **The command is the user's, and it is shown.** Nothing here allowlists,
 *     signs, or sandboxes a binary. This app already embeds a shell that runs
 *     anything the user types; a registered agent is that same capability with
 *     a better surface, and pretending otherwise would be theatre. What Hearth
 *     does instead is print the exact command line everywhere the agent is
 *     named, and refuse to run one nobody confirmed.
 *  4. **A dead child ends the stream.** ws.ts has no other signal that the
 *     conversation needs a fresh backend, and a driver that looks alive while
 *     its process is gone swallows the next message the user types.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import {
  agentCommandLine,
  isAgentConfirmed,
  readCustomAgent,
  type CustomAgent,
} from '../agentRegistry.js';
import { findOnPath } from '../agentClis.js';
import {
  EventQueue,
  type AgentToolAccess,
  type AgentTurnOptions,
  type ApprovalDecision,
  type ChatAttachment,
  type ChatDriver,
  type ChatEvent,
} from '../chat.js';
import { hearthPtyEnv } from '../hearthShim.js';
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../permissionMode.js';
import { loginShellPathEnv } from '../shellEnv.js';
import {
  agentEnvVars,
  approvalFrame,
  decodeLines,
  encodeFrame,
  exitedMessage,
  handshakeMessage,
  HEARTH_PROTOCOL_VERSION,
  interruptFrame,
  parseAgentEvent,
  parseHandshake,
  permissionNotice,
  promptFrame,
  protocolMessage,
  shutdownFrame,
  type AgentHandshake,
} from './customWire.js';

/**
 * How long a bind waits for the first line.
 *
 * Long enough for a Node or Python wrapper's cold start on a loaded machine,
 * short enough that a program which is never going to answer does not hold a
 * turn open indefinitely. A wrapper that needs longer than this before printing
 * its handshake should print the handshake first and do its setup after: the
 * handshake says "I speak this protocol", not "I am ready to think".
 */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Everything CustomDriver needs from the outside world: a byte pipe that can be
 * written to, read from and closed.
 *
 * The indirection is what makes the protocol testable. A test stands a scripted
 * agent behind this interface and drives the real handshake, the real decoder
 * and the real approval bookkeeping, with no subprocess and nothing installed.
 * Production passes `spawnCustomTransport`.
 */
export interface CustomTransport {
  write(line: string): void;
  onData(handler: (chunk: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  kill(): void;
}

/** The real transport: the user's program, on stdio. */
export function spawnCustomTransport(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): CustomTransport {
  const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  // stderr is diagnostics and never protocol, the same treatment codex's gets.
  // Draining it matters even though nothing reads it: a child whose stderr pipe
  // fills up blocks on the write and stops answering.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => undefined);
  return {
    write: (line) => {
      if (child.stdin.writable) child.stdin.write(line);
    },
    onData: (handler) => child.stdout.on('data', (chunk: string) => handler(chunk)),
    onClose: (handler) => {
      child.on('error', (err) => handler(err.message));
      child.on('close', (code, signal) => handler(signal ? `stopped by ${signal}` : `exit code ${code ?? 0}`));
    },
    kill: () => child.kill(),
  };
}

/** Is this path an executable file we could actually run? */
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
 * Where the registered command actually lives, or null.
 *
 * A command carrying a separator is taken as a path and checked directly;
 * anything else is resolved against PATH the way a shell would. Resolved
 * explicitly rather than left to `spawn` so the failure is "Hearth could not
 * find `my-agent` on your PATH" instead of a bare ENOENT on the transcript.
 */
export async function resolveAgentCommand(command: string, pathValue: string): Promise<string | null> {
  if (command.includes('/') || command.includes('\\')) return (await isExecutable(command)) ? command : null;
  return findOnPath(command, pathValue);
}

/**
 * One Hearth conversation, backed by one child process.
 *
 * The process lives for the whole conversation rather than per turn, so an
 * agent can hold context between messages. A turn is one `prompt` frame and
 * everything the agent writes until it says `turn-complete` or `error`.
 */
export class CustomDriver implements ChatDriver {
  readonly kind = 'custom' as const;
  private queue = new EventQueue<ChatEvent>();
  private transport: CustomTransport | null = null;
  private buffer = '';
  private handshake: AgentHandshake | null = null;
  private stopped = false;
  /** Turns queued before the handshake landed. */
  private backlog: { text: string; agent?: AgentTurnOptions; attachments?: readonly ChatAttachment[] }[] = [];
  private nextTurn = 0;
  /** The turn the agent is answering, or null between turns. */
  private turnId: string | null = null;
  /** Approvals the agent raised and the user has not answered. */
  private approvals = new Set<string>();
  /** Settles the bind. Held so a close or a bad first line can fail it. */
  private onHandshake: ((result: AgentHandshake | Error) => void) | null = null;

  constructor(
    private readonly agent: CustomAgent,
    /** The resolved binary. Held separately so the label can stay the user's. */
    private readonly bin: string,
    private readonly env: NodeJS.ProcessEnv,
    /** How to open the pipe. Overridden in tests by a scripted agent. */
    private readonly connect: (
      command: string,
      args: readonly string[],
      cwd: string,
      env: NodeJS.ProcessEnv,
    ) => CustomTransport = spawnCustomTransport,
    /**
     * The choice this conversation was bound with, applied to any turn that
     * does not carry its own.
     */
    private readonly defaultAgent: AgentTurnOptions | null = null,
    /**
     * How much this project's agent may do without asking. Fixed at bind time
     * because it is spawned into the child's environment; a mode change is a
     * rebind, which ws.ts already does for every backend.
     */
    private readonly permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
  ) {}

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }

  get dead(): boolean {
    return this.stopped;
  }

  /** What this agent claimed about itself. Null until the handshake lands. */
  get supports(): AgentHandshake | null {
    return this.handshake;
  }

  async start(_sessionId: string, projectRoot: string): Promise<void> {
    const transport = this.connect(this.bin, this.agent.args, projectRoot, this.env);
    this.transport = transport;
    transport.onData((chunk) => this.ingest(chunk));
    transport.onClose((reason) => this.handleClose(reason));

    const settled = await new Promise<AgentHandshake | Error>((resolve) => {
      this.onHandshake = resolve;
      const timer = setTimeout(
        () => resolve(new Error(handshakeMessage(this.agent.label, agentCommandLine(this.agent)))),
        HANDSHAKE_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    this.onHandshake = null;
    if (settled instanceof Error) {
      // FAIL the bind rather than come up half-connected. ws.ts reports this on
      // the conversation and writes the user's message down, which is the
      // difference between a broken agent and an app that appears to be
      // ignoring you. The child goes with it: a program that never spoke
      // protocol is not one to leave running against a folder.
      this.stopped = true;
      this.transport?.kill();
      this.transport = null;
      this.queue.close();
      throw settled;
    }
    if (settled.protocol !== HEARTH_PROTOCOL_VERSION) {
      this.stopped = true;
      this.transport?.kill();
      this.transport = null;
      this.queue.close();
      throw new Error(protocolMessage(this.agent.label, settled.protocol));
    }
    this.handshake = settled;
    for (const queued of this.backlog.splice(0)) this.startTurn(queued.text, queued.agent, queued.attachments);
  }

  private ingest(chunk: string): void {
    if (this.stopped) return;
    const { values, rest, overflowed } = decodeLines(this.buffer + chunk);
    this.buffer = rest;
    if (overflowed) {
      this.fail(`${this.agent.label} wrote one line too large to read. The conversation was ended.`);
      return;
    }
    for (const value of values) {
      if (this.handshake === null) {
        // The FIRST JSON line has to be the handshake. Anything else means the
        // program is not speaking this protocol, whatever else it may be.
        const parsed = parseHandshake(value);
        const settle = this.onHandshake;
        this.onHandshake = null;
        if (!parsed) {
          settle?.(new Error(handshakeMessage(this.agent.label, agentCommandLine(this.agent))));
          // Nothing after a bad first line is protocol worth reading.
          return;
        }
        // Recorded here rather than in `start`, because an agent is free to
        // write its handshake and its first events in ONE chunk, and a loop
        // that waited for the bind to resume would throw those events away.
        // `start` still owns the VERSION check and tears the driver down when
        // it fails, which closes the queue under anything read in between.
        this.handshake = parsed;
        settle?.(parsed);
        continue;
      }
      const event = parseAgentEvent(value);
      if (!event) continue;
      if (event.type === 'approval-request') {
        if (!this.handshake.approvals) {
          // An agent that did not claim approvals asking for one anyway is a
          // request Hearth has no contract to answer: the turn was already
          // told this agent enforces its own permissions, and putting an
          // Allow / Deny prompt on screen would contradict that in the same
          // transcript. Shown as a notice instead, so the request is not
          // silently swallowed either.
          this.queue.push({ type: 'notice', text: `${this.agent.label} asked: ${event.title}` });
          continue;
        }
        this.approvals.add(event.approvalId);
      }
      if (event.type === 'turn-complete' || event.type === 'error') this.turnId = null;
      this.queue.push(event);
    }
  }

  /** Say what went wrong on the transcript, then tear down. */
  private fail(message: string): void {
    if (this.stopped) return;
    this.queue.push({ type: 'error', message });
    this.stop();
  }

  private handleClose(reason: string): void {
    if (this.stopped) return;
    const settle = this.onHandshake;
    if (settle) {
      settle(new Error(exitedMessage(this.agent.label, reason)));
      return;
    }
    // The child is gone, so this conversation is over. Reported as an error
    // because that is what it is to the person waiting, and because an error is
    // what ends a turn: an agent that exits mid-answer must not leave a window
    // spinning on a turn that is never coming.
    this.fail(exitedMessage(this.agent.label, reason));
  }

  send(text: string, agent?: AgentTurnOptions, attachments?: readonly ChatAttachment[]): void {
    if (this.stopped) return;
    if (this.handshake === null) {
      this.backlog.push({ text, agent, attachments });
      return;
    }
    this.startTurn(text, agent, attachments);
  }

  private startTurn(text: string, agent?: AgentTurnOptions, attachments?: readonly ChatAttachment[]): void {
    const transport = this.transport;
    if (!transport || this.handshake === null) return;
    // One quiet line per turn when nobody is enforcing Hearth's mode but the
    // agent itself. See permissionNotice, and the rule it exists for.
    if (!this.handshake.approvals) {
      this.queue.push({ type: 'notice', text: permissionNotice(this.agent.label, this.permissionMode) });
    }
    const turnId = `t${++this.nextTurn}`;
    this.turnId = turnId;
    transport.write(
      encodeFrame(promptFrame(turnId, text, attachments ?? [], agent ?? this.defaultAgent, this.permissionMode)),
    );
  }

  approve(approvalId: string, decision: ApprovalDecision): void {
    if (!this.approvals.delete(approvalId) || !this.transport) return;
    this.transport.write(encodeFrame(approvalFrame(approvalId, decision)));
    // Emitted here rather than accepted from the agent, so every window
    // watching this chat agrees and so an agent cannot record a decision
    // nobody made.
    this.queue.push({ type: 'approval-resolved', approvalId, decision });
  }

  /** Stop the running turn, keeping the process alive for the next send. */
  interrupt(): void {
    if (this.stopped || !this.transport || this.turnId === null) return;
    this.transport.write(encodeFrame(interruptFrame(this.turnId)));
  }

  stop(): void {
    if (this.stopped) {
      this.queue.close();
      return;
    }
    this.stopped = true;
    // Answer anything still blocking the agent so the child can unwind rather
    // than sitting on a paused turn while it is killed. The same answer goes
    // onto the event stream before the close: a prompt on screen is only ever
    // taken down by its `approval-resolved`, and leaving one live in every
    // window (and in the transcript) for a request that was already declined is
    // the failure CodexDriver.stop documents.
    for (const approvalId of this.approvals) {
      this.transport?.write(encodeFrame(approvalFrame(approvalId, 'deny')));
      this.queue.push({ type: 'approval-resolved', approvalId, decision: 'deny' });
    }
    this.approvals.clear();
    // Asked to leave before being killed, so a wrapper holding a file, a socket
    // or a subprocess of its own gets to close it.
    this.transport?.write(encodeFrame(shutdownFrame()));
    this.transport?.kill();
    this.transport = null;
    this.queue.close();
  }
}

/**
 * Build a CustomDriver for the agent this turn named.
 *
 * Returns null ONLY when the turn named no agent, which is what leaves every
 * conversation that predates this feature exactly as it was. Every other
 * failure THROWS, and that is deliberate: a person who picked their own agent
 * in the composer and silently got Claude instead has been lied to about who is
 * answering, which is the same failure the permission rules here exist to
 * prevent. A thrown error is reported on the conversation by ws.ts.
 */
export async function createCustomDriver(
  projectRoot: string,
  opts?: {
    agent?: AgentTurnOptions | null;
    tools?: AgentToolAccess | null;
    permissionMode?: PermissionMode | null;
    /** Test seam: how to open the pipe. */
    connect?: (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => CustomTransport;
  },
): Promise<ChatDriver | null> {
  const agentId = opts?.agent?.agentId;
  if (agentId === undefined || agentId === null || agentId === '') return null;
  const registered = await readCustomAgent(agentId);
  if (!registered) {
    throw new Error('That agent is not registered on this machine. Pick another one in the model menu.');
  }
  if (!isAgentConfirmed(registered)) {
    throw new Error(
      `${registered.label} has not been confirmed yet. Open Settings, find it under Agents, and confirm the command before it runs.`,
    );
  }
  const permissionMode = opts?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  // The same environment the embedded terminal gets, and nothing more: a
  // GUI-launched app inherits a minimal system PATH, so an agent installed by
  // homebrew, nvm or pipx is invisible without the login shell's.
  let env = { ...((await loginShellPathEnv()) ?? process.env) };
  if (opts?.tools?.shimDir) env = hearthPtyEnv(env, opts.tools.shimDir);
  const bin = await resolveAgentCommand(registered.command, env.PATH ?? '');
  if (!bin) {
    throw new Error(
      `Hearth could not find ${registered.command} on your PATH. Check the command under Agents in Settings.`,
    );
  }
  env = { ...env, ...agentEnvVars(projectRoot, permissionMode) };
  return new CustomDriver(
    registered,
    bin,
    env,
    opts?.connect ?? spawnCustomTransport,
    opts?.agent ?? null,
    permissionMode,
  );
}
