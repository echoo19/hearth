/**
 * Editor state. One zustand store: open project, current scene (full data),
 * selection, console, diff. Every mutation goes through `exec()`, which POSTs
 * a core command and refreshes the model from the source of truth.
 */
import { create } from 'zustand';
import { apiCommand, apiMeta, apiOpenProject, apiCreateProject, apiDetectAgents, fileUrl } from './api';
import { classifyLocal, classifyJournal } from './livePatch';
import { getGameView } from './gameViewRef';
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
import type { RuntimeErrorEntry } from './runtimeBridge';
import type { AgentPermissionMode, DetectAgentsResult } from '../server/agentSetup';
import { ingestPtyFrame, resetAgentSocket, type AgentStatus } from './components/agent/useAgentSocket';
import { ingestExportFrame, resetExportJob } from './components/exportJob';
import { createNudgeQueue } from './nudgeQueue';

export interface EditorState {
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
  /**
   * A structural change (new/removed entity or component, settings, a reparent,
   * a new script) landed while a preview is running — the live world can't be
   * patched in place, so the Toolbar shows a "Scene changed — Restart" badge.
   * Set by the live dispatcher (local exec + external journal), cleared on
   * Play/Stop/restart. Only meaningful while `playing`.
   */
  pendingRestart: boolean;
  /**
   * Structured runtime errors (the full RuntimeError incl. script/line) from
   * the current run, newest last and capped. Fed by GamePreview's
   * onErrorEntry; a fresh Play/restart/scene-switch clears it. Task 7 turns
   * these into clickable script-panel diagnostics — this task only records them.
   */
  runtimeErrors: RuntimeErrorEntry[];
  /**
   * Play-mode debug pause (Task 9): freezes the running game in place without
   * stopping the run — distinct from `playing`/Stop, which tears the preview
   * down. Only meaningful while `playing`; Play/Stop both reset it to false.
   */
  paused: boolean;
  /**
   * True when the current `paused` state was entered automatically because the
   * Game tab was hidden (switching to Code/Scene), NOT by an explicit toolbar
   * Pause. Distinguishes the two so switching back to Game auto-resumes a
   * tab-paused run while preserving an explicit user pause. Only meaningful
   * while `playing && paused`; any explicit setPaused, Play/Stop, or restart
   * clears it. See setGameTabVisible (L-067).
   */
  pausedByTab: boolean;
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
  /** Whether the keyboard-shortcut cheat sheet overlay is open (Task 8). */
  shortcutSheetOpen: boolean;
  /**
   * Bumped to ask SceneView to center+fit the camera on the current
   * selection (the `f` shortcut). A counter rather than a boolean so a
   * repeat request re-focuses even when the selection hasn't changed —
   * mirrors the `diffFocusRequest` seam above.
   */
  focusSelectionRequest: number;
  /**
   * Bumped to ask the Hierarchy to open its delete-confirm dialog for the
   * current selection. The Delete/Backspace keybind routes through here so the
   * keyboard path and the row trash button share ONE deletion contract — both
   * confirm (HIER-3). A counter (not a boolean) so a repeat request re-opens
   * even when the selection hasn't changed; mirrors `focusSelectionRequest`.
   */
  deleteSelectionRequest: number;
  /**
   * Imperative "open this script in the Code panel" request, mirroring the
   * `diffFocusRequest` seam. Any panel (Inspector's Script component,
   * Assets, a diagnostic) calls `openScriptAt(path, line?)`; the workspace
   * shell surfaces the Code panel and CodePanel opens/activates that buffer,
   * scrolling to `line` (1-based) with a transient highlight when set. The
   * `nonce` makes a repeat request for the already-open script still fire.
   */
  codeOpenRequest: { path: string; line?: number; nonce: number } | null;
  /**
   * Imperative "open the Code panel's search bar" request (Task 9), mirroring
   * `diffFocusRequest`'s bare counter — search mode has no payload, just an
   * open-or-refocus signal, so a plain nonce is enough (the workspace shell
   * surfaces the Code panel; CodePanel flips into search mode and re-focuses
   * the query input on every bump, even if it was already open).
   */
  codeSearchRequest: number;
  /**
   * Imperative "open the Animator editor for this state-machine asset" request
   * (Task 8), mirroring `codeOpenRequest`. The Assets card's "Edit" action and
   * the Inspector's AnimationStateMachine row call `openAnimatorFor(assetId)`;
   * the workspace shell surfaces the Animator panel and AnimatorEditor loads
   * that asset's document. The `nonce` re-fires a repeat open of the same asset.
   */
  animatorTarget: { assetId: string; nonce: number } | null;
  /**
   * Whether the Code panel currently holds at least one dirty (unsaved) script
   * buffer. Published by CodePanel while it's mounted (the buffer list is its
   * local state); reset on project change/close and when the panel unmounts.
   * The Code panel is the one surface where auto-save is off, so this is the
   * only unsaved work a project close could silently discard — `closeProject`
   * routes through `requestCloseProject()` which consults this flag (L-058).
   */
  hasUnsavedScripts: boolean;
  /**
   * Bumped by `requestCloseProject()` when a close needs the user to confirm
   * discarding unsaved scripts. CodePanel watches it (and surfaces a confirm
   * dialog); Workspace reveals the Code panel on the same signal so the dialog
   * isn't rendered inside a display:none dock panel. A counter, so a second
   * close attempt after a cancel still re-triggers.
   */
  closeProjectRequest: number;

