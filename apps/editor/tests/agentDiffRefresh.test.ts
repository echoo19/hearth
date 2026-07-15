/**
 * AGENT-2 (L-090): "Restore checkpoint" in the Agent Timeline is disabled off
 * `diff?.hasChanges`, but `diff` was only ever recomputed by an explicit
 * refreshDiff() — an external journal entry (e.g. `hearth create entity` run
 * from another shell/CLI/MCP agent while this editor is open) landed in the
 * Timeline via the WS `journal` frame within ~2s, yet left Restore disabled
 * until "Review changes" was clicked. Fixed by refreshing the diff (when a
 * baseline is tracked) in the same WS handler branch that already refreshes
 * project state for external entries (store.ts's onmessage 'journal' case).
 *
 * Drives the real useEditor store with api mocked, same harness style as
 * diffRefreshOnMutation.test.ts, but exercises the WS message handler
 * directly instead of a store action.
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
const DIFF = { summary: '1 change', hasChanges: true, scenes: [], assets: [], scripts: [], projectChanges: [], playtests: [] };

function makeApi(over: Partial<Record<string, () => CommandResult<unknown>>> = {}) {
  return async (_project: string, name: string) => {
    if (over[name]) return over[name]!();
    switch (name) {
      case 'inspectComponents':
        return ok({ components: [] });
      case 'inspectProject':
        return ok(PROJECT_INFO);
      case 'inspectScene':
        return ok(SCENE_A);
      case 'inspectAssets':
        return ok({ assets: [] });
      case 'snapshotProject':
        return ok({ scenes: 1 }, { changed: [{ action: 'created', kind: 'project' }] });
      case 'diffProject':
        return ok(DIFF);
      case 'listHistory':
        return ok({ cursor: 0, entries: [] });
      default:
        return ok({});
    }
  };
}

function externalJournalMessage() {
  return JSON.stringify({
    type: 'journal',
    entries: [
      {
        seq: 1,
        ts: new Date().toISOString(),
        source: 'cli',
        command: 'createEntity',
        summary: 'created entity Foo',
        ok: true,
      },
    ],
  });
}

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

function diffCalls(): number {
  return apiCommand.mock.calls.filter((c) => c[1] === 'diffProject').length;
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) throw new Error('no WebSocket instance created');
  return socket;
}

describe('AGENT-2 (L-090): external journal entries refresh the Restore-checkpoint diff', () => {
  it('refreshes the diff when an external journal entry lands and a checkpoint is tracked', async () => {
    apiCommand.mockImplementation(makeApi());
    await useEditor.getState().openProject('/tmp/proj');
    await useEditor.getState().checkpoint(); // sets snapshotTaken, establishes a baseline
    const before = diffCalls();

    latestSocket().onmessage?.({ data: externalJournalMessage() });
    // The handler awaits refresh() + applyExternalJournalEntry() before
    // refreshing the diff; let the whole async chain settle (a macrotask
    // tick drains any number of chained microtasks).
    await new Promise((r) => setTimeout(r, 0));

    expect(diffCalls()).toBeGreaterThan(before);
    expect(useEditor.getState().journalFeed.some((e) => e.command === 'createEntity')).toBe(true);
  });

  it('does NOT call diffProject for an external entry when no baseline is tracked', async () => {
    apiCommand.mockImplementation(makeApi());
    await useEditor.getState().openProject('/tmp/proj');
    expect(useEditor.getState().snapshotTaken).toBe(false);
    expect(useEditor.getState().diff).toBeNull();
    const before = diffCalls();

    latestSocket().onmessage?.({ data: externalJournalMessage() });
    await new Promise((r) => setTimeout(r, 0));

    expect(diffCalls()).toBe(before);
  });
});
