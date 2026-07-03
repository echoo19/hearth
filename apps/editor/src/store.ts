/**
 * Editor state. One zustand store: open project, current scene (full data),
 * selection, console, diff. Every mutation goes through `exec()`, which POSTs
 * a core command and refreshes the model from the source of truth.
 */
import { create } from 'zustand';
import { apiCommand, apiMeta, apiOpenProject, apiCreateProject } from './api';
import type {
  AssetItem,
  CommandResult,
  ComponentDoc,
  ConsoleEntry,
  ConsoleLevel,
  ConsoleSource,
  ProjectDiff,
  ProjectInfo,
  SceneData,
  ServerMeta,
} from './types';

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
const LAST_PROJECT_KEY = 'hearth:lastProject';

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
      playing: false,
      debugDraw: false,
    });
    get().log('info', 'editor', `Opened project "${info.name}" (${info.scenes.length} scene${info.scenes.length === 1 ? '' : 's'})`);
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
    playing: false,
    runNonce: 0,
    debugDraw: false,

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
      set({
        projectPath: null,
        info: null,
        sceneId: null,
        scene: null,
        assets: [],
        selection: null,
        diff: null,
        playing: false,
        debugDraw: false,
      });
    },

    async selectScene(sceneId) {
      set({ sceneId, selection: null, playing: false, debugDraw: false });
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
        get().log('error', 'command', `${name}: ${err.message}`);
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
        await get().refresh();
      }
      return result as CommandResult<never>;
    },
  };
});
