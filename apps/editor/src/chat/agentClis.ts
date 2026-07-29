/**
 * Which agent CLIs this machine has on PATH.
 *
 * Lives here rather than in the composer's model menu, which is where it used
 * to be. The menu once offered to type these commands into a terminal for you,
 * so the read sat beside the rows that used it. That list is gone: a terminal
 * opens empty and the person types their own command, because the set of
 * agents that work in a shell is every agent, and a menu of names read as a
 * boundary around it.
 *
 * WHAT IS LEFT IS NOT A CAPABILITY LIST. Settings still reports what it found,
 * because "is codex actually installed" is a real question with a useful
 * answer when a backend will not connect. It says nothing about what may run
 * in the terminal.
 */
import { useEffect, useState } from 'react';
import { apiAgentClis } from '../api';
import type { AgentCliInfo } from '../types';

/**
 * Loading / ready / failed, kept apart because "none installed" and "not asked
 * yet" are different answers and only one of them is the machine's.
 */
export type AgentCliRead =
  | { state: 'loading' }
  | { state: 'ready'; clis: AgentCliInfo[] }
  | { state: 'failed' };

/**
 * Read once per window, then shared: the answer is a property of the machine,
 * it costs a PATH walk, and every surface wants the same one. A CLI installed
 * while Hearth is open shows up on the next launch.
 */
let cliRead: AgentCliRead = { state: 'loading' };
let cliRequest: Promise<void> | null = null;
const cliListeners = new Set<() => void>();

function loadAgentClis(): Promise<void> {
  cliRequest ??= apiAgentClis().then((clis) => {
    cliRead = clis ? { state: 'ready', clis } : { state: 'failed' };
    // A failed read is not an answer, so it is not cached as one: the next
    // surface to mount asks again.
    if (!clis) cliRequest = null;
    for (const listener of cliListeners) listener();
  });
  return cliRequest;
}

export function useAgentClis(): AgentCliRead {
  const [read, setRead] = useState(cliRead);
  useEffect(() => {
    let alive = true;
    const settle = (): void => {
      if (alive) setRead(cliRead);
    };
    cliListeners.add(settle);
    void loadAgentClis().then(settle);
    return () => {
      alive = false;
      cliListeners.delete(settle);
    };
  }, []);
  return read;
}

/**
 * What Settings says above the list: what was found, or what went wrong
 * finding out. The failure reads as a sentence rather than a status word
 * because it doubles as the empty state's explanation, and "none installed"
 * and "the walk failed" must not look the same.
 */
export function agentCliNote(read: AgentCliRead): string {
  if (read.state === 'loading') return 'Checking your PATH…';
  if (read.state === 'failed') return 'Hearth could not read your PATH, so it cannot say what is installed.';
  return 'Agent CLIs Hearth found on this machine. Any CLI runs in the terminal, including ones not listed here.';
}
