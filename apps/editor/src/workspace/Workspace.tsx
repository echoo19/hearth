/**
 * Dockable workspace shell built on dockview. Owns the panel registry, the
 * default layout, per-project layout persistence, and the store wiring that
 * used to hang off the fixed tab strips (console unread, diff refresh,
 * play-activates-game).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type AddPanelOptions,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
  type SerializedDockview,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { useEditor } from '../store';
import { Icon } from '../components/ui';
import { Hierarchy } from '../components/Hierarchy';
import { SceneView } from '../components/SceneView';
import { GamePreview } from '../components/GamePreview';
import { CodePanel } from '../components/CodePanel';
import { Inspector } from '../components/Inspector';
import { AssetsPanel } from '../components/AssetsPanel';
import { ConsolePanel } from '../components/ConsolePanel';
import { DiffPanel } from '../components/DiffPanel';
import { AgentPanel } from '../components/AgentPanel';
import { InputSettings } from '../components/InputSettings';
import { GameSettings } from '../components/GameSettings';
import { LivePanel } from '../components/LivePanel';
import { AnimatorEditor } from '../components/AnimatorEditor';
import { ensureGroupsActive, restoreLayout, serializeLayout, type PanelId } from './layout';

export const PANEL_TITLES: Record<PanelId, string> = {
  hierarchy: 'Hierarchy',
  scene: 'Scene',
  game: 'Game',
  code: 'Code',
  inspector: 'Inspector',
  assets: 'Assets',
  console: 'Console',
  diff: 'Changes',
  agent: 'Agent',
  input: 'Input',
  gameSettings: 'Game Settings',
  live: 'Live',
  animator: 'Animator',
};

/** Menu order for the View menu (matches the default layout, left to right). */
export const VIEW_MENU_PANELS: readonly PanelId[] = [
  'hierarchy',
  'scene',
  'game',
  'code',
  'inspector',
  'assets',
  'console',
  'diff',
  'agent',
  'input',
  'gameSettings',
  'live',
  'animator',
];

const HEARTH_THEME: DockviewTheme = {
  name: 'hearth',
  className: 'dockview-theme-hearth',
  colorScheme: 'dark',
  tabGroupIndicator: 'none',
};

const SAVE_DEBOUNCE_MS = 300;
const LEFT_WIDTH = 260;
const RIGHT_WIDTH = 300;
// The bottom group is shared by every bottom-docked panel (Assets, Console,
// Diff, Agent, Input, Game Settings, Live) — there's no per-panel default
// height in dockview, only this group's. 260px left the Agent panel's
// terminal/timeline at ~6 rows on first open, cramped enough to read as a
// bug for what's meant to be a primary, high-attention surface (AGENT-9 /
// L-097); 340px gives it real breathing room without pushing the Scene view
// too short at a typical laptop height.
const BOTTOM_HEIGHT = 340;

// ---------------------------------------------------------------------------
// Panel content wrappers — existing panels rendered inside a dockview panel.
// The wrapper provides the positioning context the panels used to get from
// the fixed shell (Scene/Game are `position: absolute; inset: 0`).
// ---------------------------------------------------------------------------

function panelHost(Content: React.ComponentType, canvas = false): React.FunctionComponent<IDockviewPanelProps> {
  const Host: React.FunctionComponent<IDockviewPanelProps> = () => (
    <div className={canvas ? 'workspace-panel workspace-panel-canvas' : 'workspace-panel'}>
      <Content />
    </div>
  );
  Host.displayName = `PanelHost(${Content.displayName ?? Content.name ?? 'Panel'})`;
  return Host;
}

/**
 * Game panel: pause (not stop) the running preview when its tab is hidden, and
 * auto-resume when it's shown again (L-067). Hiding used to hard-Stop the run —
 * losing all play state — which made the "open Code, edit, hot-reload while
 * playing" workflow unreachable by default. Now hiding tab-pauses via the
 * store: the simulation freezes and audio suspends (the render ticker and
 * gamepad polling keep running by design — see PixiSceneView.pause), so the
 * run and its state survive a trip to the Code tab; an explicit toolbar Pause
 * is preserved across the round trip.
 */
