/**
 * The conversation backend: the push queue every driver emits through, the
 * always-available stub, per-folder key resolution, and the defensive mapping
 * from the Agent SDK's untyped message stream onto ChatEvents.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSdkDriver,
  EventQueue,
  STUB_REPLY,
  StubDriver,
  createChatDriver,
  describeToolInput,
  mapSdkMessage,
  readAppSettings,
  resolveApiKey,
  writeAppSettings,
  type ChatEvent,
} from '../server/chat';

async function drain(source: AsyncIterable<ChatEvent>, until: number): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of source) {
    out.push(event);
    if (out.length >= until) break;
  }
  return out;
}

describe('EventQueue', () => {
  it('buffers values pushed before anyone iterates', async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    const seen: number[] = [];
    for await (const value of queue) seen.push(value);
    expect(seen).toEqual([1, 2]);
  });

  it('wakes a waiting consumer with a later push', async () => {
    const queue = new EventQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.push(7);
    expect(await pending).toEqual({ value: 7, done: false });
  });

  it('ends the iteration on close and ignores pushes after it', async () => {
    const queue = new EventQueue<number>();
    queue.close();
    queue.push(1);
    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(true);
  });
});

describe('StubDriver', () => {
  it('streams the guidance reply and ends the turn', async () => {
    const driver = new StubDriver();
    await driver.start('s1', '/tmp');
    driver.send('make a shooter');
    const lines = STUB_REPLY.split('\n').length;
    const events = await drain(driver.events, lines + 1);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
    const text = events
      .filter((e): e is { type: 'text-delta'; text: string } => e.type === 'text-delta')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).toContain('Terminal');
    driver.stop();
  });

  it('goes quiet after stop', async () => {
    const driver = new StubDriver();
    driver.stop();
    driver.send('anything');
    const iterator = driver.events[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(true);
  });
});

describe('per-folder settings', () => {
  let dir: string;
  const previousKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-chat-'));
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  it('reports no settings for a folder that has none', async () => {
    expect(await readAppSettings(dir)).toEqual({});
    expect(await resolveApiKey(dir)).toBeNull();
  });

  it('round-trips a key through .hearth/app.json', async () => {
    await writeAppSettings(dir, { apiKey: 'sk-test' });
    expect(await readAppSettings(dir)).toEqual({ apiKey: 'sk-test' });
    expect(await resolveApiKey(dir)).toBe('sk-test');
    const raw = await fsp.readFile(path.join(dir, '.hearth', 'app.json'), 'utf8');
    expect(JSON.parse(raw).apiKey).toBe('sk-test');
  });

  it('clears the key when saved empty rather than storing a blank', async () => {
    await writeAppSettings(dir, { apiKey: 'sk-test' });
    await writeAppSettings(dir, { apiKey: '   ' });
    expect(await readAppSettings(dir)).toEqual({});
  });

  it("prefers the folder's key over the environment", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    expect(await resolveApiKey(dir)).toBe('sk-env');
    await writeAppSettings(dir, { apiKey: 'sk-folder' });
    expect(await resolveApiKey(dir)).toBe('sk-folder');
  });

  it('falls back to the stub with no key at all', async () => {
    const driver = await createChatDriver(dir);
    expect(driver.kind).toBe('stub');
    driver.stop();
  });
});

describe('mapSdkMessage', () => {
  it('turns a partial content-block delta into text', () => {
    expect(
      mapSdkMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      }),
    ).toEqual([{ type: 'text-delta', text: 'hi' }]);
  });

  it('turns a tool_use block into a tool-start with a readable detail', () => {
    expect(
      mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/game.js' } }] },
      }),
    ).toEqual([{ type: 'tool-start', id: 't1', name: 'Write', detail: '/w/game.js' }]);
  });

  it('turns a tool_result into a tool-end carrying success', () => {
    expect(
      mapSdkMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
    ).toEqual([{ type: 'tool-end', id: 't1', ok: true }]);
    expect(
      mapSdkMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
      }),
    ).toEqual([{ type: 'tool-end', id: 't1', ok: false }]);
  });

  it('ends the turn on a result, and reports a failing one as an error', () => {
    expect(mapSdkMessage({ type: 'result' })).toEqual([{ type: 'done' }]);
    expect(mapSdkMessage({ type: 'result', is_error: true, result: 'rate limited' })).toEqual([
      { type: 'error', message: 'rate limited' },
    ]);
  });

  it('yields nothing (rather than throwing) on a shape it does not know', () => {
    expect(mapSdkMessage(null)).toEqual([]);
    expect(mapSdkMessage({ type: 'assistant' })).toEqual([]);
    expect(mapSdkMessage({ type: 'stream_event', event: { type: 'ping' } })).toEqual([]);
    expect(mapSdkMessage('nonsense')).toEqual([]);
  });
});

describe('describeToolInput', () => {
  it('prefers the field a person would recognise', () => {
    expect(describeToolInput({ file_path: '/w/a.js', other: 1 })).toBe('/w/a.js');
    expect(describeToolInput({ command: 'npm test' })).toBe('npm test');
  });

  it('says nothing when there is nothing readable', () => {
    expect(describeToolInput({ depth: 3 })).toBeUndefined();
    expect(describeToolInput(null)).toBeUndefined();
  });

  it('truncates a very long value rather than flooding the chip', () => {
    const detail = describeToolInput({ command: 'x'.repeat(400) })!;
    expect(detail.length).toBeLessThanOrEqual(160);
    expect(detail.endsWith('…')).toBe(true);
  });
});

describe('AgentSdkDriver', () => {
  it('maps a scripted SDK stream onto chat events, cwd-bound to the folder', async () => {
    let options: Record<string, unknown> = {};
    const sdk = {
      query: (args: unknown) => {
        options = ((args as Record<string, unknown>).options ?? {}) as Record<string, unknown>;
        return (async function* () {
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } };
          yield { type: 'result' };
        })();
      },
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    const events = await drain(driver.events, 2);
    expect(events).toEqual([{ type: 'text-delta', text: 'ok' }, { type: 'done' }]);
    expect(options.cwd).toBe('/w/game');
    expect(options.permissionMode).toBe('acceptEdits');
    driver.stop();
  });

  it('reports a thrown backend failure as an error event, not a crash', async () => {
    const sdk = {
      query: () =>
        (async function* () {
          throw new Error('backend exploded');
          // eslint-disable-next-line no-unreachable
          yield null;
        })(),
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    const [event] = await drain(driver.events, 1);
    expect(event).toEqual({ type: 'error', message: 'backend exploded' });
    driver.stop();
  });
});
