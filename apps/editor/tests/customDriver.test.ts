/**
 * CustomDriver against a scripted agent.
 *
 * The fake below speaks the real newline-delimited JSON over an in-memory pipe,
 * so the driver runs its REAL handshake, its real decoder and its real approval
 * bookkeeping. There is no subprocess, nothing installed, and nothing about the
 * protocol stubbed out except where the bytes come from.
 *
 * What matters most here is the honesty of the permission story. Hearth does
 * not own this agent's tool loop and cannot gate it, so:
 *
 *   - an agent that does not claim approvals gets exactly one `notice` per
 *     turn saying so, and its approval requests are NOT dressed up as gates;
 *   - an agent that does claim them blocks on a real `approval-request` and is
 *     answered by id, with Hearth emitting the resolution;
 *   - a driver that is torn down while an approval is live answers it and says
 *     so on the transcript, so no window is left holding a prompt nothing can
 *     resolve.
 */
import { describe, expect, it } from 'vitest';
import { CustomDriver, type CustomTransport } from '../server/chatDrivers/custom';
import type { ChatEvent } from '../server/chat';
import type { CustomAgent } from '../server/agentRegistry';
import type { PermissionMode } from '../server/permissionMode';

/** A scripted agent. `sent` records every frame the driver wrote. */
class FakeAgent implements CustomTransport {
  sent: Record<string, unknown>[] = [];
  killed = false;
  private onDataCb: ((chunk: string) => void) | null = null;
  private onCloseCb: ((reason: string) => void) | null = null;

  write(line: string): void {
    this.sent.push(JSON.parse(line.trim()) as Record<string, unknown>);
  }
  onData(handler: (chunk: string) => void): void {
    this.onDataCb = handler;
  }
  onClose(handler: (reason: string) => void): void {
    this.onCloseCb = handler;
  }
  kill(): void {
    this.killed = true;
  }

  /** Push raw bytes at the driver, exactly as stdout would. */
  emit(chunk: string): void {
    this.onDataCb?.(chunk);
  }
  say(value: unknown): void {
    this.emit(`${JSON.stringify(value)}\n`);
  }
  ready(supports?: Record<string, unknown>): void {
    this.say({ type: 'ready', protocol: 0, ...(supports ? { supports } : {}) });
  }
  close(reason: string): void {
    this.onCloseCb?.(reason);
  }
  framesOf(type: string): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame.type === type);
  }
}

const AGENT: CustomAgent = {
  id: 'my-agent',
  label: 'My agent',
  command: 'my-agent',
  args: ['--serve'],
  confirmedCommand: 'my-agent --serve',
};

/**
 * One long-lived reader over a driver's events. Deliberately not a `for await`
 * per assertion: EventQueue closes itself when an iterator is abandoned early,
 * so a second loop would read from a dead queue.
 */
function reader(source: AsyncIterable<ChatEvent>): { next(count: number): Promise<ChatEvent[]> } {
  const iterator = source[Symbol.asyncIterator]();
  return {
    async next(count: number): Promise<ChatEvent[]> {
      const out: ChatEvent[] = [];
      while (out.length < count) {
        const result = await iterator.next();
        if (result.done) break;
        out.push(result.value);
      }
      return out;
    },
  };
}

function makeDriver(opts?: { permissionMode?: PermissionMode; agent?: Partial<CustomAgent> }): {
  driver: CustomDriver;
  fake: FakeAgent;
  spawned: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[];
} {
  const fake = new FakeAgent();
  const spawned: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const driver = new CustomDriver(
    { ...AGENT, ...opts?.agent },
    '/usr/local/bin/my-agent',
    { PATH: '/usr/local/bin', HEARTH_PROJECT_ROOT: '/w/game' },
    (command, args, cwd, env) => {
      spawned.push({ command, args, cwd, env });
      return fake;
    },
    null,
    opts?.permissionMode ?? 'auto',
  );
  return { driver, fake, spawned };
}

/** Bind a driver whose agent answers the handshake as soon as it is spawned. */
async function bound(opts?: Parameters<typeof makeDriver>[0] & { supports?: Record<string, unknown> }): Promise<{
  driver: CustomDriver;
  fake: FakeAgent;
  events: ReturnType<typeof reader>;
}> {
  const { driver, fake } = makeDriver(opts);
  const events = reader(driver.events);
  const start = driver.start('chat-1', '/w/game');
  fake.ready(opts?.supports ?? { approvals: true, permissionModes: ['ask', 'auto', 'skip'] });
  await start;
  return { driver, fake, events };
}

