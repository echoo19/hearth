/**
 * The terminal half of the composer's picker: which agent CLIs this machine
 * has, and what picking one of them does.
 *
 * Two halves, both pure enough to check without a shell or a socket:
 *
 *  - Detection (server/agentClis.ts) is measured, never assumed. A registry
 *    entry is a claim that Hearth knows what to type, and nothing more; a
 *    binary is only reported installed when a real executable file was found
 *    on a real PATH. The three ways that can go wrong (nothing there, a file
 *    that is not executable, a directory wearing the name) all have to read as
 *    "not installed" rather than as a launchable option, because the whole
 *    promise of the group is that everything in it will actually start.
 *  - The pick (planTerminalLaunch) decides between spawning a shell, typing
 *    into one that is already up, going back to a session that is already
 *    running this CLI, and refusing. The case worth pinning hardest is the
 *    refusal: Hearth cannot see whether the agent it typed in is still there,
 *    so it must not type a second command into a session it started an agent
 *    in — inside a running agent that is a prompt, not a command.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_CLIS, detectAgentClis, findOnPath, getAgentClis, toWire } from '../server/agentClis';
import { agentCliNote } from '../src/components/chat/ModelSelector';
import { planTerminalLaunch, terminalLaunchInput } from '../src/components/agent/useAgentSocket';
import type { AgentCliInfo } from '../src/types';

const onWindows = process.platform === 'win32';

let binDir = '';
let emptyDir = '';

async function writeBin(dir: string, name: string, mode: number): Promise<void> {
  const file = path.join(dir, name);
  await fsp.writeFile(file, '#!/bin/sh\nexit 0\n');
  await fsp.chmod(file, mode);
}

beforeEach(async () => {
  binDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-bin-'));
  emptyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-empty-'));
});

afterEach(async () => {
  await fsp.rm(binDir, { recursive: true, force: true });
  await fsp.rm(emptyDir, { recursive: true, force: true });
});

describe('the registry', () => {
  it('knows the three CLIs, in a fixed order, each with a command to type', () => {
    expect(AGENT_CLIS.map((cli) => cli.id)).toEqual(['claude', 'codex', 'hermes']);
    expect(AGENT_CLIS.map((cli) => cli.command)).toEqual(['claude', 'codex', 'hermes']);
    expect(AGENT_CLIS.map((cli) => cli.label)).toEqual(['Claude Code', 'Codex', 'Hermes']);
  });

  it('claims an install hint only where Hearth actually knows one', () => {
    // Hermes is a binary the user has. Hearth knows its name and nothing else,
    // and inventing a package to install would be inventing a capability.
    const hermes = AGENT_CLIS.find((cli) => cli.id === 'hermes');
    expect(hermes?.installHint).toBeNull();
    expect(AGENT_CLIS.find((cli) => cli.id === 'codex')?.installHint).toBe('npm i -g @openai/codex');
  });

  it('gives every entry its own id', () => {
    expect(new Set(AGENT_CLIS.map((cli) => cli.id)).size).toBe(AGENT_CLIS.length);
  });
});

describe('findOnPath', () => {
  it('finds an executable and answers with where it is', async () => {
    await writeBin(binDir, 'claude', 0o755);
    expect(await findOnPath('claude', binDir)).toBe(path.join(binDir, 'claude'));
  });

  it('answers null when nothing by that name is there', async () => {
    expect(await findOnPath('claude', emptyDir)).toBeNull();
  });

  it.skipIf(onWindows)('refuses a file that is not executable', async () => {
    // A downloaded-but-unchmodded file is exactly the case that would offer a
    // row which fails the moment it is picked.
    await writeBin(binDir, 'codex', 0o644);
    expect(await findOnPath('codex', binDir)).toBeNull();
  });

  it('refuses a directory wearing the name', async () => {
    await fsp.mkdir(path.join(binDir, 'hermes'));
    expect(await findOnPath('hermes', binDir)).toBeNull();
  });

  it('walks PATH left to right and takes the first hit', async () => {
    const second = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-bin2-'));
    try {
      await writeBin(binDir, 'claude', 0o755);
      await writeBin(second, 'claude', 0o755);
      const found = await findOnPath('claude', [binDir, second].join(path.delimiter));
      expect(found).toBe(path.join(binDir, 'claude'));
    } finally {
      await fsp.rm(second, { recursive: true, force: true });
    }
  });

  it('ignores empty PATH entries rather than searching the working directory', async () => {
    expect(await findOnPath('claude', '')).toBeNull();
    expect(await findOnPath('claude', `${path.delimiter}${path.delimiter}`)).toBeNull();
  });
});

describe('detectAgentClis', () => {
  it('reports the whole registry, installed or not, so the picker can say why', async () => {
    await writeBin(binDir, 'claude', 0o755);
    const found = await detectAgentClis({ PATH: binDir });

    expect(found.map((cli) => cli.id)).toEqual(['claude', 'codex', 'hermes']);
    expect(found.map((cli) => cli.installed)).toEqual([true, false, false]);
    expect(found[0].path).toBe(path.join(binDir, 'claude'));
    expect(found[1].path).toBeNull();
  });

  it('reports nothing installed when PATH is empty rather than failing', async () => {
    const found = await detectAgentClis({ PATH: '' });
    expect(found.every((cli) => !cli.installed)).toBe(true);
  });

  it('keeps the resolved path off the wire, and the install hint on it', () => {
    const wire = toWire({
      id: 'codex',
      command: 'codex',
      label: 'Codex',
      installHint: 'npm i -g @openai/codex',
      installed: true,
      path: '/somewhere/codex',
    });
    expect(wire).toEqual({
      id: 'codex',
      command: 'codex',
      label: 'Codex',
      installed: true,
      installHint: 'npm i -g @openai/codex',
    });
  });

  it('answers the route shape the picker reads', async () => {
    const result = await getAgentClis();
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; clis: { id: string }[] };
    expect(body.ok).toBe(true);
    expect(body.clis.map((cli) => cli.id)).toEqual(['claude', 'codex', 'hermes']);
  });
});

describe('the Terminal group’s read-out', () => {
  it('keeps "not asked yet" and "asked and got nothing" apart', () => {
    // A list that failed to load must not read as a machine with nothing on
    // it: one is Hearth's problem, the other is the user's.
    expect(agentCliNote({ state: 'loading' })).toBe('Checking…');
    expect(agentCliNote({ state: 'failed' })).toBe('Could not check your PATH');
    expect(agentCliNote({ state: 'ready', clis: [] })).toBe('Your own CLI, in a shell');
  });
});

// ---------------------------------------------------------------------------
// What picking one does
// ---------------------------------------------------------------------------

const CLAUDE_CODE: AgentCliInfo = {
  id: 'claude',
  command: 'claude',
  label: 'Claude Code',
  installed: true,
  installHint: 'npm i -g @anthropic-ai/claude-code',
};

const HERMES: AgentCliInfo = { id: 'hermes', command: 'hermes', label: 'Hermes', installed: true, installHint: null };

/** A machine with everything working and nothing running yet. */
function request(over: Partial<Parameters<typeof planTerminalLaunch>[0]> = {}) {
  return {
    cli: CLAUDE_CODE,
    status: 'idle' as const,
    launched: null,
    connected: true,
    hasProject: true,
    ...over,
  };
}

