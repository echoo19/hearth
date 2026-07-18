/** Pure start guard for the shell-only Agent panel. */
import { describe, expect, it } from 'vitest';
import { shouldStartTerminal } from '../src/components/AgentPanel';

describe('shouldStartTerminal', () => {
  it('starts once a project and websocket are ready and the session is idle', () => {
    expect(shouldStartTerminal('/tmp/proj', 'connected', 'idle')).toBe(true);
  });

  it('does not start before the websocket connects or while a session exists', () => {
    expect(shouldStartTerminal('/tmp/proj', 'connecting', 'idle')).toBe(false);
    expect(shouldStartTerminal('/tmp/proj', 'connected', 'running')).toBe(false);
    expect(shouldStartTerminal('/tmp/proj', 'connected', 'exited')).toBe(false);
    expect(shouldStartTerminal(null, 'connected', 'idle')).toBe(false);
  });
});
