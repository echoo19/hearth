import React, { useEffect, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { useEditor } from './store';
import { hearthNative } from './native';
import { Launcher } from './components/Launcher';
import { Toolbar } from './components/Toolbar';
import { ShortcutSheet } from './components/ShortcutSheet';
import { Workspace } from './workspace/Workspace';
import { layoutStorageKey } from './workspace/layout';
import { installKeybinds } from './keybinds';

export default function App() {
  const projectPath = useEditor((s) => s.projectPath);
  const projectName = useEditor((s) => s.info?.name);

  useEffect(() => {
    void useEditor.getState().loadMeta();
  }, []);

  // Desktop app: compact project-manager window when no project is open,
  // full editor window once one is (Godot-style). No-op in the browser.
  // The browser tab title (and, harmlessly, the Electron document title —
  // the native title bar is already driven by setWindowMode above) tracks
  // the same project name so a browser tab reads "MyGame — Hearth" instead
  // of a bare "Hearth Editor" once a project is open.
  useEffect(() => {
    void hearthNative()?.setWindowMode(
      projectPath ? 'editor' : 'launcher',
      projectPath ? projectName : undefined,
    );
    document.title = projectPath && projectName ? `${projectName} — Hearth` : 'Hearth Editor';
  }, [projectPath, projectName]);

  return projectPath ? <EditorShell projectPath={projectPath} /> : <Launcher />;
}

function EditorShell({ projectPath }: { projectPath: string }) {
  const projectId = useEditor((s) => s.info?.id);
  const [dock, setDock] = useState<DockviewApi | null>(null);
  const storageKey = layoutStorageKey(projectId ?? projectPath);

  // All keyboard shortcuts run through the central registry (keybinds.ts):
  // undo/redo, duplicate/delete/nudge, focus, play, checkpoint, and the `?`
  // cheat sheet. One window listener, installed once for the editor session.
  useEffect(() => installKeybinds(() => useEditor.getState()), []);

  return (
    <div className="shell">
      <Toolbar dock={dock} storageKey={storageKey} />
      {/* Keyed per project so each project restores its own saved layout. */}
      <Workspace key={storageKey} storageKey={storageKey} onReady={setDock} />
      <ShortcutSheet />
    </div>
  );
}
