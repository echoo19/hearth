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
import { LivePanel } from '../components/LivePanel';
import { AnimatorEditor } from '../components/AnimatorEditor';
import { restoreLayout, serializeLayout, type PanelId } from './layout';

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
const BOTTOM_HEIGHT = 260;

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

/** Game panel: pause the preview when its tab is hidden (parity with the old tab strip). */
function GamePanelHost(props: IDockviewPanelProps) {
  const setPlaying = useEditor((s) => s.setPlaying);
  useEffect(() => {
    const disposable = props.api.onDidVisibilityChange(({ isVisible }) => {
      if (!isVisible) setPlaying(false);
    });
    return () => disposable.dispose();
  }, [props.api, setPlaying]);
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
  for (const id of ['console', 'diff', 'agent', 'input'] as const) {
    api.addPanel(addPanelOptions(id, { position: { referencePanel: 'assets', direction: 'within' }, inactive: true }));
  }
  scene.api.setActive();
}

/** A living panel to anchor re-opened panels against. */
function findReference(api: DockviewApi, preferred: readonly PanelId[]): PanelId | null {
  for (const id of preferred) {
    if (api.getPanel(id)) return id;
  }
  return null;
}

const CENTER_PANELS: readonly PanelId[] = ['scene', 'game', 'code', 'animator'];
const BOTTOM_PANELS: readonly PanelId[] = ['assets', 'console', 'diff', 'agent', 'input', 'live'];

/**
 * Show a panel: activate it when open, otherwise re-open it in a sensible
 * location relative to whatever groups are still alive.
 */
export function showPanel(api: DockviewApi, id: PanelId): void {
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

/** Rebuild the default layout and persist it. */
export function resetLayout(api: DockviewApi, storageKey: string): void {
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

function initLayout(api: DockviewApi, storageKey: string): void {
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
  const diffFocusRequest = useEditor((s) => s.diffFocusRequest);
  const codeOpenRequest = useEditor((s) => s.codeOpenRequest);
  const codeSearchRequest = useEditor((s) => s.codeSearchRequest);
  const animatorTarget = useEditor((s) => s.animatorTarget);
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
  useEffect(() => {
    if (playing && apiRef.current) showPanel(apiRef.current, 'game');
  }, [playing]);

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
