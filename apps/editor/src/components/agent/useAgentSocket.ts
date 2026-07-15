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
import type { PrepareAgentResult } from '../../api';

export type PtyCommand = 'claude' | 'codex' | 'shell';
export type PtyServerFrame = Extract<WsFrame, { type: 'pty-data' | 'pty-exit' | 'pty-error' }>;

export type AgentStatus = 'idle' | 'running' | 'exited';

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
// panel's component tree. Fed by store.ts's WS message handler (ingestPtyFrame)
// and by the start/stop actions below (markAgentStarted/markAgentStopped),
// and cleared by store.ts whenever the WS connection drops (resetAgentSocket)
// — the server always kills the pty when its owning socket closes, so the
// client must not go on claiming a session survives past that point.
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

export function markAgentStarted(command: PtyCommand): void {
  commit(reduceAgentSocket(agentSocketState, { type: 'start', command }));
}

export function markAgentStopped(): void {
  commit(reduceAgentSocket(agentSocketState, { type: 'stop' }));
}

export function resetAgentSocket(): void {
  commit(reduceAgentSocket(agentSocketState, { type: 'reset' }));
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
// Start-Claude gate — pure decision, DOM/WS-free (AgentPanel.tsx's startClaude).
// ---------------------------------------------------------------------------

export interface ClaudeStartDecision {
  /** False iff prepare failed — the caller must NOT spawn `claude` in this case. */
  shouldStart: boolean;
  /** Present iff shouldStart is false: why prepare failed, for display next to the header actions. */
  errorMessage: string | null;
}

/**
 * Prepare writes the hearth entry (with --mode) into .mcp.json; the bare
 * interactive `claude` picks that up itself, so this gate is the only thing
 * standing between a failed/corrupted prepare and actually spawning the
 * process. A stale .mcp.json from a previous session can carry a MORE
 * permissive mode than the one just selected — if prepare fails, that stale
 * grant must never silently win, so the caller must not fall through to
 * agent.start() on failure.
 */
export function planClaudeStart(prepareResult: Pick<PrepareAgentResult, 'ok' | 'error'>): ClaudeStartDecision {
  if (prepareResult.ok) return { shouldStart: true, errorMessage: null };
  return { shouldStart: false, errorMessage: prepareResult.error ?? 'failed to write .mcp.json' };
}

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
  start(command: PtyCommand, mode?: string): boolean;
  /** Sends pty-stop over the shared WS socket and marks the session exited. */
  stop(): void;
  sendInput(data: string): void;
  sendResize(cols: number, rows: number): void;
}

const NOT_CONNECTED_MSG = 'Agent terminal: the editor connection is down; wait a moment and try again.';

export function useAgentSocket(): AgentSocket {
  const session = useSyncExternalStore(subscribeAgentSocket, getAgentSessionSummary, getAgentSessionSummary);

  const start = useCallback((command: PtyCommand, mode?: string) => {
    const editor = useEditor.getState();
    if (!editor.sendAgentFrame({ type: 'pty-start', command, mode })) {
      editor.log('error', 'editor', NOT_CONNECTED_MSG);
      return false;
    }
    markAgentStarted(command);
    return true;
  }, []);

  const stop = useCallback(() => {
    // Even if the send fails the exited mark is right: a downed socket means
    // the server already killed the pty when the connection dropped.
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
