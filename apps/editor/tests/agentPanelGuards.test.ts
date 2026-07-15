/**
 * Pure logic tests for the two Agent-panel disable guards:
 *
 *  - AGENT-1 (L-089): `startDisabledReason` — the primary launch action
 *    (Start agent / Open Terminal) must be disabled with a reason once a
 *    session is running, so switching the launcher dropdown never
 *    re-enables a clickable button that would silently kill a live pty
 *    (`startPty` unconditionally kills the existing one before spawning).
 *  - AGENT-3 (L-091): `modePickerDisabledReason` — the permission-mode
 *    picker is only consumed by the server when the launcher is Claude;
 *    for codex/shell it's inert and should say why.
 *
 * Mirrors agentPanelDetect.test.ts's style: exercise the exported pure
 * functions directly (no jsdom/RTL in this repo's test toolchain).
 */
import { describe, expect, it } from 'vitest';
import {
  modePickerDisabledReason,
  shouldRedetectAfterInstall,
  startDisabledReason,
} from '../src/components/AgentPanel';

describe('startDisabledReason', () => {
  it('is null (enabled) when idle with a project open', () => {
    expect(startDisabledReason(false, '/tmp/proj')).toBeNull();
  });

  it('names "stop the session" when a session is already running, regardless of project', () => {
    expect(startDisabledReason(true, '/tmp/proj')).toBe('Stop the current session first.');
    expect(startDisabledReason(true, null)).toBe('Stop the current session first.');
  });

  it('names "open a project" when idle with no project open', () => {
    expect(startDisabledReason(false, null)).toBe('Open a project first.');
  });

  it('the running reason takes precedence over the no-project reason', () => {
    // A muscle-memory click after switching launcher must always read
    // "stop the session", never fall through to a different message.
    expect(startDisabledReason(true, null)).not.toBe('Open a project first.');
  });
});

describe('startDisabledReason also gates "Install Claude Code"', () => {
  // installClaude() spawns a shell pty just like Start agent does, so the
  // Install button shares the exact same guard: while its own install
  // session (or any other session) runs, a click would silently kill it.
  it('disables Install while the install session itself is running', () => {
    expect(startDisabledReason(true, '/tmp/proj')).toBe('Stop the current session first.');
  });
});

describe('shouldRedetectAfterInstall — auto re-detect when the install session exits', () => {
  it('fires when the pending install session has exited', () => {
    expect(shouldRedetectAfterInstall(3, { epoch: 3, status: 'exited' })).toBe(true);
  });

  it('does not fire while the install session is still running', () => {
    expect(shouldRedetectAfterInstall(3, { epoch: 3, status: 'running' })).toBe(false);
  });

  it('does not fire when no install is pending', () => {
    expect(shouldRedetectAfterInstall(null, { epoch: 3, status: 'exited' })).toBe(false);
  });

  it("does not fire for a LATER unrelated session's exit (epoch mismatch)", () => {
    expect(shouldRedetectAfterInstall(3, { epoch: 4, status: 'exited' })).toBe(false);
  });

  it('does not fire on the idle state a reset leaves behind', () => {
    // resetAgentSocket bumps the epoch and returns to idle — neither the
    // status nor (usually) the epoch matches, but guard both anyway.
    expect(shouldRedetectAfterInstall(3, { epoch: 4, status: 'idle' })).toBe(false);
  });
});

describe('modePickerDisabledReason', () => {
  it('is null (enabled) for the Claude launcher', () => {
    expect(modePickerDisabledReason('claude')).toBeNull();
  });

  it('names why for Codex — the server never reads mode for it', () => {
    const reason = modePickerDisabledReason('codex');
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/Codex/);
  });

  it('names why for the shell/other-CLI launcher', () => {
    const reason = modePickerDisabledReason('shell');
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/Terminal/);
  });
});
