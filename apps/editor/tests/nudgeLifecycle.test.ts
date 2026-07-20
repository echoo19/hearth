/**
 * Store-level regression test for the nudge-timer teardown fix: a
 * pending arrow-key nudge burst must not fire a stale `moveEntity` exec
 * after the project/scene it targeted is gone. Exercises the real
 * `useEditor` store (not just nudgeQueue.ts in isolation) so the actual
 * closeProject/selectScene/openProject wiring is under test, with the API
 * client and WebSocket mocked out (this suite runs in vitest's node
 * environment — no DOM, no real network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/types';

const { apiCommand, apiOpenProject, apiCreateProject, apiMeta } = vi.hoisted(() => ({
  apiCommand: vi.fn(),
  apiOpenProject: vi.fn(),
  apiCreateProject: vi.fn(),
  apiMeta: vi.fn(async () => null),
}));

vi.mock('../src/api', () => ({
  apiCommand,
  apiOpenProject,
  apiCreateProject,
  apiMeta,
}));

// afterOpen() opens a WebSocket and reads location.host; neither is
// meaningful in this headless suite, so stub both with inert fakes.
class FakeWebSocket {
  static OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  close(): void {}
  send(): void {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
(globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: 'localhost:0' };

import { useEditor } from '../src/store';

function ok<T>(data: T): CommandResult<T> {
  return { success: true, command: 'x', data, errors: [], warnings: [], changed: [], files: [], suggestions: [] };
}

const PROJECT_INFO = {
  id: 'proj',
  name: 'Test Project',
  description: '',
  hearthVersion: '0.0.0',
  formatVersion: 1,
  initialScene: 'sceneA',
  scenes: [
    { id: 'sceneA', name: 'Scene A', path: 'scenes/a.json', entityCount: 1 },
    { id: 'sceneB', name: 'Scene B', path: 'scenes/b.json', entityCount: 0 },
  ],
  assetCount: 0,
  scriptCount: 0,
  scripts: [],
  playtestCount: 0,
  inputActions: {},
  inputMappings: {},
  buildSettings: {},
};

function sceneData(id: string) {
  if (id === 'sceneA') {
    return {
      id: 'sceneA',
      name: 'Scene A',
      isInitial: true,
      entityCount: 1,
      entities: [
        {
          id: 'e1',
          name: 'Entity 1',
          parentId: null,
          enabled: true,
          tags: [],
          components: { Transform: { position: { x: 0, y: 0 } } },
          position: { x: 0, y: 0 },
          children: [],
        },
      ],
    };
  }
  return { id: 'sceneB', name: 'Scene B', isInitial: false, entityCount: 0, entities: [] };
}

beforeEach(() => {
  vi.useFakeTimers();
  apiCommand.mockReset();
  apiOpenProject.mockReset();
  apiCreateProject.mockReset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiCommand.mockImplementation(async (_project: string, name: string, params: any) => {
    switch (name) {
      case 'inspectComponents':
        return ok({ components: [] });
      case 'inspectProject':
        return ok(PROJECT_INFO);
      case 'inspectScene':
        return ok(sceneData(params.scene));
      case 'inspectAssets':
        return ok({ assets: [] });
      case 'moveEntity':
        return ok({});
      default:
        return ok({});
    }
  });
  apiOpenProject.mockImplementation(async (path: string) => ({ ok: true, path, info: PROJECT_INFO }));
});

afterEach(() => {
  vi.useRealTimers();
  useEditor.getState().closeProject();
});

async function openAndSelect(): Promise<void> {
  await useEditor.getState().openProject('/tmp/proj');
  useEditor.getState().select('e1');
}

describe('nudge burst teardown on project close', () => {
  it('closeProject clears a pending nudge without firing moveEntity', async () => {
    await openAndSelect();
    useEditor.getState().nudgeSelection(1, 0);
    expect(apiCommand.mock.calls.some((c) => c[1] === 'moveEntity')).toBe(false);

    useEditor.getState().closeProject();
    await vi.advanceTimersByTimeAsync(1000);

    expect(apiCommand.mock.calls.some((c) => c[1] === 'moveEntity')).toBe(false);
  });
});

describe('nudge burst teardown on scene switch', () => {
  it('selectScene flushes the pending burst synchronously against the OLD scene, exactly once', async () => {
    await openAndSelect();
    useEditor.getState().nudgeSelection(2, 0);
    useEditor.getState().nudgeSelection(0, 3);
    expect(apiCommand.mock.calls.some((c) => c[1] === 'moveEntity')).toBe(false);

    await useEditor.getState().selectScene('sceneB');

    const moveCalls = apiCommand.mock.calls.filter((c) => c[1] === 'moveEntity');
    expect(moveCalls).toHaveLength(1);
    expect(moveCalls[0][2]).toEqual({ scene: 'sceneA', entity: 'e1', position: { x: 2, y: 3 } });

    // The debounce timer that would otherwise have fired this burst later
    // must have been cancelled by the synchronous flush — no second call.
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiCommand.mock.calls.filter((c) => c[1] === 'moveEntity')).toHaveLength(1);

    expect(useEditor.getState().sceneId).toBe('sceneB');
  });
});

describe('nudge burst teardown on openProject (reopen)', () => {
  it('opening a project again clears any pending nudge from the previous session', async () => {
    await openAndSelect();
    useEditor.getState().nudgeSelection(5, 5);
    expect(apiCommand.mock.calls.some((c) => c[1] === 'moveEntity')).toBe(false);

    await useEditor.getState().openProject('/tmp/proj');
    await vi.advanceTimersByTimeAsync(1000);

    expect(apiCommand.mock.calls.some((c) => c[1] === 'moveEntity')).toBe(false);
  });
});
