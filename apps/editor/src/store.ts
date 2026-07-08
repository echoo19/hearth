/**
 * Editor state. One zustand store: open project, current scene (full data),
 * selection, console, diff. Every mutation goes through `exec()`, which POSTs
 * a core command and refreshes the model from the source of truth.
 */
import { create } from 'zustand';
import { apiCommand, apiMeta, apiOpenProject, apiCreateProject, apiDetectAgents } from './api';
import type {
  AssetItem,
  CommandResult,
  ComponentDoc,
  ConsoleEntry,
  ConsoleLevel,
  ConsoleSource,
  JournalEntry,
  ProjectDiff,
  ProjectInfo,
  SceneData,
  ServerMeta,
  Vec2,
} from './types';
import type { WsFrame } from '../server/ws';
import type { AgentPermissionMode, DetectAgentsResult } from '../server/agentSetup';
import { ingestPtyFrame, resetAgentSocket, type AgentStatus } from './components/agent/useAgentSocket';

interface EditorState {
  meta: ServerMeta | null;
  projectPath: string | null;
  info: ProjectInfo | null;
  sceneId: string | null;
  scene: SceneData | null;
  assets: AssetItem[];
  componentDocs: ComponentDoc[];
  selection: string | null;
  consoleEntries: ConsoleEntry[];
  consoleUnread: number;
  /** Whether the Console panel is currently visible in the workspace (its tab selected). */
  consoleOpen: boolean;
  diff: ProjectDiff | null;
  /**
   * Bumped after every successful mutating exec(). A lightweight "something
   * changed" signal for panels that re-query read-only commands on change
   * (e.g. the Diff panel's history list) without per-command wiring.
   */
  commandSeq: number;
  /**
   * Recent journal entries pushed over the WS channel (own commands too, so
   * a future timeline UI can show everything) — newest last, capped so it
   * never grows unbounded across a long session.
   */
  journalFeed: JournalEntry[];
  /** Status of the /api/ws connection for the open project (or 'disconnected' when none is open). */
  wsStatus: 'connected' | 'connecting' | 'disconnected';
  playing: boolean;
  /** Bumped every time playback starts, so the preview restarts from the current scene state. */
  runNonce: number;
  /**
   * Game preview debug overlay (collider outlines, velocity vectors, light
   * radii — wired to PixiSceneView.setDebugDraw). Off by default; resets to
   * false whenever the preview remounts (new Play, scene switch, close), no
   * persistence across sessions this wave.
   */
  debugDraw: boolean;

  /** Embedded agent terminal (Agent panel): high-level status/mode/detect state.
   * The pty session itself (scrollback and all) lives outside zustand (see
   * components/agent/useAgentSocket.ts) so it survives that panel's own
   * component tree unmounting; `agentStatus` is mirrored from that store by
   * a single subscription registered there — never set by hand here — so
   * other panels (and Task 6's activity timeline) can select it without a
   * second source of truth. */
  agentStatus: AgentStatus;
  agentMode: AgentPermissionMode;
  agentDetect: DetectAgentsResult | null;
  agentDetecting: boolean;
  /** Whether `snapshotProject` has succeeded at least once this editor session
   * (any panel — DiffPanel's Snapshot button and the Agent panel's Timeline
   * both funnel through `exec()`, which is what flips this). Resets when the
   * project changes; the flag is purely "have I seen a baseline get taken
   * this session", not a read of what's on disk. */
  snapshotTaken: boolean;
  /** Bumped to ask the workspace shell to focus the Diff panel (Task 6's
   * "Review changes"). A counter rather than a boolean so repeated requests
   * while already on the Diff panel still register as a change; mirrors the
   * `playing` -> "surface the Game panel" pattern in Workspace.tsx. */
  diffFocusRequest: number;
  /**
   * World-space center of the current SceneView viewport, kept in sync by
   * SceneView on every pan/zoom/fit. Consumers outside SceneView (e.g.
   * AssetsPanel's "Add to scene") read this instead of reaching into
   * SceneView internals; null before any SceneView has mounted/measured a
   * host size, in which case callers fall back to (0,0).
   */
  sceneViewCenter: Vec2 | null;

  setAgentMode(mode: AgentPermissionMode): void;
  detectAgent(): Promise<void>;
  /** Sends a pty-* frame over the shared WS socket; a no-op (returns false) when disconnected. */
  sendAgentFrame(frame: WsFrame): boolean;
  requestDiffFocus(): void;
  setSceneViewCenter(center: Vec2 | null): void;

