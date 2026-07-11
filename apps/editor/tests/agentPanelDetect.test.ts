/**
 * Pure logic test for `detectionFailed`, the helper AgentPanel uses to tell
 * a genuine "couldn't check" (network/parse failure — `apiDetectAgents`
 * resolved to `null`) apart from a completed check that simply found
 * neither CLI on PATH. Mirrors codePanelSave.test.ts's style: exercise the
 * exported pure function directly instead of mounting the component (which
 * pulls in the zustand store, the WS-backed agent socket, and a lazy xterm
 * terminal with no existing mount-test precedent in this suite).
 */
import { describe, expect, it } from 'vitest';
import { detectionFailed } from '../src/components/AgentPanel';

const FOUND = { claude: { found: true }, codex: { found: false } };

describe('detectionFailed', () => {
  it('is false while a detect is still in flight', () => {
    expect(detectionFailed(true, true, null)).toBe(false);
  });

  it('is false before any detect has ever run (initial mount state)', () => {
    expect(detectionFailed(false, false, null)).toBe(false);
  });

  it('is true when a detect attempt just completed with a null result', () => {
    expect(detectionFailed(true, false, null)).toBe(true);
  });

  it('is false when a detect attempt just completed successfully, even if nothing was found', () => {
    expect(detectionFailed(true, false, { claude: { found: false }, codex: { found: false } })).toBe(false);
  });

  it('is false when a detect attempt just completed and found an agent', () => {
    expect(detectionFailed(true, false, FOUND)).toBe(false);
  });

  it('is false once already settled and not re-detecting', () => {
    expect(detectionFailed(false, false, null)).toBe(false);
  });
});
