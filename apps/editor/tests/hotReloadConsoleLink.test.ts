/**
 * Task 7: hot-reload notices raised by the live-update dispatcher (Task 5's
 * applyReload, store.ts) become clickable the same way a runtime error does
 * — a compile FAILURE carries a `link` to the script (and line, when the
 * runtime reports one); a SUCCESS notice stays plain `info` with no link.
 * Exercises the real `useEditor` store end-to-end (api + game view mocked),
 * same harness style as nudgeLifecycle.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/types';
import type { MountedGameView, ReloadScriptResult } from '../src/runtimeBridge';

const { apiCommand, apiOpenProject, apiCreateProject, apiMeta, apiDetectAgents, fileUrl } = vi.hoisted(() => ({
  apiCommand: vi.fn(),
  apiOpenProject: vi.fn(),
  apiCreateProject: vi.fn(),
  apiMeta: vi.fn(async () => null),
  apiDetectAgents: vi.fn(async () => null),
  fileUrl: vi.fn((project: string, relPath: string) => `http://localhost/${project}/${relPath}`),
}));

vi.mock('../src/api', () => ({
  apiCommand,
  apiOpenProject,
  apiCreateProject,
  apiMeta,
  apiDetectAgents,
  fileUrl,
}));

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
import { setGameView } from '../src/gameViewRef';

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

function fakeView(reloadScript: (path: string, source: string) => Promise<ReloadScriptResult>): MountedGameView {
  return { play() {}, pause() {}, destroy() {}, reloadScript };
}

function baseApiCommand(editScript?: () => CommandResult<unknown>) {
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
      case 'editScript':
        return editScript ? editScript() : ok({});
      default:
        return ok({});
    }
  };
}

beforeEach(() => {
  apiCommand.mockReset();
  apiOpenProject.mockReset();
  apiCreateProject.mockReset();
  apiCommand.mockImplementation(baseApiCommand());
  apiOpenProject.mockImplementation(async (path: string) => ({ ok: true, path, info: PROJECT_INFO }));
  // closeProject() (afterEach) doesn't clear the Console — it's a session-
  // scoped log, not project state — so reset it explicitly for isolation.
  useEditor.setState({ consoleEntries: [] });
});

afterEach(() => {
  setGameView(null);
  useEditor.getState().closeProject();
});

async function openAndPlay(): Promise<void> {
  await useEditor.getState().openProject('/tmp/proj');
  useEditor.setState({ playing: true });
}

function editScriptResult() {
  return ok(
    { path: 'scripts/enemy.lua', lines: 1, source: 'x=1', formatted: true },
    { changed: [{ action: 'modified', kind: 'script', name: 'enemy.lua' }] },
  );
}

describe('hot-reload notices get a Console link (Task 7)', () => {
  it('compile FAILURE (line known) — error entry with link {path, line}', async () => {
    await openAndPlay();
    setGameView(fakeView(async () => ({ ok: false, message: 'unexpected symbol', line: 7 })));
    apiCommand.mockImplementation(baseApiCommand(editScriptResult));

    await useEditor.getState().exec('editScript', { path: 'scripts/enemy.lua', source: 'x=1' });

    const entry = useEditor
      .getState()
      .consoleEntries.find((e) => e.message.startsWith('Hot-reload failed'));
    expect(entry).toMatchObject({
      level: 'error',
      message: 'Hot-reload failed: scripts/enemy.lua:7: unexpected symbol',
      link: { path: 'scripts/enemy.lua', line: 7 },
    });
  });

  it('compile FAILURE (no line) — link.line is null', async () => {
    await openAndPlay();
    setGameView(fakeView(async () => ({ ok: false, message: 'runtime error', line: null })));
    apiCommand.mockImplementation(baseApiCommand(editScriptResult));

    await useEditor.getState().exec('editScript', { path: 'scripts/enemy.lua', source: 'x=1' });

    const entry = useEditor
      .getState()
      .consoleEntries.find((e) => e.message.startsWith('Hot-reload failed'));
    expect(entry?.link).toEqual({ path: 'scripts/enemy.lua', line: null });
  });

  it('fetch FAILURE (reload with no inline source) — error entry with link {path, line:null}', async () => {
    // Mirror of the compile-failure branch, one layer earlier: when a reload
    // carries no inline source it falls back to fetchScriptSource, and if that
    // on-disk fetch rejects (network drop / file yanked), the catch branch logs
    // the same linkable "Hot-reload failed" notice — line unknown, so null.
    await openAndPlay();
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    // reloadScript must never run — the source resolves to null first.
    const reload = vi.fn(async () => ({ ok: true as const, entities: 0 }));
    setGameView(fakeView(reload));
    // editScript result deliberately omits `source`, so applyReload has no
    // inline text and must fetch the file off disk.
    apiCommand.mockImplementation(
      baseApiCommand(() =>
        ok(
          { path: 'scripts/enemy.lua', lines: 1 },
          { changed: [{ action: 'modified', kind: 'script', name: 'enemy.lua' }] },
        ),
      ),
    );

    await useEditor.getState().exec('editScript', { path: 'scripts/enemy.lua', source: 'x=1' });

    const entry = useEditor
      .getState()
      .consoleEntries.find((e) => e.message.startsWith('Hot-reload failed'));
    expect(entry).toMatchObject({
      level: 'error',
      message: 'Hot-reload failed: scripts/enemy.lua: network down',
      link: { path: 'scripts/enemy.lua', line: null },
    });
    expect(reload).not.toHaveBeenCalled();

    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('SUCCESS — plain info notice, no link', async () => {
    await openAndPlay();
    setGameView(fakeView(async () => ({ ok: true, entities: 2 })));
    apiCommand.mockImplementation(baseApiCommand(editScriptResult));

    await useEditor.getState().exec('editScript', { path: 'scripts/enemy.lua', source: 'x=1' });

    const entry = useEditor.getState().consoleEntries.find((e) => e.message.startsWith('Hot-reloaded'));
    expect(entry).toMatchObject({ level: 'info', message: 'Hot-reloaded scripts/enemy.lua (2 entities)' });
    expect(entry?.link).toBeUndefined();
  });
});
