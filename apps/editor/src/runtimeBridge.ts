/**
 * The ONLY file that touches @hearth/runtime. The runtime package is built in
 * parallel with this editor, so:
 *   - the import is dynamic and only ever requested after /api/meta reports
 *     runtimeAvailable=true (otherwise Vite would fail to resolve the alias),
 *   - types are local structural interfaces + a @ts-ignore on the import, so
 *     `npm run typecheck` passes whether or not the runtime exists yet.
 *
 * The browser-side ProjectStore reads project files through HttpFs, a
 * read-only FsLike over the dev server's /api/fs + /api/file routes.
 */
import { ProjectStore, type FsLike } from '@hearth/core';
import { fileUrl } from './api';
// Vite emits wasmoon's Lua VM wasm as a static asset and hands back its URL;
// the runtime's Lua engine is pointed at it once, lazily, in mountGameView.
import luaWasmUrl from 'wasmoon/dist/glue.wasm?url';

export interface RuntimeLogEvent {
  level?: 'info' | 'warn' | 'error';
  message?: string;
  frame?: number;
}

/** A live runtime entity, as surfaced by RuntimeHandle.getEntities()/find(). */
export interface RuntimeEntityHandle {
  id: string;
  name: string;
  tags: string[];
  enabled: boolean;
  parentId: string | null;
  transform: { position: { x: number; y: number } };
  /** Loosely typed component bag; the Live panel only reaches into PhysicsBody.velocity by name. */
  components: { PhysicsBody?: { velocity: { x: number; y: number } } } & Record<string, unknown>;
}

/** One recorded runtime error (SceneRuntime.errors / RuntimeError). */
export interface RuntimeErrorEntry {
  frame: number;
  message: string;
  entity?: string;
  script?: string;
  phase?: string;
  /** 1-based source line when extractable; null otherwise. */
  line?: number | null;
}

/** Result of a hot-reload (SceneRuntime.reloadScript). */
export type ReloadScriptResult =
  | { ok: true; entities: number }
  | { ok: false; message: string; line: number | null };

/** One recorded ctx.events.emit call (SceneRuntime.events). */
export interface RuntimeEventRecord {
  frame: number;
  name: string;
  data?: unknown;
}

/** Read-only snapshot of one entity's pending timers and active tweens (SceneRuntime.getSchedulerSnapshot). */
export interface RuntimeSchedulerSnapshot {
  timers: ReadonlyArray<{ id: string; remaining: number; interval: number; repeat: boolean }>;
  tweens: ReadonlyArray<{ id: string; key: string; elapsed: number; duration: number; from: number; to: number }>;
}

/**
 * Narrow, hand-rolled structural view over @hearth/runtime's SceneRuntime —
 * only the read-only surface the Live inspector panel needs. Mirrors
 * RuntimeLogEvent's approach: no import from @hearth/runtime (the package
 * may not be built yet), so this stays typecheck-safe either way.
 */
export interface RuntimeHandle {
  readonly frame: number;
  getEntities(): RuntimeEntityHandle[];
  find(idOrName: string): RuntimeEntityHandle | undefined;
  getWorldPosition(entity: RuntimeEntityHandle): { x: number; y: number };
  readonly events: ReadonlyArray<RuntimeEventRecord>;
  readonly eventCounts: Map<string, number>;
  getSchedulerSnapshot(entityId: string): RuntimeSchedulerSnapshot | null;
}

export interface MountedGameView {
  play(): void;
  pause(): void;
  destroy(): void;
  /** Toggle the collider/velocity/light debug overlay (PixiSceneView.setDebugDraw). */
  setDebugDraw?(on: boolean): void;
  /** Advance exactly one fixed frame and render it (PixiSceneView.stepFrame, play-mode pause/step). */
  stepFrame?(): Promise<void>;
  /** Hot-reload a script against the current scene, preserving vars/timers/tweens (PixiSceneView.reloadScript). */
  reloadScript?(path: string, source: string): Promise<ReloadScriptResult>;
  /** Live-patch a component property on the current scene (PixiSceneView.patchComponent). */
  patchComponent?(
    entityRef: string,
    componentType: string,
    propertyPath: string,
    value: unknown,
  ): boolean;
  /**
   * Live-swap a state-machine asset's parsed doc, resetting only entities bound
   * to it (PixiSceneView.reloadStateMachineAsset). Re-reads the
   * asset fresh from the project fs; resolves to the number of entities reset
   * (0 when the asset is unknown or the runtime has no machine on it).
   */
  reloadStateMachineAsset?(assetId: string): Promise<number>;
  runtime?: RuntimeHandle & { errors?: unknown[] };
}

