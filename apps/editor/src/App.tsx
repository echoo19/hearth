import React, { useEffect, useState } from 'react';
import { useApp } from './store';
import { hearthNative, type HearthNative } from './native';
import { TopBar } from './components/shell/TopBar';
import { Sidebar, SIDEBAR_RAIL_PX, SIDEBAR_WIDTH_PX } from './components/shell/Sidebar';
import { Home } from './components/home/Home';
import { SkillsScreen } from './components/skills/SkillsScreen';
import { ProjectHome } from './components/project/ProjectHome';
import { ChatColumn } from './components/chat/ChatColumn';
import { PaneStack } from './components/game/PaneStack';
import { CodePeek } from './components/code/CodePeek';
import { SettingsDialog } from './components/shell/SettingsDialog';
import { ShortcutLayer } from './components/shell/ShortcutLayer';
import { useNativeMenu } from './menu/nativeMenu';
import { NARROW_BREAKPOINT_PX } from './store';

export default function App() {
  const projectPath = useApp((s) => s.projectPath);
  const projectName = useApp((s) => s.projectName);
  const native = hearthNative();

  useEffect(() => {
    void useApp.getState().loadMeta();
    // The global conversation list is what the rail shows before any folder
    // is open, so it is read at boot rather than on the first open.
    void useApp.getState().refreshRecentChats();
    return useApp.getState().watchUpdates();
  }, []);

  // The browser tab title tracks the same name the native title bar shows,
  // harmlessly duplicated in Electron.
  useEffect(() => {
    document.title = projectPath && projectName ? `${projectName} · Hearth` : 'Hearth';
  }, [projectPath, projectName]);

  // There is no launcher window any more: the app opens at working size and
  // stays there, with or without a folder. NativeGate is keyed by the folder
  // so the shell still remounts when one changes.
  if (native) return <NativeGate key={projectPath ?? 'home'} native={native} projectName={projectName} />;
  return <Shell />;
}

/**
 * Electron only: tell the main process which folder the window is on (it owns
 * the title) and wait for that round trip before measuring the layout, so the
 * shell lays out once rather than twice.
 */
function NativeGate({ native, projectName }: { native: HearthNative; projectName: string | null }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void native.setWindowMode('editor', projectName ?? undefined).then(
      () => {
        if (!cancelled) setReady(true);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('Failed to set the window mode.', error);
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
 * The window width below which the conversation and the game can't both hold a
 * column. The rail is part of that arithmetic: 900px of window with a 260px
 * rail leaves the same room as 640px without one, which is not two columns.
 * Pure, so the rule is checkable without a viewport.
 */
export function narrowBreakpointFor(sidebarCollapsed: boolean): number {
  return NARROW_BREAKPOINT_PX + (sidebarCollapsed ? SIDEBAR_RAIL_PX : SIDEBAR_WIDTH_PX);
}

/**
 * Whether the window is too narrow for two columns. A single matchMedia
 * listener rather than a resize handler: the only thing the layout cares about
 * is which side of the breakpoint it's on.
 */
export function useNarrowLayout(): boolean {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const breakpoint = narrowBreakpointFor(collapsed);
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(`(max-width: ${breakpoint - 1}px)`).matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.(`(max-width: ${breakpoint - 1}px)`);
    if (!query) return;
    const onChange = (e: MediaQueryListEvent): void => setNarrow(e.matches);
    setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [breakpoint]);
  return narrow;
}

/**
 * The working layout: the rail of conversations and folders, then the
 * conversation itself, then the game and its supporting surfaces. Three fixed
 * regions, no draggable panel system — the arrangement is the product's
 * opinion, not a preference. Only the rail moves, and only between two states.
 *
 * With no folder open the two regions collapse to Home: a greeting and a
 * composer. The rail is there either way — the app is never a modal dialog
 * asking permission to exist.
 */
function Shell() {
  const hasFolder = useApp((s) => s.projectPath !== null);
  // New chat and Home are the same screen. `composing` is what New chat sets;
  // no project open means there is nothing else it could be showing anyway.
  const composing = useApp((s) => s.composing);
  // Clicking a project lands on the project, not in one of its conversations.
  const projectView = useApp((s) => s.projectView);
  const narrow = useNarrowLayout();
  const narrowTab = useApp((s) => s.narrowTab);
  // The playtest column is a guest, not a fixture: with nothing to play the
  // conversation takes the whole window, which is what a chat app looks like.
  const paneOpen = useApp((s) => s.paneOpen);
  useNativeMenu();
  // Narrow puts the two regions on tabs; with no second region there is no tab
  // to be on, so the conversation is always the active one.
  const chatActive = !narrow || !paneOpen || narrowTab === 'chat';
  // A screen is a place the app goes, not a sheet over the place it was. It
  // takes the whole working area and owns its own way back; what it covered is
  // untouched underneath and returns exactly as it was left.
  const screen = useApp((s) => s.screen);

  return (
    <div className={`app-shell${narrow ? ' is-narrow' : ''}`}>
      <Sidebar />
      <div className="app-main">
        <TopBar narrow={narrow} paneOpen={paneOpen} />
        {screen === 'skills' ? (
          <SkillsScreen />
        ) : hasFolder && projectView && !composing ? (
          <ProjectHome />
        ) : hasFolder && !composing ? (
          <div className={`app-body${paneOpen ? '' : ' is-solo'}`}>
            <div className="app-region" data-active={chatActive}>
              <ChatColumn />
            </div>
            {paneOpen && (
              <div className="app-region" data-active={!narrow || narrowTab === 'pane'}>
                <PaneStack />
              </div>
            )}
          </div>
        ) : (
          <Home />
        )}
      </div>
      <CodePeek />
      <SettingsDialog />
      {/* Renders nothing. It is where the window-wide keyboard shortcuts live,
          mounted once so they work whatever surface is on screen. */}
      <ShortcutLayer />
    </div>
  );
}
