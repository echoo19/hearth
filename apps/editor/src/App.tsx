import React, { useEffect, useState } from 'react';
import { useApp } from './store';
import { hearthNative, type HearthNative } from './native';
import { TopBar } from './components/shell/TopBar';
import { Sidebar, SIDEBAR_RAIL_PX, SIDEBAR_WIDTH_PX } from './components/shell/Sidebar';
import { Home } from './components/home/Home';
import { SkillsScreen } from './components/skills/SkillsScreen';
import { TesterHistory } from './components/tester/TesterHistory';
import { ProjectHome } from './components/project/ProjectHome';
import { ChatColumn } from './components/chat/ChatColumn';
import { ScreenBoundary } from './components/ScreenBoundary';
import { PaneStack } from './components/game/PaneStack';
import { CodePeek } from './components/code/CodePeek';
import { SettingsDialog } from './components/shell/SettingsDialog';
import { ProjectNamer } from './components/shell/NewProjectDialog';
import { ShortcutLayer } from './components/shell/ShortcutLayer';
import { useNativeMenu } from './menu/nativeMenu';
import { globalPlace, NARROW_BREAKPOINT_PX } from './store';

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
  // stays there, with or without a folder.
  if (native) return <NativeGate native={native} projectName={projectName} />;
  return <Shell />;
}

/**
 * Electron only: tell the main process which folder the window is on (it owns
 * the native title) and hold the first paint until that round trip is done, so
 * the shell lays out once rather than twice.
 *
 * Only the FIRST one. This used to be keyed by the folder, which tore the whole
 * shell down and rebuilt it on every project switch: the rail went with it, and
 * the gate below rendered nothing until the round trip came back, so switching
 * projects meant a blank window and a rail that reappeared having lost its
 * scroll. Everything a folder owns is already cleared by `openWorkspace`, so
 * the remount was never what made the switch correct. The title is a message
 * to the main process and nothing here has to wait for it.
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
 * What the working area is keyed by, which decides what a project switch is
 * allowed to tear down.
 *
 * The folder, so moving between projects replays the entrance and the working
 * area arrives rather than blinks. But NOT while a global screen is up: Skills
 * and the Tester screen are the person's, not the folder's, and closing a
 * project deliberately leaves you standing on one of them. Keyed by the folder
 * alone, that close remounted the screen underneath the reader and took an
 * unsaved skill with it, with no navigation to explain where it went.
 *
 * Prefixed so a folder can be called anything, including "skills", without
 * colliding with the screen of that name.
 */
export function screenKey(screen: 'skills' | 'tester' | null, projectPath: string | null): string {
  if (screen !== null) return `screen:${screen}`;
  return projectPath === null ? 'home' : `project:${projectPath}`;
}

/**
 * Whether the playtest column is actually on the screen.
 *
 * `paneOpen` is a folder's remembered preference, not a fact about what is
 * drawn: the column renders in the working view alone, and the project screen,
 * the blank composer and the global screens are drawn INSTEAD of it (see the
 * routing below). So a folder that likes the column open arrived on its own
 * project screen with the top bar offering to "Hide playtest" over nothing,
 * and pressing that closed a column nobody could see — the same dead button
 * from the other side. The narrow layout's tab switcher had the same problem:
 * two tabs for two regions, neither of which was rendered.
 *
 * `globalPlace` is reused rather than restated so the top bar and the layout
 * cannot drift apart about where the window is.
 */
export function paneOnScreen(state: {
  paneOpen: boolean;
  screen: 'skills' | 'tester' | null;
  composing: boolean;
  projectView: boolean;
  projectPath: string | null;
}): boolean {
  return state.paneOpen && !state.projectView && globalPlace(state) === null;
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
  const projectPath = useApp((s) => s.projectPath);
  const hasFolder = projectPath !== null;
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
  // The boundary's way out: leaving a screen that could not draw returns you to
  // the conversation, which is the one surface that is always there.
  const closeScreen = useApp((s) => s.closeScreen);

  return (
    <div className={`app-shell${narrow ? ' is-narrow' : ''}`}>
      <Sidebar />
      <div className="app-main">
        {/* What is on the screen, not what the folder remembers: the toggle
            must describe the column the person can see, and the narrow tabs
            must not offer a region that is not being drawn. See paneOnScreen. */}
        <TopBar narrow={narrow} paneOpen={paneOnScreen({ paneOpen, screen, composing, projectView, projectPath })} />
        {/* Keyed by the folder, so moving between projects replays the
            entrance below and the working area arrives rather than blinks.
            This is the ONLY thing the project still remounts: the rail, the
            top bar and the window keep going, which is the whole difference
            between switching project and reloading the app. A global screen
            takes the key over while it is up — see screenKey. */}
        <div className="app-screen" key={screenKey(screen, projectPath)}>
        {/* One bad row must not take the window with it. A malformed tester
            note used to throw out of render and blank the WHOLE app, leaving a
            reload as the only way back and blanking again on the next one.
            Wrapped here rather than around the shell so the rail, the top bar
            and the window survive whatever the screen did, and the `key` above
            resets the boundary on a project switch for free. */}
        <ScreenBoundary surface="This screen" onLeave={closeScreen}>
        {screen === 'skills' ? (
          <SkillsScreen />
        ) : screen === 'tester' ? (
          <TesterHistory />
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
        </ScreenBoundary>
        </div>
      </div>
      <CodePeek />
      <SettingsDialog />
      {/* The one place a project gets named, wherever the asking came from:
          the rail's New project, or a first message with nowhere to land. */}
      <ProjectNamer />
      {/* Renders nothing. It is where the window-wide keyboard shortcuts live,
          mounted once so they work whatever surface is on screen. */}
      <ShortcutLayer />
    </div>
  );
}