  loadMeta(): Promise<void>;
  openProject(path: string): Promise<{ ok: boolean; error?: string }>;
  createProject(dir: string, name: string, description?: string): Promise<{ ok: boolean; error?: string }>;
  closeProject(): void;
  selectScene(sceneId: string): Promise<void>;
  select(entityId: string | null): void;
  setConsoleOpen(open: boolean): void;
  setPlaying(playing: boolean): void;
  setDebugDraw(on: boolean): void;
  log(level: ConsoleLevel, source: ConsoleSource, message: string): void;
  clearConsole(): void;
  refresh(): Promise<void>;
  refreshDiff(): Promise<void>;
  /**
   * Execute a core command against the open project. Errors and warnings land
   * in the Console; successful mutations trigger a model refresh.
   */
  exec<T = unknown>(name: string, params?: unknown, opts?: { quiet?: boolean }): Promise<CommandResult<T>>;
}

let entryId = 0;

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function makeEntry(level: ConsoleLevel, source: ConsoleSource, message: string): ConsoleEntry {
  return { id: ++entryId, time: timestamp(), level, source, message };
}

const MAX_CONSOLE = 500;
const MAX_JOURNAL_FEED = 200;
const LAST_PROJECT_KEY = 'hearth:lastProject';
const WS_BACKOFF_INITIAL_MS = 1000;
const WS_BACKOFF_MAX_MS = 5000;

