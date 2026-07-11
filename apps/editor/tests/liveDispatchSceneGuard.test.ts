import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the API boundary so the store's read-only `query` (inspectEntity, used
// to resolve external patch values) can be scripted and counted per test.
vi.mock('../src/api', () => ({
  apiCommand: vi.fn(),
  apiMeta: vi.fn(async () => null),
  apiOpenProject: vi.fn(),
  apiCreateProject: vi.fn(),
  apiDetectAgents: vi.fn(async () => ({ agents: [] })),
  fileUrl: (project: string, path: string) =>
    `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
}));

import { apiCommand } from '../src/api';
import { useEditor } from '../src/store';
import { setGameView } from '../src/gameViewRef';
import type { JournalEntry } from '../src/types';

/**
 * Scene guard + query coalescing for EXTERNAL journal patches (the store's
 * live-dispatch path behind the WS journal handler, driven here through the
 * `applyExternalJournalEntry` seam).
 *
 * The invariant that must never break (reviewer-flagged): an external
 * property edit targeting a DIFFERENT scene must never patch the running
 * preview — entity refs resolve by id OR name, so a same-named entity in the
 * running scene would silently take the other scene's value. A skipped patch
 * is honest; a cross-scene name-collision patch is silently wrong.
 */

const okResult = (data: unknown) => ({
  success: true,
  command: 'inspectEntity',
  data,
  errors: [],
  warnings: [],
  changed: [],
  files: [],
  suggestions: [],
});

function entry(over: Partial<JournalEntry>): JournalEntry {
  return {
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    source: 'cli',
    command: 'setComponentProperty',
    summary: '',
    ok: true,
    ...over,
  };
}

describe('external journal patches: scene guard + coalesced resolution', () => {
  let patchComponent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    patchComponent = vi.fn(() => true);
    setGameView({
      play() {},
      pause() {},
      destroy() {},
      patchComponent,
    } as never);
    useEditor.setState({
      projectPath: '/proj',
      playing: true,
      sceneId: 'scn_x',
      scene: { id: 'scn_x', name: 'SceneX', isInitial: true, entityCount: 1, entities: [] } as never,
      info: {
        scenes: [
          { id: 'scn_x', name: 'SceneX', path: 'scenes/x.scene.json', entityCount: 1 },
          { id: 'scn_y', name: 'SceneY', path: 'scenes/y.scene.json', entityCount: 1 },
        ],
      } as never,
    });
  });

  it('skips a patch for a NON-running scene (same-named entity in both scenes) — no query, no patch', async () => {
    // "Player" exists in both scenes; the runtime resolves entity refs by id
    // or name, so applying SceneY's edit would silently hit SceneX's Player.
    await useEditor.getState().applyExternalJournalEntry(
      entry({ detail: { scene: 'SceneY', entity: 'Player', property: 'Transform.position.x' } }),
    );
    await useEditor.getState().applyExternalJournalEntry(
      entry({ detail: { scene: 'scn_y', entity: 'Player', property: 'Transform.position.x' } }),
    );
    expect(patchComponent).not.toHaveBeenCalled();
    expect(apiCommand).not.toHaveBeenCalled();
  });

  it('applies a patch for the running scene referenced by ID', async () => {
    vi.mocked(apiCommand).mockResolvedValue(okResult({ components: { Camera: { zoom: 2 } } }) as never);
    await useEditor.getState().applyExternalJournalEntry(
      entry({ detail: { scene: 'scn_x', entity: 'Main Camera', property: 'Camera.zoom' } }),
    );
    expect(patchComponent).toHaveBeenCalledWith('Main Camera', 'Camera', 'zoom', 2);
  });

  it('applies a patch for the running scene referenced by NAME (CLI/MCP pass names)', async () => {
    vi.mocked(apiCommand).mockResolvedValue(okResult({ components: { Camera: { zoom: 3 } } }) as never);
    await useEditor.getState().applyExternalJournalEntry(
      entry({ detail: { scene: 'SceneX', entity: 'Main Camera', property: 'Camera.zoom' } }),
    );
    expect(patchComponent).toHaveBeenCalledWith('Main Camera', 'Camera', 'zoom', 3);
  });

  it('coalesces a multi-key setProperties into ONE inspectEntity query', async () => {
    vi.mocked(apiCommand).mockResolvedValue(
      okResult({ components: { Camera: { zoom: 2, ambientLight: 0.5 } } }) as never,
    );
    await useEditor.getState().applyExternalJournalEntry(
      entry({
        command: 'setProperties',
        detail: { scene: 'scn_x', entity: 'Main Camera', properties: ['Camera.zoom', 'Camera.ambientLight'] },
      }),
    );
    expect(apiCommand).toHaveBeenCalledTimes(1);
    expect(patchComponent).toHaveBeenCalledTimes(2);
    expect(patchComponent).toHaveBeenCalledWith('Main Camera', 'Camera', 'zoom', 2);
    expect(patchComponent).toHaveBeenCalledWith('Main Camera', 'Camera', 'ambientLight', 0.5);
  });

  it('does nothing when not playing (per-entry check, in case Stop lands mid-batch)', async () => {
    useEditor.setState({ playing: false });
    await useEditor.getState().applyExternalJournalEntry(
      entry({ detail: { scene: 'scn_x', entity: 'Main Camera', property: 'Camera.zoom' } }),
    );
    expect(patchComponent).not.toHaveBeenCalled();
    expect(apiCommand).not.toHaveBeenCalled();
  });
});
