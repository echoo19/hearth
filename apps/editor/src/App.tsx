import React, { useEffect } from 'react';
import { useEditor } from './store';
import { Launcher } from './components/Launcher';
import { Toolbar } from './components/Toolbar';
import { Hierarchy } from './components/Hierarchy';
import { SceneView } from './components/SceneView';
import { GamePreview } from './components/GamePreview';
import { Inspector } from './components/Inspector';
import { AssetsPanel } from './components/AssetsPanel';
import { ConsolePanel } from './components/ConsolePanel';
import { DiffPanel } from './components/DiffPanel';
import { AgentPanel } from './components/AgentPanel';

export default function App() {
  const projectPath = useEditor((s) => s.projectPath);

  useEffect(() => {
    void useEditor.getState().loadMeta();
  }, []);

  return projectPath ? <EditorShell /> : <Launcher />;
}

function EditorShell() {
  const centerTab = useEditor((s) => s.centerTab);
  const bottomTab = useEditor((s) => s.bottomTab);
  const consoleUnread = useEditor((s) => s.consoleUnread);
  const setCenterTab = useEditor((s) => s.setCenterTab);
  const setBottomTab = useEditor((s) => s.setBottomTab);
  const refreshDiff = useEditor((s) => s.refreshDiff);

  return (
    <div className="shell">
      <Toolbar />
      <div className="shell-body">
        <aside className="side-panel left">
          <Hierarchy />
        </aside>

        <div className="center-column">
          <nav className="tab-strip" aria-label="View">
            <button
              className={`tab${centerTab === 'scene' ? ' active' : ''}`}
              onClick={() => setCenterTab('scene')}
            >
              Scene
            </button>
            <button
              className={`tab${centerTab === 'game' ? ' active' : ''}`}
              onClick={() => setCenterTab('game')}
            >
              Game
            </button>
          </nav>

          <div className="center-view">{centerTab === 'scene' ? <SceneView /> : <GamePreview />}</div>

          <nav className="tab-strip bottom-tabs" aria-label="Panels">
            {(
              [
                ['assets', 'Assets'],
                ['console', 'Console'],
                ['diff', 'Diff'],
                ['agent', 'Agent'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={`tab${bottomTab === id ? ' active' : ''}`}
                onClick={() => {
                  setBottomTab(id);
                  if (id === 'diff') void refreshDiff();
                }}
              >
                {label}
                {id === 'console' && consoleUnread > 0 && <span className="badge">{consoleUnread}</span>}
              </button>
            ))}
          </nav>

          <section className="bottom-panel">
            {bottomTab === 'assets' && <AssetsPanel />}
            {bottomTab === 'console' && <ConsolePanel />}
            {bottomTab === 'diff' && <DiffPanel />}
            {bottomTab === 'agent' && <AgentPanel />}
          </section>
        </div>

        <aside className="side-panel right">
          <Inspector />
        </aside>
      </div>
    </div>
  );
}
