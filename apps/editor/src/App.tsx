import React, { useEffect, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { useEditor } from './store';
import { hearthNative } from './native';
import { Launcher } from './components/Launcher';
import { Toolbar } from './components/Toolbar';
import { Workspace } from './workspace/Workspace';
import { layoutStorageKey } from './workspace/layout';

export default function App() {
  const projectPath = useEditor((s) => s.projectPath);
  const projectName = useEditor((s) => s.info?.name);

  useEffect(() => {
    void useEditor.getState().loadMeta();
  }, []);

  // Desktop app: compact project-manager window when no project is open,
  // full editor window once one is (Godot-style). No-op in the browser.
  useEffect(() => {
    void hearthNative()?.setWindowMode(
      projectPath ? 'editor' : 'launcher',
      projectPath ? projectName : undefined,
    );
  }, [projectPath, projectName]);

  return projectPath ? <EditorShell projectPath={projectPath} /> : <Launcher />;
}

function EditorShell({ projectPath }: { projectPath: string }) {
  const projectId = useEditor((s) => s.info?.id);
  const [dock, setDock] = useState<DockviewApi | null>(null);
  const storageKey = layoutStorageKey(projectId ?? projectPath);

  // Cmd/Ctrl+Z -> undo, Shift+Cmd/Ctrl+Z or Cmd/Ctrl+Y -> redo. Skipped while
  // typing in a text field so the browser's native undo still works there.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        void useEditor.getState().exec(e.shiftKey ? 'redo' : 'undo');
      } else if (key === 'y') {
        e.preventDefault();
        void useEditor.getState().exec('redo');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="shell">
      <Toolbar dock={dock} storageKey={storageKey} />
      {/* Keyed per project so each project restores its own saved layout. */}
      <Workspace key={storageKey} storageKey={storageKey} onReady={setDock} />
    </div>
  );
}