export interface MountGameOptions {
  container: HTMLElement;
  projectPath: string;
  sceneId: string;
  autoplay: boolean;
  onLog?: (event: RuntimeLogEvent | string) => void;
  onError?: (event: RuntimeLogEvent | string | Error) => void;
  /**
   * Structured runtime-error callback (the full RuntimeError, incl. `line`).
   * Fires alongside `onError`; use this when you need the phase/script/line,
   * e.g. to surface a script-panel diagnostic. `onError` stays string-friendly
   * for back-compat.
   */
  onErrorEntry?: (event: RuntimeErrorEntry) => void;
  /** Fired after a script-requested scene switch completes (scene NAME). */
  onSceneChange?: (sceneName: string) => void;
}

/**
 * Point the runtime's Lua engine (wasmoon) at the Vite-served glue.wasm.
 * Must happen before the first .lua script compiles; done lazily here so the
 * editor still boots while @hearth/runtime is being built in parallel.
 */
let luaWasmConfigured = false;
async function configureLuaWasm(): Promise<void> {
  if (luaWasmConfigured) return;
  try {
    const lua = await import('@hearth/runtime/lua');
    lua.setLuaWasmUri(luaWasmUrl);
    luaWasmConfigured = true;
  } catch {
    // Runtime not built yet — JS-only previews still work; a .lua project
    // will surface a script error from the runtime instead.
  }
}

/** Read-only FsLike over the project server. Paths are project-relative. */
export class HttpFs implements FsLike {
  constructor(private readonly project: string) {}

  private async op(op: string, p: string): Promise<any> {
    const url = `/api/fs?project=${encodeURIComponent(this.project)}&op=${op}&path=${encodeURIComponent(p)}`;
    const res = await fetch(url);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error ?? `fs ${op} failed: ${p}`);
    return body;
  }

  async readFile(path: string): Promise<string> {
    return (await this.op('read', path)).content as string;
  }

  async readFileBinary(path: string): Promise<Uint8Array> {
    const res = await fetch(fileUrl(this.project, path));
    if (!res.ok) throw new Error(`ENOENT: ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async exists(path: string): Promise<boolean> {
    return (await this.op('exists', path)).exists as boolean;
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.op('readdir', path)).entries as string[];
  }

  async stat(path: string): Promise<{ isDirectory: boolean; size: number; mtimeMs: number }> {
    return (await this.op('stat', path)).stat;
  }

  async writeFile(): Promise<void> {
    throw new Error('HttpFs is read-only (preview runs against the saved project)');
  }
  async appendFile(): Promise<void> {
    throw new Error('HttpFs is read-only (preview runs against the saved project)');
  }
  async mkdir(): Promise<void> {
    throw new Error('HttpFs is read-only');
  }
  async remove(): Promise<void> {
    throw new Error('HttpFs is read-only');
  }
  async copyFile(): Promise<void> {
    throw new Error('HttpFs is read-only');
  }
}

export async function mountGameView(options: MountGameOptions): Promise<MountedGameView> {
  // @ts-ignore -- @hearth/runtime is developed in parallel; the alias target
  // may not exist yet. This module is only imported after the server confirms
  // the runtime package is present.
  const mod: any = await import('@hearth/runtime/pixi');
  if (!mod?.PixiSceneView?.mount) {
    throw new Error('@hearth/runtime/pixi does not export PixiSceneView.mount');
  }
  await configureLuaWasm();

  const fs = new HttpFs(options.projectPath);
  const store = await ProjectStore.load(fs, '.');

  const view = await mod.PixiSceneView.mount({
    container: options.container,
    store,
    scene: options.sceneId,
    resolveAssetUrl: (asset: { path: string }) => fileUrl(options.projectPath, asset.path),
    autoplay: options.autoplay,
    onLog: options.onLog,
    // The runtime hands onError a structured RuntimeError; forward it to both
    // the (back-compat, string-friendly) onError and the structured
    // onErrorEntry so callers can pick either shape.
    onError: (e: RuntimeErrorEntry) => {
      options.onError?.(e);
      options.onErrorEntry?.(e);
    },
    onSceneChange: (e: { frame: number; from: string | null; to: string }) => {
      const name = store.getScene(e.to)?.name ?? e.to;
      options.onSceneChange?.(name);
    },
  });
  return view as MountedGameView;
}
