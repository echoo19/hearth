/**
 * Logic-only tests for the embedded agent terminal's socket state: the pure
 * reducer that turns pty-* frames into a bounded scrollback buffer plus a
 * status/command/exitCode summary, the write-planner a (re)mounted terminal
 * uses to replay exactly what it missed, and the tiny external store that
 * lets that state survive the Agent panel's own component unmounting (a
 * dockview tab close/reopen must not lose the terminal's scrollback while
 * the underlying pty — and the WS connection carrying its frames — is still
 * alive). No DOM, no real xterm, no WebSocket: everything here is plain data
 * in, plain data out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SCROLLBACK_CAP_BYTES,
  SCROLLBACK_TRIM_SLACK_BYTES,
  getAgentSessionSummary,
  getAgentSocketSnapshot,
  ingestPtyFrame,
  initialAgentSocketState,
  initialWriteCursor,
  markAgentStarted,
  markAgentStopped,
  planTerminalWrite,
  reduceAgentSocket,
  resetAgentSocket,
  subscribeAgentSocket,
  type AgentSocketState,
  type PtyServerFrame,
} from '../src/components/agent/useAgentSocket';

describe('initialAgentSocketState', () => {
  it('starts idle with nothing buffered', () => {
    expect(initialAgentSocketState()).toEqual({
      status: 'idle',
      epoch: 0,
      command: null,
      scrollback: '',
      droppedBytes: 0,
      exitCode: null,
      errorMessage: null,
    });
  });
});

describe('reduceAgentSocket', () => {
  it('start: goes to running, records the command, bumps the epoch, and clears any prior session', () => {
    const stale: AgentSocketState = {
      status: 'exited',
      epoch: 3,
      command: 'shell',
      scrollback: 'old output',
      droppedBytes: 40,
      exitCode: 0,
      errorMessage: 'boom',
    };
    const next = reduceAgentSocket(stale, { type: 'start', command: 'shell' });
    expect(next).toEqual({
      status: 'running',
      epoch: 4,
      command: 'shell',
      scrollback: '',
      droppedBytes: 0,
      exitCode: null,
      errorMessage: null,
    });
  });

  it('frame pty-data: appends to scrollback without touching status/command', () => {
    const state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    const next = reduceAgentSocket(state, {
      type: 'frame',
      frame: { type: 'pty-data', data: 'hello\r\n' } as PtyServerFrame,
    });
    expect(next.scrollback).toBe('hello\r\n');
    expect(next.status).toBe('running');
    expect(next.command).toBe('shell');
    expect(next.droppedBytes).toBe(0);
  });

  it('frame pty-data: tolerates overshoot within the trim slack (no copy on every chunk)', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    const chunk = 'x'.repeat(SCROLLBACK_CAP_BYTES - 10);
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: chunk } as PtyServerFrame });
    expect(state.scrollback.length).toBe(SCROLLBACK_CAP_BYTES - 10);
    expect(state.droppedBytes).toBe(0);

    // Over the cap but within slack: no trim yet — trimming on every chunk
    // would cost a full-buffer copy per pty-data frame.
    state = reduceAgentSocket(state, {
      type: 'frame',
      frame: { type: 'pty-data', data: 'y'.repeat(1000) } as PtyServerFrame,
    });
    expect(state.scrollback.length).toBe(SCROLLBACK_CAP_BYTES + 990);
    expect(state.droppedBytes).toBe(0);
  });

  it('frame pty-data: trims back to exactly the cap once past cap+slack, tracking dropped bytes', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    state = reduceAgentSocket(state, {
      type: 'frame',
      frame: { type: 'pty-data', data: 'x'.repeat(SCROLLBACK_CAP_BYTES) } as PtyServerFrame,
    });
    const overflow = 'y'.repeat(SCROLLBACK_TRIM_SLACK_BYTES + 500);
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: overflow } as PtyServerFrame });

    expect(state.scrollback.length).toBe(SCROLLBACK_CAP_BYTES);
    expect(state.droppedBytes).toBe(SCROLLBACK_TRIM_SLACK_BYTES + 500);
    expect(state.scrollback.endsWith(overflow)).toBe(true);
  });

  it('frame pty-exit: moves to exited, records the exit code, and keeps the scrollback', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: 'bye' } as PtyServerFrame });
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-exit', code: 1 } as PtyServerFrame });
    expect(state.status).toBe('exited');
    expect(state.exitCode).toBe(1);
    expect(state.scrollback).toBe('bye');
  });

  it('frame pty-error: moves to exited, records the message, and appends it to the scrollback', () => {
    const state0 = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    const state = reduceAgentSocket(state0, {
      type: 'frame',
      frame: { type: 'pty-error', message: 'spawn claude ENOENT' } as PtyServerFrame,
    });
    expect(state.status).toBe('exited');
    expect(state.errorMessage).toBe('spawn claude ENOENT');
    expect(state.scrollback).toContain('spawn claude ENOENT');
  });

  it('stop: only transitions a running session to exited, and leaves idle/exited alone', () => {
    const running = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    expect(reduceAgentSocket(running, { type: 'stop' }).status).toBe('exited');

    const idle = initialAgentSocketState();
    expect(reduceAgentSocket(idle, { type: 'stop' })).toEqual(idle);

    const exited = reduceAgentSocket(running, { type: 'stop' });
    expect(reduceAgentSocket(exited, { type: 'stop' })).toEqual(exited);
  });

  it('reset: returns to a fresh idle state but bumps the epoch so a mounted terminal notices', () => {
    const running = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    const withOutput = reduceAgentSocket(running, {
      type: 'frame',
      frame: { type: 'pty-data', data: 'hi' } as PtyServerFrame,
    });
    const reset = reduceAgentSocket(withOutput, { type: 'reset' });
    expect(reset).toEqual({
      status: 'idle',
      epoch: withOutput.epoch + 1,
      command: null,
      scrollback: '',
      droppedBytes: 0,
      exitCode: null,
      errorMessage: null,
    });
  });
});

describe('planTerminalWrite', () => {
  it('a fresh cursor against a fresh state replays the whole scrollback and flags a reset', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: 'abc' } as PtyServerFrame });

    const plan = planTerminalWrite(initialWriteCursor(), state);
    expect(plan.reset).toBe(true);
    expect(plan.text).toBe('abc');
    expect(plan.cursor).toEqual({ epoch: state.epoch, pos: 3 });
  });

  it('a cursor already caught up on the same epoch only gets the new delta, with no reset', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: 'abc' } as PtyServerFrame });
    const first = planTerminalWrite(initialWriteCursor(), state);

    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: 'def' } as PtyServerFrame });
    const second = planTerminalWrite(first.cursor, state);

    expect(second.reset).toBe(false);
    expect(second.text).toBe('def');
    expect(second.cursor).toEqual({ epoch: state.epoch, pos: 6 });
  });

  it('a new epoch (restart) forces a reset even if the cursor position looks caught up', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: 'abc' } as PtyServerFrame });
    const caughtUp = planTerminalWrite(initialWriteCursor(), state);

    const restarted = reduceAgentSocket(state, { type: 'start', command: 'shell' });
    const afterRestart = reduceAgentSocket(restarted, {
      type: 'frame',
      frame: { type: 'pty-data', data: 'fresh' } as PtyServerFrame,
    });

    const plan = planTerminalWrite(caughtUp.cursor, afterRestart);
    expect(plan.reset).toBe(true);
    expect(plan.text).toBe('fresh');
  });

  it('a cursor that has fallen behind the eviction window just replays whatever remains', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: 'abc' } as PtyServerFrame });
    const stale = planTerminalWrite(initialWriteCursor(), state).cursor; // caught up at pos 3

    // Blow past cap+slack so the tail slides well beyond the stale cursor's position.
    const overflow = 'z'.repeat(SCROLLBACK_CAP_BYTES + SCROLLBACK_TRIM_SLACK_BYTES + 500);
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: overflow } as PtyServerFrame });

    const plan = planTerminalWrite(stale, state);
    expect(plan.reset).toBe(false); // same epoch — no need to clear the terminal view
    expect(plan.text).toBe(state.scrollback); // but the cursor missed evicted bytes, so replay the whole tail
    expect(plan.cursor).toEqual({ epoch: state.epoch, pos: state.droppedBytes + state.scrollback.length });
  });

  // --- truncated flag (AGENT-6 / L-094: the scrollback cap silently drops
  // the earliest bytes with no cue) ------------------------------------------

  it('truncated is false on a fresh replay with nothing evicted yet', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: 'abc' } as PtyServerFrame });
    expect(planTerminalWrite(initialWriteCursor(), state).truncated).toBe(false);
  });

  it('truncated is true on a (re)mount whose buffer already had bytes evicted by the cap', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    const overflow = 'x'.repeat(SCROLLBACK_CAP_BYTES + SCROLLBACK_TRIM_SLACK_BYTES + 1);
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: overflow } as PtyServerFrame });
    expect(state.droppedBytes).toBeGreaterThan(0);

    // A fresh mount (initialWriteCursor) replaying this state is a reset with dropped bytes.
    const plan = planTerminalWrite(initialWriteCursor(), state);
    expect(plan.reset).toBe(true);
    expect(plan.truncated).toBe(true);
  });

  it('truncated is false once a terminal instance is caught up, even after a later live trim', () => {
    let state = reduceAgentSocket(initialAgentSocketState(), { type: 'start', command: 'shell' });
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: 'abc' } as PtyServerFrame });
    const caughtUp = planTerminalWrite(initialWriteCursor(), state);
    expect(caughtUp.truncated).toBe(false);

    const overflow = 'z'.repeat(SCROLLBACK_CAP_BYTES + SCROLLBACK_TRIM_SLACK_BYTES + 500);
    state = reduceAgentSocket(state, { type: 'frame', frame: { type: 'pty-data', data: overflow } as PtyServerFrame });
    const later = planTerminalWrite(caughtUp.cursor, state);
    expect(later.reset).toBe(false);
    expect(later.truncated).toBe(false); // no reset — this instance already rendered what came before the trim
  });
});

describe('the external agent-socket store (survives the panel component unmounting)', () => {
  beforeEach(() => {
    resetAgentSocket();
  });

  it('markAgentStarted/ingestPtyFrame/markAgentStopped/resetAgentSocket mutate the shared snapshot and notify subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentSocket(listener);

    markAgentStarted('shell');
    expect(getAgentSocketSnapshot().status).toBe('running');
    expect(getAgentSocketSnapshot().command).toBe('shell');
    expect(listener).toHaveBeenCalledTimes(1);

    ingestPtyFrame({ type: 'pty-data', data: 'ready' } as PtyServerFrame);
    expect(getAgentSocketSnapshot().scrollback).toBe('ready');
    expect(listener).toHaveBeenCalledTimes(2);

    markAgentStopped();
    expect(getAgentSocketSnapshot().status).toBe('exited');
    expect(listener).toHaveBeenCalledTimes(3);

    resetAgentSocket();
    expect(getAgentSocketSnapshot().status).toBe('idle');
    expect(getAgentSocketSnapshot().scrollback).toBe('');
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    ingestPtyFrame({ type: 'pty-data', data: 'after unsubscribe' } as PtyServerFrame);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('a project-switch reset mid-session (pty died with the socket) drops the buffered output', () => {
    markAgentStarted('shell');
    ingestPtyFrame({ type: 'pty-data', data: 'some output' } as PtyServerFrame);
    expect(getAgentSocketSnapshot().scrollback).not.toBe('');

    resetAgentSocket();
    const snap = getAgentSocketSnapshot();
    // Epoch keeps counting up (so a terminal that already saw the prior
    // epoch still notices the change) — everything else goes back to the
    // same values initialAgentSocketState() would produce.
    expect(snap).toEqual({ ...initialAgentSocketState(), epoch: snap.epoch });
  });

  it('the session summary keeps a stable identity across pure scrollback growth (no React re-render per frame)', () => {
    markAgentStarted('shell');
    const summary = getAgentSessionSummary();
    expect(summary.status).toBe('running');
    expect(summary.command).toBe('shell');

    ingestPtyFrame({ type: 'pty-data', data: 'chunk 1' } as PtyServerFrame);
    ingestPtyFrame({ type: 'pty-data', data: 'chunk 2' } as PtyServerFrame);
    // Same object: scrollback grew but nothing a component subscribes to changed.
    expect(getAgentSessionSummary()).toBe(summary);

    ingestPtyFrame({ type: 'pty-exit', code: 0 } as PtyServerFrame);
    const exited = getAgentSessionSummary();
    expect(exited).not.toBe(summary);
    expect(exited.status).toBe('exited');
    expect(exited.exitCode).toBe(0);
  });
});
