/**
 * State for the embedded agent terminal's pty session, layered on top of the
 * store's shared WS connection (see ../../store.ts — one socket per project,
 * carrying both `journal` and `pty-*` frames; this module only ever touches
 * the latter).
 *
 * Three layers, each independently testable:
 *  - A pure reducer (`reduceAgentSocket`) turning pty-* frames into a
 *    bounded scrollback buffer plus a status/command/exitCode summary.
 *  - A pure write-planner (`planTerminalWrite`) so a (re)mounted xterm
 *    instance replays exactly the scrollback it missed, without re-writing
 *    bytes it already rendered or losing bytes evicted by the cap.
 *  - A tiny external store (module-level, not React state) wrapping the
 *    reducer, so the buffered session survives the Agent panel's own
 *    component tree unmounting — closing and reopening the panel's dockview
 *    tab must not lose scrollback while the underlying pty (and the WS
 *    connection feeding it) is still alive. `useAgentSocket()` is the React
 *    seam onto that external store.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { useEditor } from '../../store';
import type { WsFrame } from '../../../server/ws';

export type PtyCommand = 'shell';
export type PtyServerFrame = Extract<WsFrame, { type: 'pty-data' | 'pty-exit' | 'pty-error' }>;
export type PtyAttachFrame = Extract<WsFrame, { type: 'pty-attach' }>;

/**
 * 'reconnecting': the WS connection dropped under a running session. The
 * server keeps the pty alive detached (see ws.ts detachPty), so the client
 * keeps the session — scrollback intact, terminal rendering — and reattaches
 * when the socket comes back (store.ts onopen).
 */
export type AgentStatus = 'idle' | 'running' | 'reconnecting' | 'exited';

export interface AgentSocketState {
  status: AgentStatus;
  /** Bumped on every 'start'/'reset' so a mounted terminal notices a new
   * session began even if the buffer's contents happen to look caught up. */
  epoch: number;
  command: PtyCommand | null;
  /** Tail of everything the pty has emitted this epoch, capped at
   * SCROLLBACK_CAP_BYTES so a long-running session can't grow this without
   * bound; replayed into a (re)mounted terminal. */
  scrollback: string;
  /** Bytes evicted from the front of `scrollback` this epoch by the cap. */
  droppedBytes: number;
  exitCode: number | null;
  errorMessage: string | null;
}

export const SCROLLBACK_CAP_BYTES = 200 * 1024;
/**
 * Trim only once the buffer overshoots the cap by this much. `.slice()` has
 * to copy the whole retained buffer, so trimming on every chunk would cost
 * O(cap) per pty-data frame during sustained output; with slack it costs
 * that only once per ~16KB of new output. The buffer may briefly hold up to
 * cap+slack, and every trim cuts back to exactly the cap.
 */
export const SCROLLBACK_TRIM_SLACK_BYTES = 16 * 1024;

export function initialAgentSocketState(): AgentSocketState {
  return {
    status: 'idle',
    epoch: 0,
    command: null,
    scrollback: '',
    droppedBytes: 0,
    exitCode: null,
    errorMessage: null,
  };
}

function appendCapped(scrollback: string, chunk: string): { scrollback: string; droppedDelta: number } {
  const next = scrollback + chunk;
  if (next.length <= SCROLLBACK_CAP_BYTES + SCROLLBACK_TRIM_SLACK_BYTES) {
    return { scrollback: next, droppedDelta: 0 };
  }
  const droppedDelta = next.length - SCROLLBACK_CAP_BYTES;
  return { scrollback: next.slice(droppedDelta), droppedDelta };
}

export type AgentSocketAction =
  | { type: 'start'; command: PtyCommand }
  | { type: 'stop' }
  | { type: 'reset' }
  | { type: 'disconnected' }
  | { type: 'attach'; replay: string; dropped: number }
  | { type: 'frame'; frame: PtyServerFrame };

