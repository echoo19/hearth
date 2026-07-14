/**
 * L-060 (CONSOLE-CHANGES-5/6): Checkpoint (⇧⌘S / toolbar) and Undo/Redo
 * (toolbar / Changes panel) must refresh the Changes-panel diff on success, so
 * a focused Changes tab reflects the true current diff immediately instead of
 * lying until a manual Refresh or a tab blur/refocus. Undo/redo only refresh
 * when a baseline is actually being tracked (a checkpoint this session or a
 * diff already on screen) — otherwise they'd spam a "no checkpoint" info line.
 *
 * Drives the real useEditor store with api mocked, same harness style as
 * hotReloadConsoleLink.test.ts.
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

function ok<T>(data: T, over: Partial<CommandResult<T>> = {}): CommandResult<T> {
  return { success: true, command: 'x', data, errors: [], warnings: [], changed: [], files: [], suggestions: [], ...over };
}
function notFound(command: string): CommandResult<never> {
  return {
    success: false,
    command,
    data: null as never,
    errors: [{ code: 'NOT_FOUND', message: 'No checkpoint to compare against.' }],
    warnings: [],
    changed: [],
    files: [],
    suggestions: [],
  };
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

/** Base command mock: reads succeed; diffProject is configurable per test. */
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
      case 'undo':
        return ok({ undone: 'moveEntity', seq: 42 }, { changed: [{ action: 'modified', kind: 'entity' }] });
      case 'redo':
        return ok({ redone: 'moveEntity', seq: 43 }, { changed: [{ action: 'modified', kind: 'entity' }] });
      case 'diffProject':
        return ok(DIFF);
      case 'listHistory':
        return ok({ cursor: 0, entries: [] });
      default:
        return ok({});
    }
  };
}

beforeEach(() => {
  apiCommand.mockReset();
  apiOpenProject.mockReset();
  apiCreateProject.mockReset();
  apiOpenProject.mockImplementation(async (path: string) => ({ ok: true, path, info: PROJECT_INFO }));
});

afterEach(() => {
  useEditor.getState().closeProject();
});

function diffCalls(): number {
  return apiCommand.mock.calls.filter((c) => c[1] === 'diffProject').length;
}

describe('L-060: mutations refresh the Changes-panel diff', () => {
  it('checkpoint() calls diffProject after a successful snapshot', async () => {
    apiCommand.mockImplementation(makeApi());
    await useEditor.getState().openProject('/tmp/proj');
    const before = diffCalls();
    await useEditor.getState().checkpoint();
    expect(diffCalls()).toBeGreaterThan(before);
    expect(useEditor.getState().diff).toEqual(DIFF);
  });

  it('undo() refreshes the diff once a checkpoint has been taken this session', async () => {
    apiCommand.mockImplementation(makeApi());
    await useEditor.getState().openProject('/tmp/proj');
    await useEditor.getState().checkpoint(); // sets snapshotTaken + establishes baseline
    const before = diffCalls();
    await useEditor.getState().undo();
    expect(diffCalls()).toBe(before + 1);
  });

  it('redo() refreshes the diff once a checkpoint has been taken this session', async () => {
    apiCommand.mockImplementation(makeApi());
    await useEditor.getState().openProject('/tmp/proj');
    await useEditor.getState().checkpoint();
    const before = diffCalls();
    await useEditor.getState().redo();
    expect(diffCalls()).toBe(before + 1);
  });

  it('undo() does NOT refresh the diff when no baseline is tracked (no NOT_FOUND spam)', async () => {
    // diffProject would return NOT_FOUND here; the guard must skip it entirely.
    apiCommand.mockImplementation(makeApi({ diffProject: () => notFound('diffProject') }));
    await useEditor.getState().openProject('/tmp/proj');
    expect(useEditor.getState().snapshotTaken).toBe(false);
    expect(useEditor.getState().diff).toBeNull();
    const before = diffCalls();
    await useEditor.getState().undo();
    expect(diffCalls()).toBe(before);
  });
});