export const useEditor = create<EditorState>((set, get) => {
  /** Run a read-only command without console noise (errors still logged). */
  async function query<T>(name: string, params: unknown = {}): Promise<T | null> {
    const project = get().projectPath;
    if (!project) return null;
    const result = await apiCommand<T>(project, name, params);
    if (!result.success) {
      for (const err of result.errors) {
        get().log('error', 'command', `${name}: ${err.message}`);
      }
      return null;
    }
    return result.data;
  }

  // --- WebSocket channel (journal push + external-change awareness) -------
  //
  // Connects lazily once a project is open, reconnects on drop with capped
  // exponential backoff, and tears itself down on project close. `wsEpoch`
  // invalidates callbacks/timers from a superseded connection attempt (a
  // project switch, or an explicit disconnect) so a stale reconnect never
  // resurrects a socket for a project that's no longer open.
  let ws: WebSocket | null = null;
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsBackoffMs = WS_BACKOFF_INITIAL_MS;
  let wsEpoch = 0;

  function wsUrl(project: string): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/ws?project=${encodeURIComponent(project)}`;
  }

  function teardownSocket(): void {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (ws) {
      const socket = ws;
      ws = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }

  function pushJournalFeed(entries: JournalEntry[]): void {
    set((state) => ({
      journalFeed: [...state.journalFeed, ...entries].slice(-MAX_JOURNAL_FEED),
    }));
  }

  function scheduleReconnect(project: string, epoch: number): void {
    const delay = wsBackoffMs;
    wsBackoffMs = Math.min(wsBackoffMs * 2, WS_BACKOFF_MAX_MS);
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      if (epoch !== wsEpoch) return; // superseded by a project switch/close
      connectWs(project);
    }, delay);
  }

  function connectWs(project: string): void {
    const epoch = ++wsEpoch;
    teardownSocket();
    // A fresh socket means a fresh pty on the server (a new project root, or
    // a reconnect after a drop that already killed the old one) — never let
    // a prior project's agent session bleed into this connection.
    resetAgentSocket();
    set({ wsStatus: 'connecting' });
    const socket = new WebSocket(wsUrl(project));
    ws = socket;

    socket.onopen = () => {
      if (epoch !== wsEpoch) return;
      wsBackoffMs = WS_BACKOFF_INITIAL_MS;
      set({ wsStatus: 'connected' });
    };
    socket.onmessage = (event) => {
      if (epoch !== wsEpoch) return;
      let frame: WsFrame;
      try {
        frame = JSON.parse(event.data as string) as WsFrame;
      } catch {
        return;
      }
      if (frame.type === 'journal') {
        pushJournalFeed(frame.entries);
        if (frame.entries.some((entry) => entry.source !== 'editor')) {
          set((state) => ({ commandSeq: state.commandSeq + 1 }));
          void get().refresh();
        }
        return;
      }
      if (frame.type === 'pty-data' || frame.type === 'pty-exit' || frame.type === 'pty-error') {
        ingestPtyFrame(frame);
        return;
      }
      // pty-input/pty-resize/pty-start/pty-stop are client -> server only.
    };
    socket.onclose = () => {
      if (epoch !== wsEpoch) return;
      ws = null;
      set({ wsStatus: 'disconnected' });
      // The server always kills the owning pty when its socket closes (see
      // ws.ts releaseSocket), so any live agent session died with it.
      resetAgentSocket();
      scheduleReconnect(project, epoch);
    };
  }

  function disconnectWs(): void {
    wsEpoch++; // invalidate any in-flight handlers/reconnect timers
    wsBackoffMs = WS_BACKOFF_INITIAL_MS;
    teardownSocket();
    set({ wsStatus: 'disconnected' });
    resetAgentSocket();
  }

  async function afterOpen(path: string, info: ProjectInfo): Promise<void> {
    try {
      localStorage.setItem(LAST_PROJECT_KEY, path);
    } catch {
      /* private mode etc. */
    }
    set({
      projectPath: path,
      info,
      sceneId: info.initialScene ?? info.scenes[0]?.id ?? null,
      scene: null,
      selection: null,
      diff: null,
      assets: [],
      journalFeed: [],
      playing: false,
      debugDraw: false,
      snapshotTaken: false,
      sceneViewCenter: null,
    });
    get().log('info', 'editor', `Opened project "${info.name}" (${info.scenes.length} scene${info.scenes.length === 1 ? '' : 's'})`);
    connectWs(path);
    const docs = await query<{ components: ComponentDoc[] }>('inspectComponents');
    if (docs) set({ componentDocs: docs.components });
    await get().refresh();
  }

  return {
    meta: null,
    projectPath: null,
    info: null,
    sceneId: null,
    scene: null,
    assets: [],
    componentDocs: [],
    selection: null,
    consoleEntries: [],
    consoleUnread: 0,
    consoleOpen: false,
    diff: null,
    commandSeq: 0,
    journalFeed: [],
    wsStatus: 'disconnected',
    playing: false,
    runNonce: 0,
    debugDraw: false,

    agentStatus: 'idle',
    agentMode: 'safe-edit',
    agentDetect: null,
    agentDetecting: false,
    snapshotTaken: false,
    diffFocusRequest: 0,
    sceneViewCenter: null,

    setAgentMode(mode) {
      set({ agentMode: mode });
    },

    requestDiffFocus() {
      set((state) => ({ diffFocusRequest: state.diffFocusRequest + 1 }));
    },

    setSceneViewCenter(center) {
      set({ sceneViewCenter: center });
    },

    async detectAgent() {
      set({ agentDetecting: true });
      const result = await apiDetectAgents();
      set({ agentDetect: result, agentDetecting: false });
    },

    sendAgentFrame(frame) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },

    async loadMeta() {
      const meta = await apiMeta();
      if (meta) set({ meta });
      // Reopen the last project after a page reload (dev HMR, F5).
      if (!get().projectPath) {
        let last: string | null = null;
        try {
          last = localStorage.getItem(LAST_PROJECT_KEY);
        } catch {
          /* ignore */
        }
        if (last) {
          const res = await apiOpenProject(last);
          if (res.ok && res.path && res.info) await afterOpen(res.path, res.info);
        }
      }
    },

    async openProject(path) {
      const res = await apiOpenProject(path);
      if (!res.ok || !res.path || !res.info) {
        return { ok: false, error: res.error ?? 'Failed to open project' };
      }
      await afterOpen(res.path, res.info);
      return { ok: true };
    },

    async createProject(dir, name, description) {
      const res = await apiCreateProject(dir, name, description);
      if (!res.ok || !res.path || !res.info) {
        return { ok: false, error: res.error ?? 'Failed to create project' };
      }
      await afterOpen(res.path, res.info);
      return { ok: true };
    },

    closeProject() {
      try {
        localStorage.removeItem(LAST_PROJECT_KEY);
      } catch {
        /* ignore */
      }
      disconnectWs();
      set({
        projectPath: null,
        info: null,
        sceneId: null,
        scene: null,
        assets: [],
        selection: null,
        diff: null,
        journalFeed: [],
        playing: false,
        debugDraw: false,
        snapshotTaken: false,
        sceneViewCenter: null,
      });
    },

    async selectScene(sceneId) {
      // A center measured against the previous scene's viewport doesn't apply
      // here; SceneView re-measures and pushes a fresh one once mounted.
      set({ sceneId, selection: null, playing: false, debugDraw: false, sceneViewCenter: null });
      await get().refresh();
    },

    select(entityId) {
      set({ selection: entityId });
    },

    setConsoleOpen(open) {
      // Seeing the console clears the unread badge, as clicking the tab used to.
      set(open ? { consoleOpen: true, consoleUnread: 0 } : { consoleOpen: false });
    },

    setPlaying(playing) {
      // Play always runs the scene as it is now (Godot-style); Stop freezes it.
      // Starting a run remounts the preview (see GamePreview's runNonce effect),
      // so debugDraw resets to off along with it — no persistence across runs.
      set((state) => ({
        playing,
        runNonce: playing ? state.runNonce + 1 : state.runNonce,
        debugDraw: playing ? false : state.debugDraw,
      }));
    },

    setDebugDraw(on) {
      set({ debugDraw: on });
    },

    log(level, source, message) {
      set((state) => ({
        consoleEntries: [...state.consoleEntries.slice(-MAX_CONSOLE + 1), makeEntry(level, source, message)],
        consoleUnread:
          level === 'error' && !state.consoleOpen ? state.consoleUnread + 1 : state.consoleUnread,
      }));
    },

    clearConsole() {
      set({ consoleEntries: [], consoleUnread: 0 });
    },

    async refresh() {
      const { projectPath } = get();
      if (!projectPath) return;

      const info = await query<ProjectInfo>('inspectProject');
      if (!info) return;

      // Keep the current scene when it still exists; fall back sensibly.
      let sceneId = get().sceneId;
      if (!sceneId || !info.scenes.some((s) => s.id === sceneId)) {
        sceneId = info.initialScene ?? info.scenes[0]?.id ?? null;
      }

      const [scene, assetData] = await Promise.all([
        sceneId ? query<SceneData>('inspectScene', { scene: sceneId, full: true }) : Promise.resolve(null),
        query<{ assets: AssetItem[] }>('inspectAssets'),
      ]);

      const selection = get().selection;
      set({
        info,
        sceneId,
        scene: scene ?? null,
        assets: assetData?.assets ?? [],
        selection: scene && selection && scene.entities.some((e) => e.id === selection) ? selection : null,
      });
    },

    async refreshDiff() {
      const project = get().projectPath;
      if (!project) return;
      const result = await apiCommand<ProjectDiff>(project, 'diffProject');
      if (result.success && result.data) {
        set({ diff: result.data });
      } else {
        set({ diff: null });
        for (const err of result.errors) {
          get().log(err.code === 'NOT_FOUND' ? 'info' : 'error', 'command', `diffProject: ${err.message}`);
        }
      }
    },

    async exec(name, params = {}, opts = {}) {
      const project = get().projectPath;
      if (!project) {
        return {
          success: false,
          command: name,
          data: null,
          errors: [{ code: 'NO_PROJECT', message: 'No project open' }],
          warnings: [],
          changed: [],
          files: [],
          suggestions: [],
        } as CommandResult<never>;
      }
      const result = await apiCommand(project, name, params);
      for (const err of result.errors) {
        // Empty history isn't an error worth a Console badge (same treatment
        // as refreshDiff's NOT_FOUND for a missing baseline below).
        const emptyHistory = (name === 'undo' || name === 'redo') && err.code === 'NOT_FOUND';
        get().log(emptyHistory ? 'info' : 'error', 'command', `${name}: ${err.message}`);
      }
      for (const warning of result.warnings) {
        get().log('warn', 'command', `${name}: ${warning.message}`);
      }
      if (result.success && !opts.quiet && result.changed.length > 0) {
        const summary = result.changed
          .map((c) => `${c.action} ${c.kind}${c.name ? ` "${c.name}"` : ''}`)
          .slice(0, 3)
          .join(', ');
        get().log('info', 'command', `${name}: ${summary}${result.changed.length > 3 ? ', …' : ''}`);
      }
      if (result.success && (result.changed.length > 0 || result.files.length > 0)) {
        set((state) => ({ commandSeq: state.commandSeq + 1 }));
        await get().refresh();
      }
      // Centralized here (rather than in each caller) so any surface that
      // triggers a snapshot — DiffPanel's button or the Agent panel's
      // Timeline — flips the same session-scoped "have I snapshotted" flag.
      if (result.success && name === 'snapshotProject') {
        set({ snapshotTaken: true });
      }
      return result as CommandResult<never>;
    },
  };
});