  setAgentMode(mode: AgentPermissionMode): void;
  detectAgent(): Promise<void>;
  /** Sends a pty-* frame over the shared WS socket; a no-op (returns false) when disconnected. */
  sendAgentFrame(frame: WsFrame): boolean;
  requestDiffFocus(): void;
  setSceneViewCenter(center: Vec2 | null): void;
  setShortcutSheet(open: boolean): void;
  toggleShortcutSheet(): void;
  requestFocusSelection(): void;
  /**
   * Ask the Hierarchy to confirm deleting the current selection (bumps
   * `deleteSelectionRequest`). Used by the Delete/Backspace keybind so it opens
   * the same ConfirmDialog as the row trash button instead of deleting
   * silently (HIER-3).
   */
  requestDeleteSelection(): void;
  /** Open (and surface) a script in the Code panel, optionally scrolling to
   * a 1-based line. See `codeOpenRequest`. */
  openScriptAt(path: string, line?: number): void;
  /** Open (and surface) the Code panel's search bar. See `codeSearchRequest`. */
  requestCodeSearch(): void;
  /** Open (and surface) the Animator editor targeting a state-machine asset. See `animatorTarget`. */
  openAnimatorFor(assetId: string): void;
  /** Shortcut actions (Task 8), each backed by an exec() where it mutates. */
  togglePlay(): void;
  checkpoint(): Promise<void>;
  /**
   * Undo / Redo the last command. Both the toolbar arrows, the Edit menu, and
   * the ⌘Z / ⇧⌘Z keybinds route through here so every trigger logs the same
   * friendly "reverted …"/"reapplied …" line (TOOLBAR-6). A no-op at the ends
   * of history — exec() returns success:false and nothing is logged.
   */
  undo(): Promise<void>;
  redo(): Promise<void>;
  duplicateSelection(): Promise<void>;
  deleteSelection(): Promise<void>;
  /**
   * Move the selection by (dx, dy) scene pixels. Arrow-key presses accumulate
   * and are debounced (~300ms) into ONE moveEntity exec per burst, so a run
   * of nudges collapses to a single undo step. The scene is updated
   * optimistically for immediate feedback; the debounced exec persists it.
   */
  nudgeSelection(dx: number, dy: number): void;