export function reduceAgentSocket(state: AgentSocketState, action: AgentSocketAction): AgentSocketState {
  switch (action.type) {
    case 'start':
      // A fresh session: whatever the previous one left behind no longer applies.
      return {
        status: 'running',
        epoch: state.epoch + 1,
        command: action.command,
        scrollback: '',
        droppedBytes: 0,
        exitCode: null,
        errorMessage: null,
      };
    case 'reset':
      return { ...initialAgentSocketState(), epoch: state.epoch + 1 };
    case 'stop':
      return state.status === 'running' ? { ...state, status: 'exited' } : state;
    case 'disconnected':
      // The socket dropped under a live session. The server-side pty is
      // detached, not dead — keep everything (scrollback, epoch, the mounted
      // terminal's rendering) and wait for the reconnect to reattach.
      return state.status === 'running' ? { ...state, status: 'reconnecting' } : state;
    case 'attach':
      // The server reattached us to the surviving pty: its buffered tail
      // replaces our just-reset buffer (the 'start' sent alongside pty-start
      // already bumped the epoch and cleared it). `dropped` > 0 lets a
      // (re)mounting terminal show the usual trimmed-history cue.
      return {
        ...state,
        status: 'running',
        scrollback: action.replay,
        droppedBytes: action.dropped,
        exitCode: null,
        errorMessage: null,
      };
    case 'frame': {
      const { frame } = action;
      if (frame.type === 'pty-data') {
        const { scrollback, droppedDelta } = appendCapped(state.scrollback, frame.data);
        return { ...state, scrollback, droppedBytes: state.droppedBytes + droppedDelta };
      }
      if (frame.type === 'pty-exit') {
        return { ...state, status: 'exited', exitCode: frame.code };
      }
      // pty-error: the pty never started (e.g. the binary isn't on PATH) — surface it
      // as terminal output too, so it's visible without needing the Console panel.
      const { scrollback, droppedDelta } = appendCapped(state.scrollback, `\r\n[hearth] ${frame.message}\r\n`);
      return {
        ...state,
        status: 'exited',
        errorMessage: frame.message,
        scrollback,
        droppedBytes: state.droppedBytes + droppedDelta,
      };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Terminal write planning — pure, DOM-free diffing between what a mounted
// xterm instance has already rendered and the current buffered state.
// ---------------------------------------------------------------------------

export interface TerminalWriteCursor {
  epoch: number;
  /** Absolute stream position already written for this epoch (droppedBytes + index into scrollback). */
  pos: number;
}

export function initialWriteCursor(): TerminalWriteCursor {
  return { epoch: -1, pos: 0 };
}

export interface TerminalWritePlan {
  /** True when the caller should clear its terminal view before writing `text` (a new epoch). */
  reset: boolean;
  /**
   * True exactly when this replay starts truncated: the buffer already had
   * bytes evicted by the scrollback cap before this (re)mount, so what's
   * about to be written can't be the session's full history — a fresh/
   * reattached terminal would otherwise show a shortened scrollback with no
   * cue that anything's missing (AGENT-6 / L-094). Only meaningful on
   * `reset`: once a terminal instance is caught up, a later live trim can't
   * retroactively hide anything it already rendered, so it doesn't need a
   * repeat notice.
   */
  truncated: boolean;
  text: string;
  cursor: TerminalWriteCursor;
}

/** Only the three fields a terminal replay needs — callers can pass the full
 * AgentSocketState or just this slice (Terminal.tsx does the latter). */
export type ScrollbackSnapshot = Pick<AgentSocketState, 'scrollback' | 'droppedBytes' | 'epoch'>;

export function planTerminalWrite(cursor: TerminalWriteCursor, state: ScrollbackSnapshot): TerminalWritePlan {
  const reset = cursor.epoch !== state.epoch;
  const pos = reset ? 0 : cursor.pos;
  const total = state.droppedBytes + state.scrollback.length;
  // If the cursor is behind the eviction window (missed bytes that got dropped
  // off the front), there's nothing to do but replay whatever tail remains.
  const sliceStart = pos < state.droppedBytes ? 0 : pos - state.droppedBytes;
  const text = state.scrollback.slice(sliceStart);
  const truncated = reset && state.droppedBytes > 0;
  return { reset, truncated, text, cursor: { epoch: state.epoch, pos: total } };
}

// ---------------------------------------------------------------------------
// External store: module-level, outside React, so it outlives the Agent
// panel's component tree. Fed by store.ts's WS message handler
// (ingestPtyFrame/ingestPtyAttach) and by the start/stop actions below
// (markAgentStarted/markAgentStopped). A dropped WS connection marks the
// session 'reconnecting' (markAgentDisconnected) — the server keeps the pty
// alive detached and store.ts reattaches on reconnect; only a deliberate
// teardown (project switch/close) resets the store (resetAgentSocket).
// ---------------------------------------------------------------------------

type Listener = () => void;

/**
 * The session minus its scrollback. This is what React components subscribe
 * to: its object identity only changes when one of these fields changes, so
 * a torrent of pty-data frames (which only grow the scrollback) re-renders
 * nothing — the Terminal component consumes scrollback imperatively via
 * subscribeAgentSocket/getAgentSocketSnapshot instead.
 */
export type AgentSessionSummary = Omit<AgentSocketState, 'scrollback' | 'droppedBytes'>;

function deriveSummary(state: AgentSocketState): AgentSessionSummary {
  return {
    status: state.status,
    epoch: state.epoch,
    command: state.command,
    exitCode: state.exitCode,
    errorMessage: state.errorMessage,
  };
}

let agentSocketState: AgentSocketState = initialAgentSocketState();
let agentSessionSummary: AgentSessionSummary = deriveSummary(agentSocketState);
const listeners = new Set<Listener>();

function commit(next: AgentSocketState): void {
  const prev = agentSocketState;
  agentSocketState = next;
  if (
    prev.status !== next.status ||
    prev.epoch !== next.epoch ||
    prev.command !== next.command ||
    prev.exitCode !== next.exitCode ||
    prev.errorMessage !== next.errorMessage
  ) {
    agentSessionSummary = deriveSummary(next);
  }
  for (const listener of listeners) listener();
}

export function ingestPtyFrame(frame: PtyServerFrame): void {
  commit(reduceAgentSocket(agentSocketState, { type: 'frame', frame }));
}

export function ingestPtyAttach(frame: PtyAttachFrame): void {
  commit(reduceAgentSocket(agentSocketState, { type: 'attach', replay: frame.replay, dropped: frame.dropped }));
}

export function markAgentStarted(command: PtyCommand): void {
  commit(reduceAgentSocket(agentSocketState, { type: 'start', command }));
}

export function markAgentStopped(): void {
  // Rotate the session token: if the pty-stop never reached the server (the
  // socket was down), a later Restart must spawn fresh, not reattach to the
  // stopped-but-lingering session (its linger timeout will reap it).
  agentPtySessionId = null;
  commit(reduceAgentSocket(agentSocketState, { type: 'stop' }));
}

export function markAgentDisconnected(): void {
  commit(reduceAgentSocket(agentSocketState, { type: 'disconnected' }));
}

export function resetAgentSocket(): void {
  agentPtySessionId = null; // the server session dies with a deliberate teardown
  commit(reduceAgentSocket(agentSocketState, { type: 'reset' }));
}

// ---------------------------------------------------------------------------
// Resumable-session token. Sent with every pty-start so the server can hand
// this client its own surviving pty back after a socket drop (sleep/wake).
// Rotates on resetAgentSocket (project switch/close): a prior project's
// server session must never be reachable from the next one.
// ---------------------------------------------------------------------------

let agentPtySessionId: string | null = null;

export function ensureAgentPtySessionId(): string {
  if (!agentPtySessionId) {
    agentPtySessionId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return agentPtySessionId;
}

export function subscribeAgentSocket(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentSocketSnapshot(): AgentSocketState {
  return agentSocketState;
}

/** Stable-identity summary (no scrollback) — see AgentSessionSummary. */
export function getAgentSessionSummary(): AgentSessionSummary {
  return agentSessionSummary;
}

// Mirror the session's status into the zustand store — registered here (not
// in store.ts) because this module's own bindings are guaranteed live at
// this point, whereas store.ts's create() can run while this module is still
// mid-evaluation (the two import each other). This is the ONLY writer of
// `agentStatus`, so it can't drift from the terminal's real state; the
// equality check keeps zustand quiet during pure scrollback growth.
subscribeAgentSocket(() => {
  const status = agentSessionSummary.status;
  if (useEditor.getState().agentStatus !== status) useEditor.setState({ agentStatus: status });
});

// ---------------------------------------------------------------------------
// React seam
// ---------------------------------------------------------------------------

export interface AgentSocket {
  session: AgentSessionSummary;
  /**
   * Sends pty-start over the shared WS socket, marking the session running.
   * Returns false (and logs to the Console) without touching state when the
   * socket is down — a session must never claim to run when nothing was sent.
   */
  start(): boolean;
  /** Sends pty-stop over the shared WS socket and marks the session exited. */
  stop(): void;
  sendInput(data: string): void;
  sendResize(cols: number, rows: number): void;
}

const NOT_CONNECTED_MSG = 'Agent terminal: the editor connection is down; wait a moment and try again.';

export function useAgentSocket(): AgentSocket {
  const session = useSyncExternalStore(subscribeAgentSocket, getAgentSessionSummary, getAgentSessionSummary);

  const start = useCallback(() => {
    const editor = useEditor.getState();
    if (!editor.sendAgentFrame({ type: 'pty-start', sessionId: ensureAgentPtySessionId() })) {
      editor.log('error', 'editor', NOT_CONNECTED_MSG);
      return false;
    }
    markAgentStarted('shell');
    return true;
  }, []);

  const stop = useCallback(() => {
    // Best-effort over a possibly-downed socket. The exited mark is right
    // either way: an unreachable server-side pty (if one still lingers
    // detached) is reaped by its linger timeout, and an explicit restart
    // spawns fresh rather than reattaching to a stopped session.
    useEditor.getState().sendAgentFrame({ type: 'pty-stop' });
    markAgentStopped();
  }, []);

  const sendInput = useCallback((data: string) => {
    useEditor.getState().sendAgentFrame({ type: 'pty-input', data });
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    useEditor.getState().sendAgentFrame({ type: 'pty-resize', cols, rows });
  }, []);

  return { session, start, stop, sendInput, sendResize };
}