describe('binding', () => {
  it('spawns the resolved binary with the registered arguments, in the project', async () => {
    const { driver, fake, spawned } = makeDriver();
    const start = driver.start('chat-1', '/w/game');
    fake.ready({ approvals: true });
    await start;
    expect(spawned[0].command).toBe('/usr/local/bin/my-agent');
    expect(spawned[0].args).toEqual(['--serve']);
    expect(spawned[0].cwd).toBe('/w/game');
    driver.stop();
  });

  it('FAILS the bind when the first line is not a handshake, and kills the child', async () => {
    const { driver, fake } = makeDriver();
    const start = driver.start('chat-1', '/w/game');
    fake.say({ type: 'message-delta', text: 'hello?' });
    await expect(start).rejects.toThrow(/handshake/i);
    expect(fake.killed).toBe(true);
  });

  it('FAILS the bind on a protocol version this build does not speak', async () => {
    const { driver, fake } = makeDriver();
    const start = driver.start('chat-1', '/w/game');
    fake.say({ type: 'ready', protocol: 99 });
    await expect(start).rejects.toThrow(/protocol 99/);
    expect(fake.killed).toBe(true);
  });

  it('FAILS the bind when the program exits before saying anything', async () => {
    const { driver, fake } = makeDriver();
    const start = driver.start('chat-1', '/w/game');
    fake.close('exit code 127');
    await expect(start).rejects.toThrow(/exit code 127/);
  });

  it('reads a handshake and the first events out of ONE chunk', async () => {
    const { driver, fake } = makeDriver();
    const events = reader(driver.events);
    const start = driver.start('chat-1', '/w/game');
    fake.emit('{"type":"ready","protocol":0,"supports":{"approvals":true}}\n{"type":"message-delta","text":"hi"}\n');
    await start;
    expect(await events.next(1)).toEqual([{ type: 'message-delta', text: 'hi' }]);
    driver.stop();
  });
});

