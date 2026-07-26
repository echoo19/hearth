import React, { useEffect, useState } from 'react';
import { useApp } from './store';
import { hearthNative, type HearthNative } from './native';
import { Launcher } from './components/Launcher';
import { TopBar } from './components/shell/TopBar';
import { ChatColumn } from './components/chat/ChatColumn';
import { PaneStack } from './components/game/PaneStack';
import { CodePeek } from './components/code/CodePeek';
import { SettingsDialog } from './components/shell/SettingsDialog';
import { useNativeMenu } from './menu/nativeMenu';
import { NARROW_BREAKPOINT_PX } from './store';

export default function App() {
  const projectPath = useApp((s) => s.projectPath);
  const projectName = useApp((s) => s.projectName);
  const native = hearthNative();

  useEffect(() => {
    void useApp.getState().loadMeta();
  }, []);

  // Compact window while choosing a folder, full window once one is open. The
  // browser tab title tracks the same name, harmlessly duplicated in Electron
  // where the native title bar already won.
  useEffect(() => {
    if (!projectPath && native) {
      void native.setWindowMode('launcher').catch((error: unknown) => {
        console.error('Failed to enter launcher window mode.', error);
      });
    }
    document.title = projectPath && projectName ? `${projectName} · Hearth` : 'Hearth';
  }, [native, projectPath, projectName]);

  if (!projectPath) return <Launcher />;
  if (native) {
    return <NativeGate key={projectPath} native={native} projectPath={projectPath} projectName={projectName} />;
  }
  return <Shell />;
}

/**
 * Electron only: the main process resizes the window for the working layout,
 * and the shell waits for that to settle so it measures its final size once
 * rather than laying out twice.
 */
function NativeGate({
  native,
  projectName,
}: {
  native: HearthNative;
  projectPath: string;
  projectName: string | null;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void native.setWindowMode('editor', projectName ?? undefined).then(
      () => {
        if (!cancelled) setReady(true);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('Failed to enter editor window mode.', error);
        setReady(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [native, projectName]);

  return ready ? <Shell /> : null;
}

/**
 * Whether the window is too narrow for two columns. A single matchMedia
 * listener rather than a resize handler: the only thing the layout cares about
 * is which side of the breakpoint it's on.
 */
export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(`(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`).matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.(`(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`);
    if (!query) return;
    const onChange = (e: MediaQueryListEvent): void => setNarrow(e.matches);
    setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/**
 * The working layout: conversation on the left, the game and its supporting
 * surfaces on the right. Two fixed regions, no draggable panel system — the
 * arrangement is the product's opinion, not a preference.
 */
function Shell() {
  const narrow = useNarrowLayout();
  const narrowTab = useApp((s) => s.narrowTab);
  useNativeMenu();

  return (
    <div className={`app-shell${narrow ? ' is-narrow' : ''}`}>
      <TopBar narrow={narrow} />
      <div className="app-body">
        <div className="app-region" data-active={!narrow || narrowTab === 'chat'}>
          <ChatColumn />
        </div>
        <div className="app-region" data-active={!narrow || narrowTab === 'pane'}>
          <PaneStack />
        </div>
      </div>
      <CodePeek />
      <SettingsDialog />
    </div>
  );
}