describe('planTerminalLaunch', () => {
  it('starts a shell and types the command when there is no session', () => {
    expect(planTerminalLaunch(request())).toEqual({ action: 'start', input: 'claude\n' });
    expect(planTerminalLaunch(request({ status: 'exited' }))).toEqual({ action: 'start', input: 'claude\n' });
  });

  it('types into a shell that is already up with nothing of ours in it', () => {
    expect(planTerminalLaunch(request({ status: 'running' }))).toEqual({ action: 'type', input: 'claude\n' });
  });

  it('sends the command followed by Return, and nothing else', () => {
    // The shell is not replaced: it runs the agent as a child, so quitting the
    // agent leaves a working prompt rather than a dead session.
    expect(terminalLaunchInput('hermes')).toBe('hermes\n');
  });

  it('treats picking what is already running as a way back to it', () => {
    const launched = { id: 'claude', label: 'Claude Code' };
    expect(planTerminalLaunch(request({ status: 'running', launched }))).toEqual({ action: 'show' });
    // Same during a reconnect: the server hands back the same pty with the
    // same agent in it, so there is nothing to start.
    expect(planTerminalLaunch(request({ status: 'reconnecting', launched }))).toEqual({ action: 'show' });
  });

  it('refuses to type into a session Hearth already started an agent in', () => {
    const plan = planTerminalLaunch({
      ...request({ status: 'running' }),
      cli: HERMES,
      launched: { id: 'claude', label: 'Claude Code' },
    });
    expect(plan).toEqual({
      action: 'blocked',
      reason: 'Hearth started Claude Code in this terminal. Stop the session to start something else.',
    });
  });

  it('refuses while the connection is not there, without pretending it queued', () => {
    for (const over of [{ connected: false }, { status: 'reconnecting' as const }]) {
      const plan = planTerminalLaunch(request(over));
      expect(plan).toEqual({
        action: 'blocked',
        reason: 'The terminal is not connected yet. Try again in a moment.',
      });
    }
  });

  it('refuses without a folder, because the terminal runs in one', () => {
    expect(planTerminalLaunch(request({ hasProject: false }))).toEqual({
      action: 'blocked',
      reason: 'Open a project first. The terminal runs in the project folder.',
    });
  });

  it('refuses what is not installed, and says how to fix it when it knows', () => {
    expect(planTerminalLaunch(request({ cli: { ...CLAUDE_CODE, installed: false } }))).toEqual({
      action: 'blocked',
      reason: 'Hearth did not find claude on your PATH. Install it with npm i -g @anthropic-ai/claude-code.',
    });
    // No hint means no guess: the sentence stops at what Hearth knows.
    expect(planTerminalLaunch(request({ cli: { ...HERMES, installed: false } }))).toEqual({
      action: 'blocked',
      reason: 'Hearth did not find hermes on your PATH.',
    });
  });

  it('answers "not installed" before anything else, whatever the session is doing', () => {
    const plan = planTerminalLaunch(
      request({ cli: { ...HERMES, installed: false }, status: 'running', connected: false, hasProject: false }),
    );
    expect(plan.action).toBe('blocked');
    expect(plan).toHaveProperty('reason', 'Hearth did not find hermes on your PATH.');
  });
});
