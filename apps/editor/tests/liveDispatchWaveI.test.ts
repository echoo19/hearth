import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the API boundary so the store's read-only `query` (inspectEntity, used
// to resolve valueless patch values) can be scripted per test.
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
 * Store live-dispatch wiring for the Wave I commands, driven through the
 * `applyExternalJournalEntry` seam (the WS journal handler's per-entry step).
 * Classification is unit-tested in livePatch.test.ts; this pins the store side:
 * an ASM update reaches the runtime seam, an autotile edit re-reads and patches
 * Tilemap.tileAssets, and a prefab-override revert resyncs exactly its scope.
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
  return { seq: 1, ts: '2026-01-01T00:00:00.000Z', source: 'cli', command: 'setComponentProperty', summary: '', ok: true, ...over };
}

describe('Wave I live dispatch (external journal path)', () => {
  let patchComponent: ReturnType<typeof vi.fn>;
  let reloadStateMachineAsset: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    patchComponent = vi.fn(() => true);
    reloadStateMachineAsset = vi.fn(async () => 1);
    setGameView({ play() {}, pause() {}, destroy() {}, patchComponent, reloadStateMachineAsset } as never);
    useEditor.setState({
      projectPath: '/proj',
      playing: true,
      sceneId: 'scn_x',
      scene: { id: 'scn_x', name: 'SceneX', isInitial: true, entityCount: 1, entities: [] } as never,
      info: { scenes: [{ id: 'scn_x', name: 'SceneX', path: 'scenes/x.scene.json', entityCount: 1 }] } as never,
    });
  });

  it('updateStateMachineAsset → live-swaps the asset on the runtime (no inspect query)', async () => {
    await useEditor.getState().applyExternalJournalEntry(entry({ command: 'updateStateMachineAsset', detail: { assetId: 'ast_sm' } }));
    expect(reloadStateMachineAsset).toHaveBeenCalledWith('ast_sm');
    expect(apiCommand).not.toHaveBeenCalled();
    expect(patchComponent).not.toHaveBeenCalled();
  });

  it('setTileAutotile → re-reads and patches the whole Tilemap.tileAssets map', async () => {
    const tileAssets = { '#': { sheet: 'ast_tiles', template: 'blob47' } };
    vi.mocked(apiCommand).mockResolvedValue(okResult({ components: { Tilemap: { tileAssets } } }) as never);
    await useEditor.getState().applyExternalJournalEntry(
      entry({ command: 'setTileAutotile', detail: { scene: 'scn_x', entity: 'Tiles', char: '#' } }),
    );
    expect(apiCommand).toHaveBeenCalledTimes(1);
    expect(patchComponent).toHaveBeenCalledWith('Tiles', 'Tilemap', 'tileAssets', tileAssets);
  });

  it('revertPrefabOverride (field) → patches just that leaf', async () => {
    vi.mocked(apiCommand).mockResolvedValue(okResult({ components: { Transform: { position: { x: 5, y: 0 } } } }) as never);
    await useEditor.getState().applyExternalJournalEntry(
      entry({ command: 'revertPrefabOverride', detail: { scene: 'scn_x', entity: 'Inst', component: 'Transform', path: 'position.x' } }),
    );
    expect(patchComponent).toHaveBeenCalledTimes(1);
    expect(patchComponent).toHaveBeenCalledWith('Inst', 'Transform', 'position.x', 5);
  });

  it('revertPrefabOverride (whole component) → resyncs every leaf of that component only', async () => {
    vi.mocked(apiCommand).mockResolvedValue(
      okResult({ components: { SpriteRenderer: { assetId: 'a', frame: 'f', visible: true }, Transform: { position: { x: 9, y: 9 } } } }) as never,
    );
    await useEditor.getState().applyExternalJournalEntry(
      entry({ command: 'revertPrefabOverride', detail: { scene: 'scn_x', entity: 'Inst', component: 'SpriteRenderer' } }),
    );
    // Only SpriteRenderer's leaves are patched — Transform (not reverted) is untouched.
    expect(patchComponent).toHaveBeenCalledWith('Inst', 'SpriteRenderer', 'assetId', 'a');
    expect(patchComponent).toHaveBeenCalledWith('Inst', 'SpriteRenderer', 'frame', 'f');
    expect(patchComponent).toHaveBeenCalledWith('Inst', 'SpriteRenderer', 'visible', true);
    expect(patchComponent).not.toHaveBeenCalledWith('Inst', 'Transform', 'position', { x: 9, y: 9 });
  });

  it('revertPrefabOverride (whole entity) → resyncs every component leaf', async () => {
    vi.mocked(apiCommand).mockResolvedValue(
      okResult({ components: { Transform: { position: { x: 1, y: 2 } }, SpriteRenderer: { assetId: 'a' } } }) as never,
    );
    await useEditor.getState().applyExternalJournalEntry(
      entry({ command: 'revertPrefabOverride', detail: { scene: 'scn_x', entity: 'Inst' } }),
    );
    expect(patchComponent).toHaveBeenCalledWith('Inst', 'Transform', 'position', { x: 1, y: 2 });
    expect(patchComponent).toHaveBeenCalledWith('Inst', 'SpriteRenderer', 'assetId', 'a');
  });
});