describe('a turn', () => {
  it('writes one prompt frame carrying the words, the mode and a turn id', async () => {
    const { driver, fake } = await bound({ permissionMode: 'ask' });
    driver.send('make a platformer');
    const prompts = fake.framesOf('prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ text: 'make a platformer', permissionMode: 'ask', turnId: 't1' });
    driver.stop();
  });

  it('queues a turn sent before the handshake, rather than losing it', async () => {
    const { driver, fake } = makeDriver();
    const start = driver.start('chat-1', '/w/game');
    driver.send('early');
    fake.ready({ approvals: true });
    await start;
    expect(fake.framesOf('prompt')[0]).toMatchObject({ text: 'early' });
    driver.stop();
  });

  it('streams prose and ends on turn-complete', async () => {
    const { driver, fake, events } = await bound();
    driver.send('hi');
    fake.say({ type: 'message-delta', text: 'one' });
    fake.say({ type: 'turn-complete' });
    expect(await events.next(2)).toEqual([{ type: 'message-delta', text: 'one' }, { type: 'turn-complete' }]);
    driver.stop();
  });

  it('drops an event it does not know without ending the turn', async () => {
    const { driver, fake, events } = await bound();
    driver.send('hi');
    fake.say({ type: 'quantum-flux' });
    fake.say({ type: 'turn-complete' });
    expect(await events.next(1)).toEqual([{ type: 'turn-complete' }]);
    driver.stop();
  });

  it('interrupts the turn it is actually on, and not between turns', async () => {
    const { driver, fake } = await bound();
    driver.interrupt();
    expect(fake.framesOf('interrupt')).toHaveLength(0);
    driver.send('hi');
    driver.interrupt();
    expect(fake.framesOf('interrupt')[0]).toMatchObject({ turnId: 't1' });
    driver.stop();
  });
});

describe('permissions, said honestly', () => {
  it('carries ONE notice per turn when the agent did not claim approvals', async () => {
    const { driver, fake, events } = await bound({ supports: {}, permissionMode: 'auto' });
    driver.send('hi');
    const [notice] = await events.next(1);
    expect(notice).toMatchObject({ type: 'notice' });
    expect((notice as { text: string }).text).toContain('enforces its own permissions');
    fake.say({ type: 'turn-complete' });
    driver.send('again');
    // The second turn says it again, once, rather than saying it twice or
    // going quiet after the first message of the conversation.
    const next = await events.next(2);
    expect(next.filter((event) => event.type === 'notice')).toHaveLength(1);
    driver.stop();
  });

  it('says nothing extra when the agent DOES claim approvals', async () => {
    const { driver, fake, events } = await bound({ supports: { approvals: true } });
    driver.send('hi');
    fake.say({ type: 'message-delta', text: 'working' });
    expect(await events.next(1)).toEqual([{ type: 'message-delta', text: 'working' }]);
    driver.stop();
  });

  it('does not dress an unclaimed approval up as a gate', async () => {
    const { driver, fake, events } = await bound({ supports: {} });
    driver.send('hi');
    await events.next(1); // the per-turn notice
    fake.say({ type: 'approval-request', approvalId: 'a1', kind: 'command', title: 'Run rm -rf /?' });
    const [event] = await events.next(1);
    // A notice, because an Allow / Deny prompt would claim Hearth could stop
    // it, and the same turn has already said it cannot.
    expect(event.type).toBe('notice');
    expect((event as { text: string }).text).toContain('Run rm -rf /?');
    driver.stop();
  });

  it('blocks on a claimed approval and answers it by id', async () => {
    const { driver, fake, events } = await bound({ supports: { approvals: true } });
    driver.send('hi');
    fake.say({ type: 'approval-request', approvalId: 'a1', kind: 'command', title: 'Run npm test?' });
    expect(await events.next(1)).toEqual([
      { type: 'approval-request', approvalId: 'a1', kind: 'command', title: 'Run npm test?', detail: '' },
    ]);
    driver.approve('a1', 'allow');
    expect(fake.framesOf('approval')[0]).toEqual({ type: 'approval', approvalId: 'a1', decision: 'allow' });
    // Hearth emits the resolution, so every window watching agrees.
    expect(await events.next(1)).toEqual([{ type: 'approval-resolved', approvalId: 'a1', decision: 'allow' }]);
    driver.stop();
  });

  it('ignores an answer to an approval nobody raised', async () => {
    const { driver, fake } = await bound({ supports: { approvals: true } });
    driver.approve('never-asked', 'allow');
    expect(fake.framesOf('approval')).toHaveLength(0);
    driver.stop();
  });

  it('denies anything still blocking when it is torn down, on the wire AND on screen', async () => {
    const { driver, fake, events } = await bound({ supports: { approvals: true } });
    driver.send('hi');
    fake.say({ type: 'approval-request', approvalId: 'a1', kind: 'command', title: 'Run npm test?' });
    await events.next(1);
    driver.stop();
    expect(fake.framesOf('approval')[0]).toEqual({ type: 'approval', approvalId: 'a1', decision: 'deny' });
    expect(await events.next(1)).toEqual([{ type: 'approval-resolved', approvalId: 'a1', decision: 'deny' }]);
  });
});

describe('when the agent goes away', () => {
  it('reports an exit as an error, which is what ends the turn', async () => {
    const { driver, fake, events } = await bound({ supports: { approvals: true } });
    driver.send('hi');
    fake.close('exit code 1');
    const [event] = await events.next(1);
    expect(event.type).toBe('error');
    expect((event as { message: string }).message).toContain('My agent');
    expect((event as { message: string }).message).toContain('exit code 1');
  });

  it('ends its stream and reads dead, so ws.ts can bind a fresh backend', async () => {
    const { driver, fake, events } = await bound({ supports: { approvals: true } });
    fake.close('exit code 1');
    expect(driver.dead).toBe(true);
    // The error, then the end of the stream: `next(5)` returns what there is.
    expect(await events.next(5)).toHaveLength(1);
    driver.send('into the void');
    expect(fake.framesOf('prompt')).toHaveLength(0);
  });

  it('asks the child to leave before killing it', async () => {
    const { driver, fake } = await bound({ supports: { approvals: true } });
    driver.stop();
    expect(fake.framesOf('shutdown')).toHaveLength(1);
    expect(fake.killed).toBe(true);
  });

  it('ends the conversation on a line too large to read', async () => {
    const { driver, fake, events } = await bound({ supports: { approvals: true } });
    driver.send('hi');
    fake.emit('x'.repeat(1024 * 1024 + 1));
    const [event] = await events.next(1);
    expect(event.type).toBe('error');
    expect(driver.dead).toBe(true);
  });
});
