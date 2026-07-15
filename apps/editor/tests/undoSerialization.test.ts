/**
 * B5 follow-up (undo/redo serialization, store layer): rapid ⌘Z mashing fires
 * one undo() per keypress, each a separate /api/command request. If those
 * requests depart concurrently they race the per-request server-side history
 * cursor and presses are lost. store.undo()/redo() therefore chain through one
 * per-store promise (queueHistoryOp) so a second request never departs before
 * the first has fully landed — 10 mashes ⇒ 10 requests, strictly sequential.
 *
 * Drives the real useEditor store with api mocked, same harness as
 * agentDiffRefresh.test.ts. The mock yields inside each 'undo'/'redo' so an
 * unserialized implementation WOULD interleave (all starts before any end);
 * the strict start→end alternation asserts serialization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/types';

const { apiCommand, apiOpenProject, apiCreateProject, apiMeta, apiDetectAgents, fileUrl } = vi.hoisted(() => ({
  apiCommand: vi.fn(),
  apiOpenProject: vi.fn(),
  apiCreateProject: vi.fn(),
  apiMeta: vi.fn(async () => null),
  apiDetectAgents: vi.fn(async () => null),
  fileUrl: vi.fn((project: string, relPath: string) => `http://localhost/${project}/${relPath}`),
}));

vi.mock('../src/api', () => ({ apiCommand, apiOpenProject, apiCreateProject, apiMeta, apiDetectAgents, fileUrl }));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  close(): void {}
  send(): void {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
(globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: 'localhost:0' };

import { useEditor } from '../src/store';

function ok<T>(data: T, over: Partial<CommandResult<T>> = {}): CommandResult<T> {
  return { success: true, command: 'x', data, errors: [], warnings: [], changed: [], files: [], suggestions: [], ...over };
}

const PROJECT_INFO = {
  id: 'proj',
  name: 'Test Project',
  description: '',
  hearthVersion: '0.0.0',
  formatVersion: 1,
  initialScene: 'sceneA',
  scenes: [{ id: 'sceneA', name: 'Scene A', path: 'scenes/a.json', entityCount: 0 }],
  assetCount: 0,
  scriptCount: 0,
  scripts: [],
  playtestCount: 0,
  inputActions: {},
  inputMappings: {},
  buildSettings: {},
};
const SCENE_A = { id: 'sceneA', name: 'Scene A', isInitial: true, entityCount: 0, entities: [] };

beforeEach(() => {
  apiCommand.mockReset();
  apiOpenProject.mockReset();
  apiCreateProject.mockReset();
  apiOpenProject.mockImplementation(async (path: string) => ({ ok: true, path, info: PROJECT_INFO }));
  FakeWebSocket.instances = [];
});

afterEach(() => {
  useEditor.getState().closeProject();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * An api mock that records the interleaving of history ops: each 'undo'/'redo'
 * pushes `start:<n>`, yields a macrotask, then pushes `end:<n>`. Serialized
 * dispatch produces a strict start,end,start,end,… order; a concurrent one
 * would emit every start before the first end.
 */
function makeOrderingApi(events: string[]) {
  let seq = 0;
  return async (_project: string, name: string) => {
    switch (name) {
      case 'inspectComponents':
        return ok({ components: [] });
      case 'inspectProject':
        return ok(PROJECT_INFO);
      case 'inspectScene':
        return ok(SCENE_A);
      case 'inspectAssets':
        return ok({ assets: [] });
      case 'undo':
      case 'redo': {
        const n = ++seq;
        events.push(`start:${n}`);
        await tick();
        events.push(`end:${n}`);
        const key = name === 'undo' ? 'undone' : 'redone';
        return ok({ [key]: 'moveEntity', seq: n });
      }
      default:
        return ok({});
    }
  };
}

describe('B5 (undo/redo serialization): store chains rapid history ops', () => {
  it('10 rapid undos run strictly sequentially (10 requests, no interleave)', async () => {
    const events: string[] = [];
    apiCommand.mockImplementation(makeOrderingApi(events));
    await useEditor.getState().openProject('/tmp/proj');

    // Mash 10× WITHOUT awaiting between presses — the real ⌘Z-repeat scenario.
    const presses: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) presses.push(useEditor.getState().undo());
    await Promise.all(presses);

    const undoCalls = apiCommand.mock.calls.filter((c) => c[1] === 'undo');
    expect(undoCalls).toHaveLength(10);

    // Strict alternation proves each request landed before the next departed.
    const expected: string[] = [];
    for (let n = 1; n <= 10; n++) expected.push(`start:${n}`, `end:${n}`);
    expect(events).toEqual(expected);
  });

  it('interleaved undo/redo presses stay ordered on the shared queue', async () => {
    const events: string[] = [];
    apiCommand.mockImplementation(makeOrderingApi(events));
    await useEditor.getState().openProject('/tmp/proj');

    const presses = [
      useEditor.getState().undo(),
      useEditor.getState().redo(),
      useEditor.getState().undo(),
      useEditor.getState().redo(),
    ];
    await Promise.all(presses);

    // No two starts back-to-back: every op fully lands before the next departs.
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]).toMatch(/^start:/);
      expect(events[i + 1]).toMatch(/^end:/);
    }
    expect(events).toHaveLength(8);
  });
});