  loadMeta(): Promise<void>;
  openProject(path: string): Promise<{ ok: boolean; error?: string }>;
  createProject(
    dir: string,
    name: string,
    description?: string,
    template?: string,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Publish whether the Code panel holds unsaved script buffers (see `hasUnsavedScripts`). */
  setUnsavedScripts(has: boolean): void;
  /**
   * Close the project, but guard unsaved script buffers first: with dirty
   * scripts open, bump `closeProjectRequest` so the Code panel can confirm the
   * discard; otherwise close immediately. The "Close project" menu item routes
   * here instead of calling `closeProject()` directly (L-058).
   */
  requestCloseProject(): void;
  closeProject(): void;
  selectScene(sceneId: string): Promise<void>;
  select(entityId: string | null): void;
  setConsoleOpen(open: boolean): void;
  setPlaying(playing: boolean): void;
  /** Restart the running preview from the current scene, clearing the restart badge (the badge's action). */
  restartPlay(): void;
  /** Record a structured runtime error from the running preview (feeds Task 7's diagnostics). */
  recordRuntimeError(error: RuntimeErrorEntry): void;
  /**
   * Mirror one EXTERNAL journal entry (source !== 'editor') into the running
   * preview: hot-reload scripts, live-patch properties (scene-guarded, values
   * resolved via one read-only query per entity), or raise the restart badge.
   * The WS journal handler's per-entry step, run after refresh(); a no-op
   * unless `playing`. Exposed on the store (rather than staying a private
   * closure) so tests can drive the live-dispatch path without a socket.
   */
  applyExternalJournalEntry(entry: JournalEntry): Promise<void>;
  setPaused(paused: boolean): void;
  /**
   * Sync the Game tab's visibility into the play session (L-067). Hiding the
   * tab pauses a running preview (halting rAF/audio) instead of stopping it,
   * so switching to Code to hot-reload no longer tears the run down; showing
   * it again auto-resumes UNLESS the user had explicitly paused first. A no-op
   * when not playing.
   */
  setGameTabVisible(visible: boolean): void;
  setDebugDraw(on: boolean): void;
  /** `link` (Task 7): when present, ConsolePanel renders a clickable `path:line` suffix that jumps to it via `openScriptAt`. */
  log(level: ConsoleLevel, source: ConsoleSource, message: string, link?: ConsoleEntry['link']): void;
  clearConsole(): void;
  refresh(): Promise<void>;
  refreshDiff(): Promise<void>;
  /**
   * Execute a core command against the open project. Errors and warnings land
   * in the Console; successful mutations trigger a model refresh.
   */
  exec<T = unknown>(name: string, params?: unknown, opts?: { quiet?: boolean }): Promise<CommandResult<T>>;
  /**
   * Run a read-only command silently: no Console noise on success, still
   * logs (and swallows to `null`) on failure — see the module-level `query`
   * helper this wraps. Exposed on the store (rather than staying a private
   * closure) so panels like the Code panel can back their own read-only
   * queries (e.g. `checkScript` for lint) without a bespoke fetch path.
   */
  query<T = unknown>(name: string, params?: unknown): Promise<T | null>;
}

/** The full editor store (state + actions) as returned by `useEditor.getState()`. */
export type EditorStore = EditorState;

let entryId = 0;

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function makeEntry(level: ConsoleLevel, source: ConsoleSource, message: string, link?: ConsoleEntry['link']): ConsoleEntry {
  return { id: ++entryId, time: timestamp(), level, source, message, link };
}

/**
 * Plain-language, entity-first Console message for a runtime error (Task 7):
 * e.g. "Enemy hit an error in scripts/enemy.lua:12 — attempt to index a nil
 * value". Falls back gracefully as script/line go missing (no script at all
 * for a global/engine-level error; no line when it isn't extractable).
 */
function formatRuntimeError(error: RuntimeErrorEntry): string {
  const who = error.entity ?? 'Script';
  if (!error.script) return `${who} hit an error — ${error.message}`;
  const where = error.line != null ? `${error.script}:${error.line}` : error.script;
  return `${who} hit an error in ${where} — ${error.message}`;
}

/**
 * Recover a 1-based source line from a runtime error message that carries it
 * inline as "<script>:<line>". Load-time compile failures surface the line in
 * the message ("Failed to load script foo.lua: foo.lua:14: 'end' expected …")
 * but leave `RuntimeError.line` null — only the reload path populates it — so
 * the Console link opened the file at the top instead of the failing line
 * (CONSOLE-CHANGES-3 / L-061). The script path can appear more than once in
 * the message (a "Failed to load script <path>:" prefix), so match only the
 * occurrence immediately followed by a line number. Returns null when no such
 * `<script>:<digits>` pattern is present.
 */
function lineFromMessage(script: string, message: string): number | null {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}:(\\d+)`).exec(message);
  return match ? Number.parseInt(match[1], 10) : null;
}

const MAX_CONSOLE = 500;
const MAX_JOURNAL_FEED = 200;
const MAX_RUNTIME_ERRORS = 200;
const LAST_PROJECT_KEY = 'hearth:lastProject';
const WS_BACKOFF_INITIAL_MS = 1000;
const WS_BACKOFF_MAX_MS = 5000;

/**
 * Plain-language labels for the highest-traffic core commands, used in place
 * of the raw camelCase command name in Console lines (exec()'s error/warning/
 * summary log calls, and refreshDiff()'s diffProject error). Every mutating
 * action in the app funnels through exec(), so this is the actual "voice" of
 * the Console for command results — falling back to the raw name keeps
 * anything not yet in the map working, just less polished.
 */
const COMMAND_LABELS: Record<string, string> = {
  createEntity: 'Create entity',
  deleteEntity: 'Delete entity',
  moveEntity: 'Move entity',
  setComponentProperty: 'Edit component',
  editScript: 'Save script',
  snapshotProject: 'Save checkpoint',
  revertProject: 'Restore checkpoint',
  syncPrefabInstances: 'Sync prefab instances',
  diffProject: 'Review changes',
};

/** Plain-language label for a command name, falling back to the raw name. */
export function commandLabel(name: string): string {
  return COMMAND_LABELS[name] ?? name;
}

export const useEditor = create<EditorState>((set, get) => {
  /** Run a read-only command without console noise (errors still logged). */
  async function query<T>(name: string, params: unknown = {}): Promise<T | null> {
    const project = get().projectPath;
    if (!project) return null;
    const result = await apiCommand<T>(project, name, params);
    if (!result.success) {
      for (const err of result.errors) {
        get().log('error', 'command', `${commandLabel(name)}: ${err.message}`);
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

  // Dedupe concurrent loadMeta() calls: React.StrictMode double-invokes
  // App.tsx's mount effect in dev, and loadMeta's own `!projectPath` guard
  // can't catch the second call because the first is still awaiting the
  // async open — without this, both calls race past the guard and open (and
  // log "Opened project…" for) the same last-project twice. Dev-only in
  // practice (StrictMode doesn't double-invoke effects in production), but
  // memoizing the in-flight call is correct regardless of the cause.
  let loadMetaPromise: Promise<void> | null = null;

  // --- Arrow-key nudge: accumulate presses, debounce to one moveEntity ------
  // The in-flight burst lives outside zustand (its base position and running
  // delta are bookkeeping, not rendered state) in nudgeQueue.ts, which owns
  // the accumulate/debounce/flush contract. This closure just supplies the
  // `moveEntity` exec that a flush performs. Callers that tear down the
  // current scene/project (closeProject, selectScene, afterOpen) must flush
  // or clear the queue themselves — see those call sites below — so a
  // pending burst never fires ~300ms later against a scene/project that's
  // no longer open.
  const nudgeQueue = createNudgeQueue((p) => {
    const position = { x: p.base.x + p.accum.x, y: p.base.y + p.accum.y };
    void get().exec('moveEntity', { scene: p.scene, entity: p.entity, position }, { quiet: true });
  });

  /** Return a copy of `scene` with `entityId`'s Transform.position set to `pos`. */
  function withEntityPosition(scene: SceneData, entityId: string, pos: Vec2): SceneData {
    return {
      ...scene,
      entities: scene.entities.map((e) => {
        if (e.id !== entityId) return e;
        const transform = (e.components.Transform ?? {}) as Record<string, unknown>;
        return {
          ...e,
          components: { ...e.components, Transform: { ...transform, position: { x: pos.x, y: pos.y } } },
        };
      }),
    };
  }

  // --- Live update dispatch (Wave H) ---------------------------------------
  // Apply a classified LiveAction against the running preview. Patches go
  // straight to the live PixiSceneView (independent of the authored-scene
  // refresh); reloads hot-swap a script's source; structural changes raise
  // the restart badge. All best-effort: a stale entity ref just returns false.

  /** Split a "Camera.ambientLight" property into [componentType, "ambientLight"]. */
  function splitProperty(property: string): [string, string] {
    const dot = property.indexOf('.');
    return dot === -1 ? [property, ''] : [property.slice(0, dot), property.slice(dot + 1)];
  }

  /** Fetch a script's current on-disk source (used for external/format reloads). */
  async function fetchScriptSource(path: string): Promise<string | null> {
    const project = get().projectPath;
    if (!project) return null;
    try {
      const res = await fetch(fileUrl(project, path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      get().log('error', 'runtime', `Hot-reload failed: ${path} — ${(err as Error).message}`, {
        path,
        line: null,
      });
      return null;
    }
  }

  /** Hot-reload one script, logging the console notice (structured for Task 7 linkability). */
  async function applyReload(path: string, source: string | undefined): Promise<void> {
    const view = getGameView();
    if (!view?.reloadScript) return;
    const src = source ?? (await fetchScriptSource(path));
    if (src === null) return;
    const result = await view.reloadScript(path, src);
    if (result.ok) {
      const n = result.entities;
      get().log('info', 'runtime', `Hot-reloaded ${path} (${n} ${n === 1 ? 'entity' : 'entities'})`);
    } else {
      const at = result.line != null ? `${path}:${result.line}` : path;
      get().log('error', 'runtime', `Hot-reload failed: ${at} — ${result.message}`, {
        path,
        line: result.line,
      });
    }
  }

  /** Live-patch one component property on the running preview. */
  function applyPatch(entity: string, property: string, value: unknown): void {
    const [type, rest] = splitProperty(property);
    if (!rest) return;
    getGameView()?.patchComponent?.(entity, type, rest, value);
  }

  /** Read a dot-path value out of an entity's component bag (external patch resolution). */
  function readComponentPath(components: Record<string, unknown> | undefined, property: string): unknown {
    const [type, rest] = splitProperty(property);
    let node: unknown = components?.[type];
    for (const key of rest.split('.')) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  }

  /** Re-apply one component's top-level values onto the running preview, leaf by leaf. */
  function applyComponentResync(entity: string, type: string, component: unknown): void {
    if (component === null || typeof component !== 'object') return;
    for (const [key, leaf] of Object.entries(component as Record<string, unknown>)) {
      applyPatch(entity, `${type}.${key}`, leaf);
    }
  }

  /**
   * Resync a revertPrefabOverride scope onto the running preview from the
   * refreshed authored scene. `property` encodes the scope the revert touched:
   * '' = the whole entity (every component), a bare component name = that whole
   * component, a dotted path = a single field. Patches leaf-by-leaf (never
   * replacing a component object) so aliases like RuntimeEntity.transform
   * survive, and stays scoped so components the revert didn't touch keep their
   * live runtime state.
   */
  function applyResync(entity: string, components: Record<string, unknown> | undefined, property: string): void {
    if (property === '') {
      for (const [type, value] of Object.entries(components ?? {})) applyComponentResync(entity, type, value);
      return;
    }
    if (!property.includes('.')) {
      applyComponentResync(entity, property, components?.[property]);
      return;
    }
    const value = readComponentPath(components, property);
    if (value !== undefined) applyPatch(entity, property, value);
  }

  /** Live-swap a state-machine asset's parsed doc on the running preview (Task 11 asm-reload). */
  async function applyAsmReload(assetId: string): Promise<void> {
    const view = getGameView();
    if (!view?.reloadStateMachineAsset) return;
    try {
      const n = await view.reloadStateMachineAsset(assetId);
      if (n > 0) {
        get().log('info', 'runtime', `State machine updated (${n} ${n === 1 ? 'entity' : 'entities'} reset)`);
      }
    } catch (err) {
      get().log('error', 'runtime', `State machine live-update failed: ${(err as Error).message}`);
    }
  }

  /** Accumulate a valueless patch under its entity so a multi-key resolve costs one query. */
  function groupValueless(
    groups: Map<string, { scene: string; entity: string; properties: string[] }>,
    scene: string,
    entity: string,
    property: string,
  ): void {
    const key = `${scene}\x00${entity}`;
    const group = groups.get(key) ?? { scene, entity, properties: [] };
    group.properties.push(property);
    groups.set(key, group);
  }

  /**
   * Resolve grouped valueless patches against the freshly-refreshed authored
   * scene (one read-only query per entity), then patch the live preview. A ''
   * property means "resync the whole entity" (see applyEntityResync).
   */
  async function resolveValuelessGroups(
    groups: Map<string, { scene: string; entity: string; properties: string[] }>,
  ): Promise<void> {
    for (const group of groups.values()) {
      const ent = await query<{ components?: Record<string, unknown> }>('inspectEntity', {
        scene: group.scene,
        entity: group.entity,
      });
      if (!ent) continue;
      for (const property of group.properties) applyResync(group.entity, ent.components, property);
    }
  }

  /** Run the live actions for a just-succeeded LOCAL exec (only while playing). */
  async function applyLocalActions(command: string, params: Record<string, unknown>, data: unknown): Promise<void> {
    const localSource = command === 'editScript' ? (data as { source?: unknown } | null)?.source : undefined;
    // Local commands always target the current scene, so no scene guard is
    // needed; valueless patches (setTileAutotile, revertPrefabOverride carry no
    // value in params) resolve against the just-refreshed authored scene, same
    // as the external path.
    const resolveGroups = new Map<string, { scene: string; entity: string; properties: string[] }>();
    for (const action of classifyLocal(command, params, data)) {
      if (action.kind === 'patch') {
        if (action.hasValue) applyPatch(action.entity, action.property, action.value);
        else groupValueless(resolveGroups, action.scene, action.entity, action.property);
      } else if (action.kind === 'reload') {
        await applyReload(action.path, typeof localSource === 'string' ? localSource : undefined);
      } else if (action.kind === 'asm-reload') {
        await applyAsmReload(action.assetId);
      } else if (action.kind === 'structural') set({ pendingRestart: true });
    }
    await resolveValuelessGroups(resolveGroups);
  }

  /**
   * Whether an external patch targeting `scene` refers to the scene the
   * preview is running. The running scene is the store's current `sceneId`:
   * GamePreview mounts that scene and remounts whenever it changes, so from
   * the editor's side they can never diverge. The runtime CAN scene-switch
   * internally mid-run (ctx.scenes.load) without the store tracking it —
   * accepted: a patch skipped for the wrong reason is honest (same latitude
   * as an entity-id miss), whereas applying a cross-scene patch is silently
   * wrong — patchComponent resolves entity refs by id OR name, so a
   * same-named entity in the running scene would take the other scene's
   * value. Journal details carry the scene as the external tool passed it —
   * an id or a human name (the CLI takes names) — so match either.
   */
  function isRunningScene(scene: string): boolean {
    const { sceneId, scene: sceneData, info } = get();
    if (!sceneId) return false;
    if (scene === sceneId) return true;
    const runningName =
      sceneData?.id === sceneId ? sceneData.name : info?.scenes.find((s) => s.id === sceneId)?.name;
    return runningName !== undefined && scene === runningName;
  }

  /** Run the live actions for an EXTERNAL journal entry (refresh already ran; only while playing). */
  async function applyJournalActions(entry: JournalEntry): Promise<void> {
    // Valueless patches are grouped per entity before resolving, so a
    // multi-key setProperties costs ONE inspectEntity query, not one per key.
    const resolveGroups = new Map<string, { scene: string; entity: string; properties: string[] }>();
    for (const action of classifyJournal(entry)) {
      if (action.kind === 'reload') await applyReload(action.path, undefined);
      else if (action.kind === 'asm-reload') await applyAsmReload(action.assetId);
      else if (action.kind === 'structural') set({ pendingRestart: true });
      else if (action.kind === 'patch' && !action.hasValue) {
        if (!isRunningScene(action.scene)) continue;
        const key = `${action.scene}\u0000${action.entity}`;
        const group = resolveGroups.get(key) ?? { scene: action.scene, entity: action.entity, properties: [] };
        group.properties.push(action.property);
        resolveGroups.set(key, group);
      }
    }
    for (const group of resolveGroups.values()) {
      // No value in the journal detail: resolve the current values from the
      // freshly-refreshed authored scene via one read-only query, then patch.
      const ent = await query<{ components?: Record<string, unknown> }>('inspectEntity', {
        scene: group.scene,
        entity: group.entity,
      });
      if (!ent) continue;
      for (const property of group.properties) applyResync(group.entity, ent.components, property);
    }
  }

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
    // Same reasoning for the export job display: its frames arrived on the
    // old socket, and a prior project's builds must not surface here.
    resetExportJob();
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
        const external = frame.entries.filter((entry) => entry.source !== 'editor');
        if (external.length > 0) {
          set((state) => ({ commandSeq: state.commandSeq + 1 }));
          void (async () => {
            await get().refresh();
            // Mirror external changes into the running preview. The action
            // no-ops per entry unless `playing` (so a Stop landing mid-batch
            // halts the mirroring) — a fresh Play picks up the
            // already-refreshed authored scene instead.
            for (const entry of external) await get().applyExternalJournalEntry(entry);
            // Keep "Restore checkpoint" (bound to diff?.hasChanges) honest as
            // soon as the Timeline shows the new row, not only after a manual
            // refreshDiff() — an external `hearth create entity` etc. must not
            // leave the button stale (AGENT-2 / L-090).
            await refreshDiffIfTracking();
          })();
        }
        return;
      }
      if (frame.type === 'pty-data' || frame.type === 'pty-exit' || frame.type === 'pty-error') {
        ingestPtyFrame(frame);
        return;
      }
      if (frame.type === 'export-progress' || frame.type === 'export-done' || frame.type === 'export-error') {
        // Desktop export job progress (POST /api/export/desktop), broadcast to
        // every socket for this project root; the Export dialog subscribes via
        // useExportJob(). Fed here (not in the dialog) so a running job keeps
        // advancing even while the dialog is closed.
        ingestExportFrame(frame);
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
    resetExportJob();
  }

  /**
   * Refresh the Changes-panel diff after an undo/redo, but only when a
   * baseline is actually being tracked — a checkpoint was taken this session
   * (`snapshotTaken`) or a diff is currently displayed (`diff`). Without the
   * guard, undo/redo with no checkpoint would call diffProject, hit NOT_FOUND,
   * and log a "Review changes: no checkpoint …" info line on every keypress.
   * With a baseline, this keeps the diff body honest immediately after Undo/
   * Redo instead of after a manual Refresh or a tab blur/refocus
   * (CONSOLE-CHANGES-6 / L-060).
   */
  async function refreshDiffIfTracking(): Promise<void> {
    if (get().snapshotTaken || get().diff !== null) await get().refreshDiff();
  }

  async function afterOpen(path: string, info: ProjectInfo): Promise<void> {
    // A pending nudge burst belongs to whatever project/scene was open before
    // this call (openProject reopening the same path, or switching to a
    // different one) — its scene/entity ids are meaningless in the freshly
    // loaded project, so drop it rather than flush a moveEntity against a
    // scene that may no longer exist.
    nudgeQueue.clear();
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
      pendingRestart: false,
      runtimeErrors: [],
      paused: false,
      pausedByTab: false,
      debugDraw: false,
      snapshotTaken: false,
      sceneViewCenter: null,
      hasUnsavedScripts: false,
      // A pending "open this script" request belongs to the project being left;
      // clearing it stops a stale request from re-opening the prior project's
      // script in the freshly-opened one when the Code panel remounts (L-058).
      codeOpenRequest: null,
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
    pendingRestart: false,
    runtimeErrors: [],
    paused: false,
    pausedByTab: false,
    runNonce: 0,
    debugDraw: false,

    agentStatus: 'idle',
    agentMode: 'safe-edit',
    agentDetect: null,
    agentDetecting: false,
    snapshotTaken: false,
    diffFocusRequest: 0,
    sceneViewCenter: null,
    shortcutSheetOpen: false,
    focusSelectionRequest: 0,
    deleteSelectionRequest: 0,
    codeOpenRequest: null,
    codeSearchRequest: 0,
    animatorTarget: null,
    hasUnsavedScripts: false,
    closeProjectRequest: 0,

    setAgentMode(mode) {
      set({ agentMode: mode });
    },

    requestDiffFocus() {
      set((state) => ({ diffFocusRequest: state.diffFocusRequest + 1 }));
    },

    setSceneViewCenter(center) {
      set({ sceneViewCenter: center });
    },

    setShortcutSheet(open) {
      set({ shortcutSheetOpen: open });
    },

    toggleShortcutSheet() {
      set((state) => ({ shortcutSheetOpen: !state.shortcutSheetOpen }));
    },

    requestFocusSelection() {
      if (!get().selection) return;
      set((state) => ({ focusSelectionRequest: state.focusSelectionRequest + 1 }));
    },

    requestDeleteSelection() {
      if (!get().selection) return;
      set((state) => ({ deleteSelectionRequest: state.deleteSelectionRequest + 1 }));
    },

    openScriptAt(path, line) {
      set((state) => ({ codeOpenRequest: { path, line, nonce: (state.codeOpenRequest?.nonce ?? 0) + 1 } }));
    },

    requestCodeSearch() {
      set((state) => ({ codeSearchRequest: state.codeSearchRequest + 1 }));
    },

    openAnimatorFor(assetId) {
      set((state) => ({ animatorTarget: { assetId, nonce: (state.animatorTarget?.nonce ?? 0) + 1 } }));
    },

    togglePlay() {
      get().setPlaying(!get().playing);
    },

    async checkpoint() {
      const result = await get().exec<{ scenes: number }>('snapshotProject', {}, { quiet: true });
      if (result.success) {
        get().log('info', 'command', 'Checkpoint saved. The Changes panel now compares against this checkpoint.');
        // Refresh the Changes panel against the just-taken checkpoint so a
        // focused Changes tab reflects the new baseline immediately, not only
        // after a manual Refresh or a tab blur/refocus (CONSOLE-CHANGES-5 /
        // L-060). A snapshot always establishes a baseline, so this never
        // hits the "no checkpoint" info-log path.
        await get().refreshDiff();
      }
    },

    // quiet: the friendly log lines below replace exec()'s generic
    // changed-summary; shared by the toolbar arrows, the Edit menu, and the
    // ⌘Z/⇧⌘Z keybinds so every trigger reads the same (TOOLBAR-6).
    async undo() {
      const result = await get().exec<{ undone: string; seq: number }>('undo', {}, { quiet: true });
      if (result.success && result.data) {
        get().log('info', 'command', `Undo: reverted "${result.data.undone}" (#${result.data.seq}).`);
        await refreshDiffIfTracking();
      }
    },

    async redo() {
      const result = await get().exec<{ redone: string; seq: number }>('redo', {}, { quiet: true });
      if (result.success && result.data) {
        get().log('info', 'command', `Redo: reapplied "${result.data.redone}" (#${result.data.seq}).`);
        await refreshDiffIfTracking();
      }
    },

    async duplicateSelection() {
      const { selection, sceneId } = get();
      if (!selection || !sceneId) return;
      const result = await get().exec<{ entityId: string }>('duplicateEntity', { scene: sceneId, entity: selection });
      // Select the fresh copy so a follow-up nudge/duplicate acts on it.
      if (result.success && result.data) get().select(result.data.entityId);
    },

    async deleteSelection() {
      const { selection, sceneId } = get();
      if (!selection || !sceneId) return;
      await get().exec('deleteEntity', { scene: sceneId, entity: selection });
    },

    nudgeSelection(dx, dy) {
      const { selection, sceneId, scene } = get();
      if (!selection || !sceneId || !scene) return;
      const entity = scene.entities.find((e) => e.id === selection);
      if (!entity) return;
      const transform = entity.components.Transform as { position?: Vec2 } | undefined;
      const pos = transform?.position;
      const next = nudgeQueue.nudge({
        scene: sceneId,
        entity: selection,
        base: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
        dx,
        dy,
      });
      // Optimistic: move it now for instant feedback; the debounced exec
      // (nudgeQueue's flush callback) persists it and refresh() reconciles
      // against the source of truth.
      set((state) => ({ scene: state.scene ? withEntityPosition(state.scene, selection, next) : state.scene }));
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
      if (loadMetaPromise) return loadMetaPromise;
      loadMetaPromise = (async () => {
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
      })();
      try {
        await loadMetaPromise;
      } finally {
        loadMetaPromise = null;
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

    async createProject(dir, name, description, template) {
      const res = await apiCreateProject(dir, name, description, template);
      if (!res.ok || !res.path || !res.info) {
        return { ok: false, error: res.error ?? 'Failed to create project' };
      }
      await afterOpen(res.path, res.info);
      return { ok: true };
    },

    setUnsavedScripts(has) {
      if (get().hasUnsavedScripts !== has) set({ hasUnsavedScripts: has });
    },

    requestCloseProject() {
      if (get().hasUnsavedScripts) {
        set((state) => ({ closeProjectRequest: state.closeProjectRequest + 1 }));
      } else {
        get().closeProject();
      }
    },

    closeProject() {
      // Drop any pending nudge burst without flushing: the project (and its
      // API base) is going away, so a moveEntity fired ~300ms from now would
      // either hit a closed project or silently no-op — neither is right.
      nudgeQueue.clear();
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
        pendingRestart: false,
        runtimeErrors: [],
        paused: false,
        pausedByTab: false,
        debugDraw: false,
        snapshotTaken: false,
        sceneViewCenter: null,
        hasUnsavedScripts: false,
        codeOpenRequest: null,
      });
    },

    async selectScene(sceneId) {
      // A pending nudge burst targets the scene being left; land it now
      // (synchronously, not waiting out the debounce) so the move isn't lost
      // and doesn't fire later against whatever scene is current by then.
      nudgeQueue.flush();
      // A center measured against the previous scene's viewport doesn't apply
      // here; SceneView re-measures and pushes a fresh one once mounted.
      set({ sceneId, selection: null, playing: false, pendingRestart: false, runtimeErrors: [], paused: false, pausedByTab: false, debugDraw: false, sceneViewCenter: null });
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
      // Either direction also clears a lingering debug pause: a fresh Play
      // should never come up paused, and Stop has nothing left to pause.
      set((state) => ({
        playing,
        paused: false,
        pausedByTab: false,
        // Either direction clears a pending restart: Play/Stop both remount or
        // tear down the preview, so a queued "restart to apply" is moot. The
        // fresh run also starts with a clean runtime-error list.
        pendingRestart: false,
        runtimeErrors: [],
        runNonce: playing ? state.runNonce + 1 : state.runNonce,
        debugDraw: playing ? false : state.debugDraw,
      }));
    },

    restartPlay() {
      // The restart badge's action: replay the current scene from scratch
      // (same remount path as a fresh Play) and clear the badge.
      set((state) => ({
        playing: true,
        paused: false,
        pausedByTab: false,
        pendingRestart: false,
        runtimeErrors: [],
        runNonce: state.runNonce + 1,
        debugDraw: false,
      }));
    },

    recordRuntimeError(error) {
      set((state) => ({ runtimeErrors: [...state.runtimeErrors.slice(-MAX_RUNTIME_ERRORS + 1), error] }));
      // A hot-reload compile failure is already surfaced as a single
      // "Hot-reload failed: …" line by applyReload (which logs the {ok:false}
      // result of view.reloadScript). The runtime ALSO bridges that same error
      // here — reloadScript calls recordError(phase:'reload') internally, which
      // reaches onErrorEntry → recordRuntimeError — so logging it again would
      // double every hot-reload error in the Console (CONSOLE-CHANGES-4 /
      // L-062). Keep recording it into runtimeErrors, but skip the duplicate
      // Console line for the reload phase; applyReload owns that line.
      if (error.phase === 'reload') return;
      // Recover the failing line from the message when the runtime didn't
      // populate error.line (load-time compile failures — L-061) so the
      // Console link jumps to the exact line like the reload path does.
      const line = error.line ?? (error.script ? lineFromMessage(error.script, error.message) : null);
      const resolved = error.line == null && line != null ? { ...error, line } : error;
      const link = error.script ? { path: error.script, line } : undefined;
      get().log('error', 'runtime', formatRuntimeError(resolved), link);
    },

    async applyExternalJournalEntry(entry) {
      // Per-entry (not per-batch) playing check: a Stop that lands while a
      // batch of external entries is being mirrored stops the rest too.
      if (!get().playing) return;
      await applyJournalActions(entry);
    },

    setPaused(paused) {
      // An explicit toolbar Pause/Resume makes the user the owner of the pause
      // state: clear pausedByTab so a later Game-tab hide/show won't auto-resume
      // (or re-pause) against their intent.
      set({ paused, pausedByTab: false });
    },

    setGameTabVisible(visible) {
      const state = get();
      // Only a live run has anything to pause/resume; ignore visibility churn
      // (StrictMode remounts, layout restores) while stopped.
      if (!state.playing) return;
      if (!visible) {
        // Hiding the Game tab pauses a running preview so switching to Code to
        // edit/hot-reload no longer stops the run (L-067). If the user already
        // paused explicitly, leave it alone — pausedByTab stays false so we
        // won't auto-resume it on return.
        if (!state.paused) set({ paused: true, pausedByTab: true });
      } else {
        // Back on the Game tab: auto-resume only the pause WE introduced on
        // hide; an explicit user pause (pausedByTab === false) is preserved.
        if (state.pausedByTab) set({ paused: false, pausedByTab: false });
      }
    },

    setDebugDraw(on) {
      set({ debugDraw: on });
    },

    log(level, source, message, link) {
      set((state) => ({
        consoleEntries: [...state.consoleEntries.slice(-MAX_CONSOLE + 1), makeEntry(level, source, message, link)],
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
          get().log(err.code === 'NOT_FOUND' ? 'info' : 'error', 'command', `${commandLabel('diffProject')}: ${err.message}`);
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
        get().log(emptyHistory ? 'info' : 'error', 'command', `${commandLabel(name)}: ${err.message}`);
      }
      for (const warning of result.warnings) {
        get().log('warn', 'command', `${commandLabel(name)}: ${warning.message}`);
      }
      if (result.success && !opts.quiet && result.changed.length > 0) {
        const summary = result.changed
          .map((c) => `${c.action} ${c.kind}${c.name ? ` "${c.name}"` : ''}`)
          .slice(0, 3)
          .join(', ');
        get().log('info', 'command', `${commandLabel(name)}: ${summary}${result.changed.length > 3 ? ', …' : ''}`);
      }
      if (result.success && (result.changed.length > 0 || result.files.length > 0)) {
        set((state) => ({ commandSeq: state.commandSeq + 1 }));
        await get().refresh();
        // Mirror the change into the running preview (live patch / hot-reload /
        // restart badge). Only while playing; params carry every value locally,
        // so live-patching works fully regardless of what the journal records.
        if (get().playing) {
          await applyLocalActions(name, (params ?? {}) as Record<string, unknown>, result.data);
        }
      }
      // Centralized here (rather than in each caller) so any surface that
      // triggers a snapshot — DiffPanel's button or the Agent panel's
      // Timeline — flips the same session-scoped "have I snapshotted" flag.
      if (result.success && name === 'snapshotProject') {
        set({ snapshotTaken: true });
      }
      return result as CommandResult<never>;
    },

    query,
  };
});
