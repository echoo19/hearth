/**
 * Script module resolution, memoization, and the dependency graph hot-reload
 * consumes.
 *
 * Script paths are always posix, project-relative ('scripts/lib/noise.lua'),
 * so path handling here is plain string work: this file reaches the browser
 * player bundle, and packages/runtime carries no `node:` imports by design.
 */

type CompileScriptModule = (path: string) => unknown;

/** Collapse '.'/'..' segments. Posix-only; see the file header. */
function normalizePath(input: string): string {
  const out: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0 || out[out.length - 1] === '..') out.push('..');
      else out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

export class ScriptModuleRegistry {
  private readonly exports = new Map<string, unknown>();
  private readonly compiling = new Set<string>();
  private readonly compileStack: string[] = [];
  private readonly dependents = new Map<string, Set<string>>();

  constructor(private readonly sources: Map<string, string>) {}

  resolve(spec: string, fromPath: string): string {
    const fromExt = extensionOf(fromPath);
    const specExt = extensionOf(spec);
    const resolved = normalizePath(`scripts/${specExt ? spec : `${spec}${fromExt}`}`);

    if (!resolved.startsWith('scripts/')) {
      throw new Error(`require resolved outside scripts root: ${resolved}`);
    }

    const resolvedExt = extensionOf(resolved);
    if (resolvedExt !== fromExt) {
      throw new Error(`require must stay in the same language (${fromExt}): ${resolved}`);
    }

    if (!this.sources.has(resolved)) {
      throw new Error(`module not found: ${resolved}`);
    }

    return resolved;
  }

  /**
   * Record that `fromPath` depends on (requires) `path` without loading
   * anything. The Lua engine resolves requires INSIDE the VM and never calls
   * load(), so the runtime's resolveModule callback records Lua edges here —
   * without this seam the dependents graph stays empty for Lua and hot
   * reload never recompiles Lua dependents.
   */
  recordEdge(path: string, fromPath: string): void {
    let directDependents = this.dependents.get(path);
    if (!directDependents) {
      directDependents = new Set();
      this.dependents.set(path, directDependents);
    }
    directDependents.add(fromPath);
  }

  load(path: string, compile: CompileScriptModule, fromPath?: string): unknown {
    if (fromPath) {
      this.recordEdge(path, fromPath);
    }

    if (this.exports.has(path)) {
      return this.exports.get(path);
    }

    if (this.compiling.has(path)) {
      const cycleStart = this.compileStack.indexOf(path);
      const cyclePath = [...this.compileStack.slice(cycleStart), path].join(' -> ');
      throw new Error(`require cycle: ${cyclePath}`);
    }

    if (!this.sources.has(path)) {
      throw new Error(`module not found: ${path}`);
    }

    this.compiling.add(path);
    this.compileStack.push(path);
    try {
      const moduleExports = compile(path);
      this.exports.set(path, moduleExports);
      return moduleExports;
    } finally {
      this.compileStack.pop();
      this.compiling.delete(path);
    }
  }

  dependentsOf(path: string): Set<string> {
    return new Set(this.dependents.get(path) ?? []);
  }

  transitiveDependentsOf(path: string): Set<string> {
    const result = new Set<string>();
    const pending = [...this.dependentsOf(path)];

    while (pending.length > 0) {
      const dependent = pending.pop();
      if (!dependent || result.has(dependent)) continue;

      result.add(dependent);
      pending.push(...this.dependentsOf(dependent));
    }

    return result;
  }

  invalidate(paths: Iterable<string>): void {
    for (const path of paths) {
      this.exports.delete(path);
    }
  }

  /**
   * Drop every OUTGOING edge of the given paths (i.e. remove them from every
   * dependents set). Hot reload calls this before absorbing the freshly
   * recorded edges of a recompiled module, so a require REMOVED by an edit
   * drops its edge instead of accumulating stale graph entries forever.
   */
  clearEdgesFrom(fromPaths: Iterable<string>): void {
    const from = new Set(fromPaths);
    for (const [path, directDependents] of this.dependents) {
      for (const dependent of from) directDependents.delete(dependent);
      if (directDependents.size === 0) this.dependents.delete(path);
    }
  }

  /**
   * A throwaway registry for hot-reload staging: it shares this registry's
   * memoized module values EXCEPT for `invalidated` paths (so an unaffected
   * library keeps its single live instance instead of re-running its body),
   * resolves over the given sources snapshot, and starts with an empty edge
   * graph (staging compiles record the fresh edges). Loading through the
   * staged registry never mutates this one.
   */
  stageFor(sources: Map<string, string>, invalidated: Iterable<string>): ScriptModuleRegistry {
    const staging = new ScriptModuleRegistry(sources);
    for (const [path, value] of this.exports) {
      staging.exports.set(path, value);
    }
    for (const path of invalidated) {
      staging.exports.delete(path);
    }
    return staging;
  }

  /** Merge every edge recorded in `other` into this registry (reload commit). */
  absorbEdges(other: ScriptModuleRegistry): void {
    for (const [path, directDependents] of other.dependents) {
      for (const dependent of directDependents) {
        this.recordEdge(path, dependent);
      }
    }
  }

  /** Replace a path's memoized module value (hot-reload commit). */
  setExport(path: string, value: unknown): void {
    this.exports.set(path, value);
  }
}

function extensionOf(scriptPath: string): string {
  const basename = scriptPath.slice(scriptPath.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  return dot === -1 ? '' : basename.slice(dot);
}