function GamePanelHost(props: IDockviewPanelProps) {
  const setGameTabVisible = useEditor((s) => s.setGameTabVisible);
  useEffect(() => {
    setGameTabVisible(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange(({ isVisible }) => setGameTabVisible(isVisible));
    return () => disposable.dispose();
  }, [props.api, setGameTabVisible]);
  return (
    <div className="workspace-panel workspace-panel-canvas">
      <GamePreview />
    </div>
  );
}

/** Console panel: mirror its visibility into the store so unread counting works. */
function ConsolePanelHost(props: IDockviewPanelProps) {
  const setConsoleOpen = useEditor((s) => s.setConsoleOpen);
  useEffect(() => {
    setConsoleOpen(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange(({ isVisible }) => setConsoleOpen(isVisible));
    return () => {
      disposable.dispose();
      setConsoleOpen(false);
    };
  }, [props.api, setConsoleOpen]);
  return (
    <div className="workspace-panel">
      <ConsolePanel />
    </div>
  );
}

/** Live panel: only polls the runtime while its tab is actually visible. */
function LivePanelHost(props: IDockviewPanelProps) {
  const [visible, setVisible] = useState(props.api.isVisible);
  useEffect(() => {
    setVisible(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange(({ isVisible }) => setVisible(isVisible));
    return () => disposable.dispose();
  }, [props.api]);
  return (
    <div className="workspace-panel">
      <LivePanel visible={visible} />
    </div>
  );
}

const PANEL_COMPONENTS: Record<PanelId, React.FunctionComponent<IDockviewPanelProps>> = {
  hierarchy: panelHost(Hierarchy),
  scene: panelHost(SceneView, true),
  game: GamePanelHost,
  code: panelHost(CodePanel),
  inspector: panelHost(Inspector),
  assets: panelHost(AssetsPanel),
  console: ConsolePanelHost,
  diff: panelHost(DiffPanel),
  agent: panelHost(AgentPanel),
  input: panelHost(InputSettings),
  gameSettings: panelHost(GameSettings),
  live: LivePanelHost,
  animator: panelHost(AnimatorEditor),
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function TabInner({ api, badge }: { api: IDockviewPanelHeaderProps['api']; badge?: number }) {
  const [title, setTitle] = useState(api.title ?? api.id);
  useEffect(() => {
    setTitle(api.title ?? api.id);
    const disposable = api.onDidTitleChange(({ title: next }) => setTitle(next));
    return () => disposable.dispose();
  }, [api]);
  return (
    <div className="hearth-tab">
      <span className="hearth-tab-title">{title}</span>
      {badge != null && badge > 0 && <span className="badge">{badge > 99 ? '99+' : badge}</span>}
      <button
        className="hearth-tab-close"
        aria-label={`Close ${title}`}
        title={`Close ${title}`}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          api.close();
        }}
      >
        <Icon name="cross" size={9} />
      </button>
    </div>
  );
}

function HearthTab(props: IDockviewPanelHeaderProps) {
  return <TabInner api={props.api} />;
}

/** Console tab: unread error count rendered as a badge, cleared on activation. */
function ConsoleTab(props: IDockviewPanelHeaderProps) {
  const unread = useEditor((s) => s.consoleUnread);
  return <TabInner api={props.api} badge={unread} />;
}

const TAB_COMPONENTS = { console: ConsoleTab };

function Watermark(_props: IWatermarkPanelProps) {
  return (
    <div className="workspace-watermark">
      <span>All panels are closed</span>
      <span className="hint">Reopen them from the View menu in the toolbar.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout building & panel placement
// ---------------------------------------------------------------------------

function addPanelOptions(id: PanelId, extra?: Partial<AddPanelOptions>): AddPanelOptions {
  return {
    id,
    component: id,
    title: PANEL_TITLES[id],
    ...(id === 'console' ? { tabComponent: 'console' } : {}),
    ...extra,
  } as AddPanelOptions;
}

/** Today's fixed shell, rebuilt as a dockview layout. */
export function buildDefaultLayout(api: DockviewApi): void {
  api.clear();
  const scene = api.addPanel(addPanelOptions('scene'));
  api.addPanel(addPanelOptions('game', { position: { referencePanel: 'scene', direction: 'within' }, inactive: true }));
  api.addPanel(addPanelOptions('code', { position: { referencePanel: 'scene', direction: 'within' }, inactive: true }));
  api.addPanel(
    addPanelOptions('hierarchy', {
      position: { referencePanel: 'scene', direction: 'left' },
      initialWidth: LEFT_WIDTH,
      inactive: true,
    }),
  );
  api.addPanel(
    addPanelOptions('inspector', {
      position: { referencePanel: 'scene', direction: 'right' },
      initialWidth: RIGHT_WIDTH,
      inactive: true,
    }),
  );
  api.addPanel(
    addPanelOptions('assets', {
      position: { referencePanel: 'scene', direction: 'below' },
      initialHeight: BOTTOM_HEIGHT,
      inactive: true,
    }),
  );
  for (const id of ['console', 'diff', 'agent', 'input', 'gameSettings'] as const) {
    api.addPanel(addPanelOptions(id, { position: { referencePanel: 'assets', direction: 'within' }, inactive: true }));
  }
  scene.api.setActive();
  // The side/bottom groups are seeded with their leading panel `inactive`, so
  // dockview leaves those groups with no active panel and paints the watermark
  // into them. Activate each group's first panel; the sweep re-activates the
  // Scene last so it stays the visually active group (cosmetic only).
  ensureGroupsActive(api);
}

/** A living panel to anchor re-opened panels against. */
function findReference(api: DockviewApi, preferred: readonly PanelId[]): PanelId | null {
  for (const id of preferred) {
    if (api.getPanel(id)) return id;
  }
  return null;
}

const CENTER_PANELS: readonly PanelId[] = ['scene', 'game', 'code', 'animator'];
const BOTTOM_PANELS: readonly PanelId[] = ['assets', 'console', 'diff', 'agent', 'input', 'gameSettings', 'live'];

/**
 * Show a panel: activate it when open, otherwise re-open it in a sensible
 * location relative to whatever groups are still alive.
 */
export function showPanel(api: DockviewApi, id: PanelId): void {
  // The View menu (and native menu) close over the parent's `dock` state,
  // which can briefly reference a disposed dockview during a project switch or
  // a StrictMode remount. Operating on a disposed api throws the uncaught
  // `Cannot read properties of null (reading 'clear')`-class error that used to
  // wedge the View menu; a stale toggle is better dropped than fatal.
  if (!isDockAlive(api)) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }

  const center = findReference(api, CENTER_PANELS);
  let extra: Partial<AddPanelOptions> | undefined;

  if (id === 'hierarchy' || id === 'inspector') {
    const ref = center ?? findReference(api, BOTTOM_PANELS);
    if (ref) {
      extra = {
        position: { referencePanel: ref, direction: id === 'hierarchy' ? 'left' : 'right' },
        initialWidth: id === 'hierarchy' ? LEFT_WIDTH : RIGHT_WIDTH,
      };
    }
  } else if (id === 'scene' || id === 'game' || id === 'code' || id === 'animator') {
    const sibling = findReference(
      api,
      CENTER_PANELS.filter((p) => p !== id),
    );
    if (sibling) extra = { position: { referencePanel: sibling, direction: 'within' } };
  } else {
    const sibling = findReference(
      api,
      BOTTOM_PANELS.filter((p) => p !== id),
    );
    if (sibling) {
      extra = { position: { referencePanel: sibling, direction: 'within' } };
    } else if (center) {
      extra = { position: { referencePanel: center, direction: 'below' }, initialHeight: BOTTOM_HEIGHT };
    }
  }

  api.addPanel(addPanelOptions(id, extra));
}

/**
 * Whether a dockview api still backs a live component. `dispose()` (project
 * switch / StrictMode remount) removes the dockview root element from the
 * document but leaves the api's groups/panels lists readable, so the only
 * reliable signal is DOM connectivity: a disposed dock's element is no longer
 * connected (verified empirically — mutating a disposed instance throws
 * NotFoundError / "invalid location"). The root element isn't public API, so
 * reach through the api's `component` field; if dockview ever reshapes those
 * internals we fail closed (treat as dead → no-op) rather than crash.
 */
function isDockAlive(api: DockviewApi): boolean {
  const element = (api as unknown as { component?: { element?: Element } }).component?.element;
  return element?.isConnected === true;
}

/** Rebuild the default layout and persist it. */
export function resetLayout(api: DockviewApi, storageKey: string): void {
  if (!isDockAlive(api)) return;
  buildDefaultLayout(api);
  writeLayout(api, storageKey);
}

function writeLayout(api: DockviewApi, storageKey: string): void {
  try {
    localStorage.setItem(storageKey, serializeLayout(api.toJSON()));
  } catch {
    /* private mode / quota — layout persistence is best-effort */
  }
}

/** Restore the persisted layout for `storageKey`, or build the default. Exported for tests. */
export function initLayout(api: DockviewApi, storageKey: string): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    /* ignore */
  }
  const stored = restoreLayout(raw);
  if (stored) {
    try {
      api.fromJSON(stored as SerializedDockview);
      // Older saves persisted headless groups (`activeView: null`); heal them
      // so a restored layout doesn't come back showing the watermark.
      ensureGroupsActive(api);
      return;
    } catch {
      /* corrupt beyond what validation catches — fall through to default */
    }
  }
  buildDefaultLayout(api);
}

// ---------------------------------------------------------------------------
// Workspace component
// ---------------------------------------------------------------------------

export function Workspace({
  storageKey,
  onReady,
}: {
  storageKey: string;
  onReady?: (api: DockviewApi | null) => void;
}) {
  const playing = useEditor((s) => s.playing);
  const runNonce = useEditor((s) => s.runNonce);
  const diffFocusRequest = useEditor((s) => s.diffFocusRequest);
  const codeOpenRequest = useEditor((s) => s.codeOpenRequest);
  const codeSearchRequest = useEditor((s) => s.codeSearchRequest);
  const animatorTarget = useEditor((s) => s.animatorTarget);
  const closeProjectRequest = useEditor((s) => s.closeProjectRequest);
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimer = useRef<number | null>(null);
  const disposables = useRef<{ dispose(): void }[]>([]);

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      initLayout(api, storageKey);

      disposables.current.push(
        api.onDidLayoutChange(() => {
          if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(() => {
            saveTimer.current = null;
            writeLayout(api, storageKey);
          }, SAVE_DEBOUNCE_MS);
        }),
        // Diff refresh-on-focus lived on the old tab strip; now it follows the panel.
        api.onDidActivePanelChange(({ panel }) => {
          if (panel?.id === 'diff') void useEditor.getState().refreshDiff();
        }),
      );

      onReady?.(api);
    },
    // storageKey is stable for the lifetime of this instance (parent keys us by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageKey],
  );

  // Pressing Play surfaces the Game panel (re-opening it if it was closed).
  // Keyed on runNonce as well as playing: restartPlay() keeps `playing` true
  // but bumps runNonce, so clicking Restart from another tab (e.g. Code, with
  // the run tab-paused) also brings the Game tab forward — the user asked to
  // restart, show them the restarted run. Surfacing the tab fires the panel's
  // visibility handler, which clears any tab-pause, so a restart never comes
  // up paused-and-hidden.
  useEffect(() => {
    if (playing && apiRef.current) showPanel(apiRef.current, 'game');
  }, [playing, runNonce]);

  // The Agent panel's "Review changes" action asks for the Diff panel the
  // same way: bump a counter in the store, react here (diffFocusRequest
  // starts at 0, so the initial mount is a no-op). refreshDiff() fires
  // exactly once in both cases: if the diff panel is already active, we call
  // it directly (since onDidActivePanelChange won't fire for a no-op setActive());
  // if not active, we show the panel, which triggers onDidActivePanelChange to call it.
  useEffect(() => {
    if (diffFocusRequest > 0 && apiRef.current) {
      const isDiffActive = apiRef.current.activePanel?.id === 'diff';
      if (isDiffActive) {
        // Diff panel already active; refreshDiff() directly since onDidActivePanelChange won't fire
        void useEditor.getState().refreshDiff();
      } else {
        // Diff panel not active; show it and let onDidActivePanelChange trigger refreshDiff()
        showPanel(apiRef.current, 'diff');
      }
    }
  }, [diffFocusRequest]);

  // openScriptAt() surfaces the Code panel the same way (the panel itself
  // opens/activates the buffer and scrolls to the line — this effect only
  // makes sure the panel is visible). Keyed on the request nonce so a repeat
  // open of the already-open script still re-surfaces the panel.
  useEffect(() => {
    if (codeOpenRequest && apiRef.current) showPanel(apiRef.current, 'code');
  }, [codeOpenRequest?.nonce]);

  // The global "Search scripts" shortcut (keybinds.ts) surfaces the Code
  // panel the same way; CodePanel itself reacts to the same counter to flip
  // into search mode and (re)focus the query input.
  useEffect(() => {
    if (codeSearchRequest > 0 && apiRef.current) showPanel(apiRef.current, 'code');
  }, [codeSearchRequest]);

  // openAnimatorFor() surfaces the Animator panel; AnimatorEditor itself reads
  // animatorTarget to load the requested state-machine asset. Keyed on the
  // nonce so a repeat open of the already-open asset still re-surfaces it.
  useEffect(() => {
    if (animatorTarget && apiRef.current) showPanel(apiRef.current, 'animator');
  }, [animatorTarget?.nonce]);

  // requestCloseProject() bumps this when a close needs to confirm discarding
  // unsaved script buffers; reveal the Code panel so its confirm dialog isn't
  // rendered inside a display:none dock panel (dockview hides inactive panels).
  // CodePanel reacts to the same counter to open the dialog (L-058).
  useEffect(() => {
    if (closeProjectRequest > 0 && apiRef.current) showPanel(apiRef.current, 'code');
  }, [closeProjectRequest]);

  // Flush a pending save and release listeners when the workspace unmounts
  // (project switch or close).
  useEffect(() => {
    return () => {
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (apiRef.current) writeLayout(apiRef.current, storageKey);
      }
      for (const d of disposables.current) d.dispose();
      disposables.current = [];
      apiRef.current = null;
      onReady?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="workspace">
      <DockviewReact
        components={PANEL_COMPONENTS}
        tabComponents={TAB_COMPONENTS}
        defaultTabComponent={HearthTab}
        watermarkComponent={Watermark}
        theme={HEARTH_THEME}
        onReady={handleReady}
      />
    </div>
  );
}
