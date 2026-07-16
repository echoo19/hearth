import React, { useMemo, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { useEditor } from '../store';
import { Icon, Modal } from './ui';
import { IconButton } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { ExportDialog } from './ExportDialog';
import { SceneMenu } from './SceneMenu';
import { MenuBar } from '../menu/MenuBar';
import { useNativeAppMenu, useShowInWindowMenuBar } from '../menu/nativeMenu';
import { buildAppMenu, DOCS_URL, type AppMenuContext, type AppMenuViewContext } from '../menu/appMenu';
import { useOpenPanels } from '../workspace/useOpenPanels';
import { PANEL_TITLES, VIEW_MENU_PANELS, resetLayout, showPanel } from '../workspace/Workspace';
import type { PanelId } from '../workspace/layout';
import { useHistoryList } from '../useHistoryList';
import { comboDisplay } from '../keybinds';
import { getGameView } from '../gameViewRef';

/**
 * Live connection to the project server (WS journal + external-change channel).
 * Connected: a steady --ok dot. Connecting: a pulsing dot (killed under
 * prefers-reduced-motion by the global media rule). Disconnected: an --err dot.
 * Reads `wsStatus` only — no state of its own.
 */
function WsStatusDot() {
  const wsStatus = useEditor((s) => s.wsStatus);
  // Disconnected is transient — the store auto-reconnects with backoff — so
  // both non-connected states read as "reconnecting" to the user.
  const label =
    wsStatus === 'connected' ? 'Connected to project server' : 'Reconnecting to project server…';
  return (
    <Tooltip content={label}>
      <span className={`ws-dot ws-dot-${wsStatus}`} role="status" aria-label={label} tabIndex={0} />
    </Tooltip>
  );
}

export function Toolbar({ dock, storageKey }: { dock: DockviewApi | null; storageKey: string }) {
  // Subscribed so the toolbar (and the menu model it builds) re-renders when
  // any of these change.
  const info = useEditor((s) => s.info);
  const sceneId = useEditor((s) => s.sceneId);
  const playing = useEditor((s) => s.playing);
  const paused = useEditor((s) => s.paused);
  const pendingRestart = useEditor((s) => s.pendingRestart);
  const debugDraw = useEditor((s) => s.debugDraw);
  const selectScene = useEditor((s) => s.selectScene);
  const setPlaying = useEditor((s) => s.setPlaying);
  const restartPlay = useEditor((s) => s.restartPlay);
  const setPaused = useEditor((s) => s.setPaused);
  const refreshDiff = useEditor((s) => s.refreshDiff);
  const exec = useEditor((s) => s.exec);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const log = useEditor((s) => s.log);

  const [newSceneOpen, setNewSceneOpen] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [exportOpen, setExportOpen] = useState(false);

  // Shared with DiffPanel.tsx's Undo/Redo buttons — see useHistoryList.ts.
  const { undoTarget, redoTarget } = useHistoryList();
  const openPanels = useOpenPanels(dock);

  async function createScene() {
    const name = newSceneName.trim();
    if (!name) return;
    const result = await exec<{ sceneId: string }>('createScene', { name });
    setNewSceneOpen(false);
    setNewSceneName('');
    if (result.success && result.data) {
      await selectScene(result.data.sceneId);
    }
  }

  async function stepFrame() {
    try {
      await getGameView()?.stepFrame?.();
    } catch (err) {
      log('error', 'runtime', `Step failed: ${(err as Error).message}`);
    }
  }

  // ---- Application menu model (File/Edit/View/Help) ----------------------
  // One model drives both the in-window MenuBar and the native macOS menu.
  const view: AppMenuViewContext | null = dock
    ? {
        panels: VIEW_MENU_PANELS.map((id) => ({ id, label: PANEL_TITLES[id], open: openPanels.has(id) })),
        togglePanel: (id) => {
          const panel = dock.getPanel(id as PanelId);
          if (panel) panel.api.close();
          else showPanel(dock, id as PanelId);
        },
        resetLayout: () => resetLayout(dock, storageKey),
        canReset: true,
      }
    : null;

  const menuCtx: AppMenuContext = {
    canUndo: !!undoTarget,
    canRedo: !!redoTarget,
    onNewScene: () => setNewSceneOpen(true),
    onExport: () => setExportOpen(true),
    onReview: () => {
      if (dock) showPanel(dock, 'diff');
      void refreshDiff();
    },
    openDocs: () => window.open(DOCS_URL, '_blank', 'noopener,noreferrer'),
    view,
  };

  const sections = useMemo(
    () => buildAppMenu(useEditor.getState(), menuCtx),
    // Rebuild when any input the model reads or depends on changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info, debugDraw, playing, undoTarget, redoTarget, openPanels, dock, storageKey],
  );
  useNativeAppMenu(sections);
  const showMenuBar = useShowInWindowMenuBar();

  return (
    <header className="toolbar">
      <span className="wordmark">
        <span className="flame">
          <Icon name="flame" size={16} />
        </span>
        Hearth
      </span>

      {showMenuBar && <MenuBar sections={sections} />}

      <span className="divider" />

      <span className="toolbar-group">
        <select
          className="select select-sm scene-picker"
          value={sceneId ?? ''}
          onChange={(e) => void selectScene(e.target.value)}
          aria-label="Scene"
        >
          {(info?.scenes ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {info?.initialScene === s.id ? ' (initial)' : ''}
            </option>
          ))}
        </select>
        <SceneMenu />
        <IconButton icon="plus" label="New scene" size="sm" onClick={() => setNewSceneOpen(true)} />
      </span>

      <span className="divider" />

      {/* Transport. Play/Stop keeps its label; Pause/Step are icon-only. */}
      <span className="toolbar-group">
        <Tooltip
          content={playing ? 'Stop the preview' : 'Play the current scene in the Game tab'}
          shortcut={comboDisplay('mod+enter')}
        >
          <button
            className={playing ? 'btn btn-sm btn-stop' : 'btn btn-primary btn-sm btn-play'}
            onClick={() => setPlaying(!playing)}
          >
            <Icon name={playing ? 'stop' : 'play'} /> {playing ? 'Stop' : 'Play'}
          </button>
        </Tooltip>
        <IconButton
          icon={paused ? 'play' : 'pause'}
          label={paused ? 'Resume the running game' : 'Freeze the running game in place'}
          shortcut={comboDisplay('shift+mod+enter')}
          variant={paused ? 'primary' : 'default'}
          size="sm"
          onClick={() => setPaused(!paused)}
          disabled={!playing}
          aria-pressed={paused}
        />
        <IconButton
          icon="step"
          label="Advance one frame"
          size="sm"
          onClick={() => void stepFrame()}
          disabled={!playing || !paused}
        />
      </span>

      {/* Undo/Redo: bare arrow icon buttons; the tooltip carries the shortcut. */}
      <span className="toolbar-group">
        <IconButton
          icon="undo"
          label="Undo"
          shortcut={comboDisplay('mod+z')}
          size="sm"
          onClick={() => void undo()}
          disabled={!undoTarget}
        />
        <IconButton
          icon="redo"
          label="Redo"
          shortcut={comboDisplay('shift+mod+z')}
          size="sm"
          onClick={() => void redo()}
          disabled={!redoTarget}
        />
      </span>

      {/* Restart badge: a structural change landed mid-run and can't be
          live-patched. Lives just before the spacer so its appearance only eats
          spacer width — no other control reflows (TOOLBAR-4). */}
      <span className="restart-badge-slot" aria-live="polite">
        {playing && pendingRestart && (
          <Tooltip content="Restart the preview to apply changes that can't be live-patched">
            <button className="btn btn-sm btn-restart" onClick={() => restartPlay()}>
              <Icon name="restart" /> Restart
            </button>
          </Tooltip>
        )}
      </span>

      <span className="spacer" />

      <WsStatusDot />

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />

      <Modal open={newSceneOpen} title="New scene" onClose={() => setNewSceneOpen(false)}>
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label" htmlFor="scene-name">
              Scene name
            </label>
            <input
              id="scene-name"
              className="input"
              value={newSceneName}
              onChange={(e) => setNewSceneName(e.target.value)}
              placeholder="Level 2"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createScene();
              }}
            />
          </div>
          <p>A "Main Camera" entity is added automatically.</p>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setNewSceneOpen(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void createScene()} disabled={!newSceneName.trim()}>
            Create scene
          </button>
        </div>
      </Modal>
    </header>
  );
}
