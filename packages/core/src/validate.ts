/**
 * Project validation: referential integrity and common mistakes, beyond the
 * per-file schema validation that happens at load time.
 */
import { z } from 'zod';
import luaparse from 'luaparse';
import { readJson, type ProjectStore } from './project/store.js';
import { joinPath } from './fs.js';
import { AnimationDataSchema, PrefabDataSchema, SCRIPTS_DIR, type PrefabData } from './schema/project.js';
import { findSheetFrame } from './assets/sheetFrames.js';
import { validatePrefabLocalIds } from './project/prefabData.js';
import { COMPONENT_SCHEMAS, isComponentType } from './schema/components.js';
import { unwrap } from './schema/paths.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  scene?: string;
  entity?: string;
  asset?: string;
  script?: string;
  /** 1-based source line, for script syntax errors (when extractable). */
  line?: number;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Check a polygon Collider's local-space points. Hearth v0.2 supports convex
 * polygons only: at least 3 points, no duplicate consecutive points, and a
 * consistent cross-product sign around the ring (either winding).
 */
function validatePolygonPoints(points: { x: number; y: number }[]): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  const n = points.length;
  if (n < 3) {
    issues.push({
      code: 'POLYGON_TOO_FEW_POINTS',
      message: `polygon Collider has ${n} point(s); a polygon needs at least 3`,
    });
    return issues;
  }
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a.x === b.x && a.y === b.y) {
      issues.push({
        code: 'POLYGON_DUPLICATE_POINT',
        message: `polygon Collider has duplicate consecutive points at index ${i} and ${(i + 1) % n} (${a.x}, ${a.y}); remove the duplicate`,
      });
      return issues; // duplicates make the convexity check meaningless
    }
  }
  let positive = false;
  let negative = false;
  for (let i = 0; i < n; i++) {
    const o = points[i];
    const a = points[(i + 1) % n];
    const b = points[(i + 2) % n];
    const cross = (a.x - o.x) * (b.y - a.y) - (a.y - o.y) * (b.x - a.x);
    if (cross > 0) positive = true;
    else if (cross < 0) negative = true;
  }
  if (positive && negative) {
    issues.push({
      code: 'POLYGON_NOT_CONVEX',
      message:
        'polygon Collider is not convex. Hearth supports convex polygons only. ' +
        'Split concave shapes into multiple entities, each with its own convex polygon Collider',
    });
  }
  return issues;
}

/**
 * Best-effort line extraction for a `new Function(...)` SyntaxError. V8
 * reports the failing position in the error stack as `<anonymous>:LINE:COL`,
 * where LINE counts from the synthesized `function anonymous(...) {` header —
 * two lines above the script body.
 *
 * In practice this never matches (M-1, waveG final review): verified live
 * against Node 22 that a `new Function(...)` compile-time SyntaxError's
 * `.stack` contains no `<anonymous>:LINE:COL` frame at all — only
 * `at new Function (<anonymous>)` — so every JS syntax error's diagnostic
 * carries `line: null`. `checkScript.test.ts` pins this as the documented
 * current behavior rather than asserting it conditionally.
 *
 * `node:vm`'s `Script` constructor *does* report a usable line (it compiles
 * without the synthetic function-wrapper header), and was tried here as a
 * secondary compile purely for line recovery — but `packages/core`'s
 * `validate.ts` is pulled into the editor's browser bundle via the
 * `@hearth/core` barrel (confirmed live: `npm run build:editor` fails with
 * `"Script" is not exported by "__vite-browser-external"` the moment a
 * static `node:vm` import is added, even though the editor never calls
 * `checkScriptSource` directly — it only reaches it over HTTP via the
 * `checkScript` command). Making the import conditional/dynamic would
 * require turning this synchronous, publicly-exported function async, a
 * breaking API change out of scope for a line-number nicety. Lua is
 * unaffected (luaparse carries native line info) and is Hearth's default
 * scripting language, so this stays a documented limitation.
 */
function extractJsErrorLine(err: unknown): number | undefined {
  const stack = (err as Error | undefined)?.stack ?? '';
  const match = stack.match(/<anonymous>:(\d+):\d+/);
  if (!match) return undefined;
  const line = parseInt(match[1], 10) - 2;
  return line >= 1 ? line : undefined;
}

export interface ScriptDiagnostic {
  /** 1-based source line, when extractable; null otherwise. */
  line: number | null;
  message: string;
  severity: 'error' | 'warning';
  code?: 'SCRIPT_REQUIRE_NOT_FOUND' | 'SCRIPT_REQUIRE_CYCLE';
}

/**
 * Compile-only syntax check for a single script's source, shared by
 * `validateScriptSyntax` (whole-project validate) and the `checkScript`
 * command (pre-flight a script before saving it, e.g. from the editor's
 * code panel). JS scripts get the same `export default` rewrite the
 * runtime's compileScript performs, then a compile-only `new Function`
 * (never executed). Lua scripts are parsed with luaparse. Returns an empty
 * array when the source is syntactically valid.
 */
export function checkScriptSource(language: 'lua' | 'js', source: string): ScriptDiagnostic[] {
  if (language === 'js') {
    try {
      const body = source.replace(/export\s+default/, 'module.exports =');
      // Compile-only syntax check; the factory is never invoked.
      new Function('module', 'exports', body);
      return [];
    } catch (err) {
      const line = extractJsErrorLine(err);
      return [{ severity: 'error', line: line ?? null, message: (err as Error).message }];
    }
  }
  try {
    luaparse.parse(source, { luaVersion: '5.3' });
    return [];
  } catch (err) {
    const e = err as Error & { line?: number };
    const line = typeof e.line === 'number' ? e.line : null;
    return [{ severity: 'error', line, message: e.message }];
  }
}

function scriptExtension(scriptPath: string): string {
  const filename = scriptPath.slice(scriptPath.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot);
}

/** The scripting language of a path, inferred the same way the runtime does. */
function scriptLanguageOf(scriptPath: string): 'lua' | 'js' {
  return scriptPath.endsWith('.js') ? 'js' : 'lua';
}

/**
 * Scan source text for literal `require('...')` calls that would actually
 * execute — i.e. NOT inside a comment or a string literal. This is a small
 * lexical scanner, deliberately not a parser. What it understands:
 *
 * - Lua: `--` line comments, `--[[ ]]` / `--[==[ ]==]` long-bracket block
 *   comments, `[[ ]]` / `[==[ ]==]` long strings, and single/double-quoted
 *   strings with backslash escapes.
 * - JS: line comments, block comments, single/double-quoted
 *   strings with backslash escapes, and template literals.
 *
 * Known blind spots, each chosen so a mistake here fails SAFE (a require we
 * miss is still caught by the runtime resolver at load; a phantom require we
 * invent would falsely fail `hearth validate` and block export):
 *
 * - A require inside a JS template-literal `${...}` interpolation is treated
 *   as string content and not reported (and a nested template inside `${}`
 *   can end the outer template early).
 * - JS regex literals are not recognized (telling `/` division from a regex
 *   needs a real parser), so a require-shaped pattern inside one would be
 *   reported. Astronomically unlikely in practice.
 * - Dynamic specs (`require(name)`) are invisible, as ever — only quoted
 *   string specs are found.
 * - `foo.require('x')` / `foo:require('x')` are property accesses, not the
 *   global require, and are skipped.
 */
function findLiteralRequires(
  language: 'lua' | 'js',
  source: string,
): Array<{ spec: string; line: number }> {
  const requires: Array<{ spec: string; line: number }> = [];
  const n = source.length;
  const wordChar = /[A-Za-z0-9_$]/;
  let i = 0;
  let line = 1;

  /** Skip a quoted string starting at i (the opening quote). Handles
   * backslash escapes; a raw newline ends a non-template string (it was
   * unterminated — a syntax error — so bail rather than eat the file). */
  const skipQuoted = (quote: string): void => {
    i++;
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        if (source[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (c === '\n') {
        line++;
        i++;
        if (quote !== '`') return;
        continue;
      }
      i++;
      if (c === quote) return;
    }
  };

  /** Lua long-bracket level at position p (`[`, then `=`*level, then `[`),
   * or null when p does not open a long bracket. */
  const luaLongBracketLevel = (p: number): number | null => {
    if (source[p] !== '[') return null;
    let q = p + 1;
    while (source[q] === '=') q++;
    return source[q] === '[' ? q - p - 1 : null;
  };

  /** Skip a Lua long bracket ([[..]], [==[..]==]) with i at its opening `[`. */
  const skipLuaLongBracket = (level: number): void => {
    i += level + 2;
    const close = ']' + '='.repeat(level) + ']';
    while (i < n) {
      if (source[i] === '\n') {
        line++;
        i++;
        continue;
      }
      if (source[i] === ']' && source.startsWith(close, i)) {
        i += close.length;
        return;
      }
      i++;
    }
  };

  while (i < n) {
    const c = source[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }

    if (language === 'lua') {
      if (c === '-' && source[i + 1] === '-') {
        const level = luaLongBracketLevel(i + 2);
        if (level !== null) {
          i += 2;
          skipLuaLongBracket(level);
        } else {
          while (i < n && source[i] !== '\n') i++;
        }
        continue;
      }
      if (c === '[') {
        const level = luaLongBracketLevel(i);
        if (level !== null) {
          skipLuaLongBracket(level);
          continue;
        }
      }
      if (c === '"' || c === "'") {
        skipQuoted(c);
        continue;
      }
    } else {
      if (c === '/' && source[i + 1] === '/') {
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n') line++;
          i++;
        }
        i = Math.min(i + 2, n);
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        skipQuoted(c);
        continue;
      }
    }

    if (c === 'r' && source.startsWith('require', i)) {
      const prev = i > 0 ? source[i - 1] : '';
      const next = source[i + 7] ?? '';
      const bareIdentifier =
        (prev === '' || (!wordChar.test(prev) && prev !== '.' && prev !== ':')) &&
        (next === '' || !wordChar.test(next));
      if (bareIdentifier) {
        // `\s` may span newlines (require(\n'x')); count them below when
        // advancing so line tracking stays exact.
        const call = /^\s*\(\s*(['"])((?:(?!\1)[^\n])*)\1\s*\)/.exec(source.slice(i + 7));
        if (call) {
          requires.push({ spec: call[2], line });
          const end = i + 7 + call[0].length;
          for (let k = i; k < end; k++) {
            if (source[k] === '\n') line++;
          }
          i = end;
          continue;
        }
      }
      i += 7;
      continue;
    }
    i++;
  }
  return requires;
}

function resolveRequireSpec(spec: string, fromPath: string): string {
  const fromExt = scriptExtension(fromPath);
  const specExt = scriptExtension(spec);
  return joinPath(SCRIPTS_DIR, specExt ? spec : `${spec}${fromExt}`);
}

/** True when `resolved`, required from a script at `fromPath`, points at a
 * real, same-language module inside the scripts root. */
function isResolvableRequire(resolved: string, fromPath: string, sources: Map<string, string>): boolean {
  return (
    resolved.startsWith(`${SCRIPTS_DIR}/`) &&
    scriptExtension(resolved) === scriptExtension(fromPath) &&
    sources.has(resolved)
  );
}

/**
 * Static require diagnostics for ONE script: `fromPath`'s own unresolvable
 * requires, and cycles that pass through `fromPath` — each attributed to
 * `fromPath` at the line of the require in THIS file.
 *
 * Attribution rule (same as the runtime's, per the design spec): a problem
 * inside a required module belongs to that module's own path and line, so a
 * broken require in `lib/a.lua` is reported when `lib/a.lua` itself is
 * checked — never against its dependents. `validateProject` checks every
 * script, so nothing is lost project-wide and each fault is reported exactly
 * once, however many scripts depend on the broken file. (Before this rule,
 * one typo in a shared library produced N+1 issues, N of them stamped with
 * the wrong path.)
 */
export function checkScriptRequires(
  fromPath: string,
  sources: Map<string, string>,
  sourceOverride?: string,
): ScriptDiagnostic[] {
  const diagnostics: ScriptDiagnostic[] = [];
  const topSource = sourceOverride ?? sources.get(fromPath) ?? '';

  /**
   * DFS from an already-resolved module looking for a require chain leading
   * back to fromPath (i.e. a cycle through fromPath). Returns the chain
   * [start, ..., fromPath] or null. Unresolvable requires met along the way
   * are skipped silently — they are that file's own diagnostics, reported
   * when it is checked.
   */
  const findChainBackToSelf = (start: string): string[] | null => {
    const visited = new Set<string>();
    const walk = (path: string, trail: string[]): string[] | null => {
      if (path === fromPath) return trail;
      if (visited.has(path)) return null;
      visited.add(path);
      const source = sources.get(path);
      if (source === undefined) return null;
      for (const req of findLiteralRequires(scriptLanguageOf(path), source)) {
        const resolved = resolveRequireSpec(req.spec, path);
        if (!isResolvableRequire(resolved, path, sources)) continue;
        const chain = walk(resolved, [...trail, resolved]);
        if (chain) return chain;
      }
      return null;
    };
    return walk(start, [start]);
  };

  for (const req of findLiteralRequires(scriptLanguageOf(fromPath), topSource)) {
    const resolved = resolveRequireSpec(req.spec, fromPath);
    if (!isResolvableRequire(resolved, fromPath, sources)) {
      diagnostics.push({
        severity: 'error',
        code: 'SCRIPT_REQUIRE_NOT_FOUND',
        line: req.line,
        message: `module not found: ${resolved}`,
      });
      continue;
    }

    const chain = resolved === fromPath ? [resolved] : findChainBackToSelf(resolved);
    if (chain) {
      diagnostics.push({
        severity: 'error',
        code: 'SCRIPT_REQUIRE_CYCLE',
        line: req.line,
        message: `require cycle: ${[fromPath, ...chain].join(' -> ')}`,
      });
    }
  }
  return diagnostics;
}

/**
 * Per-script syntax check across the whole project: thin wrapper around
 * `checkScriptSource` that maps its diagnostics into `ValidationIssue`
 * pushes (same message format, codes, and line handling as before the
 * extraction).
 */
async function validateScriptSyntax(store: ProjectStore, push: (issue: ValidationIssue) => void): Promise<void> {
  const sources = new Map<string, string>();
  for (const scriptPath of await store.listScripts()) {
    sources.set(scriptPath, await store.readScript(scriptPath));
  }

  for (const [scriptPath, source] of sources) {
    if (scriptPath.endsWith('.js') || scriptPath.endsWith('.lua')) {
      const language = scriptPath.endsWith('.js') ? 'js' : 'lua';
      for (const diag of checkScriptSource(language, source)) {
        push({
          severity: diag.severity,
          code: 'SCRIPT_SYNTAX_ERROR',
          message: `Script ${scriptPath}${diag.line ? `:${diag.line}` : ''}: ${diag.message}`,
          script: scriptPath,
          ...(diag.line !== null ? { line: diag.line } : {}),
        });
      }
      for (const diag of checkScriptRequires(scriptPath, sources)) {
        push({
          severity: diag.severity,
          code: diag.code ?? 'SCRIPT_REQUIRE_NOT_FOUND',
          message: `Script ${scriptPath}${diag.line ? `:${diag.line}` : ''}: ${diag.message}`,
          script: scriptPath,
          ...(diag.line !== null ? { line: diag.line } : {}),
        });
      }
    } else {
      push({
        severity: 'warning',
        code: 'SCRIPT_UNKNOWN_EXTENSION',
        message: `Script ${scriptPath} has an unsupported extension; Hearth runs .lua and .js scripts`,
        script: scriptPath,
      });
    }
  }
}

/**
 * Diffs a raw (pre-Zod-strip) component object's keys against its schema's
 * field names, recursing one extra level into fields that are themselves
 * known objects (e.g. Transform.position). Zod strips unrecognized keys
 * silently rather than erroring, so this is the only place a typo like
 * `Transform.postiion` becomes visible once the project has already loaded —
 * this pass is a warning only: pre-fix projects (saved before strict path
 * validation existed) must still load and run.
 */
function unknownKeyPaths(
  schema: z.ZodTypeAny,
  rawValue: Record<string, unknown>,
  depthRemaining: number,
): string[] {
  const node = unwrap(schema);
  if (!(node instanceof z.ZodObject)) return [];
  const fields = node.shape as Record<string, z.ZodTypeAny>;
  const validKeys = Object.keys(fields);
  const found: string[] = [];
  for (const key of Object.keys(rawValue)) {
    if (!validKeys.includes(key)) {
      found.push(key);
      continue;
    }
    if (depthRemaining <= 0) continue;
    const fieldValue = rawValue[key];
    if (fieldValue && typeof fieldValue === 'object' && !Array.isArray(fieldValue)) {
      for (const nested of unknownKeyPaths(fields[key], fieldValue as Record<string, unknown>, depthRemaining - 1)) {
        found.push(`${key}.${nested}`);
      }
    }
  }
  return found;
}

/**
 * Re-reads every scene's raw JSON (bypassing the Zod strip that already
 * happened when `store` was loaded) and warns about component keys that
 * don't match the component's schema — top level, plus one extra level into
 * known nested objects (e.g. Transform.position.z would be caught;
 * a typo three levels deep would not).
 */
async function checkUnknownComponentKeys(store: ProjectStore, push: (issue: ValidationIssue) => void): Promise<void> {
  for (const sceneId of store.scenes.keys()) {
    const ref = store.sceneRef(sceneId);
    if (!ref) continue;
    const absPath = joinPath(store.root, ref.path);
    if (!(await store.fs.exists(absPath))) continue; // missing file is handled elsewhere (project.load would already have thrown)

    let raw: unknown;
    try {
      raw = await readJson(store.fs, absPath);
    } catch {
      continue; // unreadable/corrupt file; nothing more this pass can say
    }
    const rawEntities = (raw as { entities?: unknown }).entities;
    if (!Array.isArray(rawEntities)) continue;

    for (const rawEntity of rawEntities) {
      if (typeof rawEntity !== 'object' || rawEntity === null) continue;
      const entityId = typeof (rawEntity as any).id === 'string' ? (rawEntity as any).id : undefined;
      const entityName = typeof (rawEntity as any).name === 'string' ? (rawEntity as any).name : entityId ?? '(unknown)';
      const rawComponents = (rawEntity as { components?: unknown }).components;
      if (typeof rawComponents !== 'object' || rawComponents === null) continue;

      for (const [type, rawComponent] of Object.entries(rawComponents as Record<string, unknown>)) {
        if (!isComponentType(type)) continue; // unknown component type names are caught at load time (ComponentMapSchema is strict)
        if (typeof rawComponent !== 'object' || rawComponent === null) continue;
        const unknownPaths = unknownKeyPaths(COMPONENT_SCHEMAS[type], rawComponent as Record<string, unknown>, 1);
        for (const path of unknownPaths) {
          push({
            severity: 'warning',
            code: 'UNKNOWN_COMPONENT_KEY',
            message: `Entity "${entityName}" ${type} has an unrecognized property "${path}" (not in the ${type} schema); it is ignored on load`,
            scene: sceneId,
            entity: entityId,
          });
        }
      }
    }
  }
}

export async function validateProject(store: ProjectStore): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];
  const push = (issue: ValidationIssue) => issues.push(issue);

  const { project } = store;

  // --- project-level ---
  if (project.initialScene) {
    if (!store.scenes.has(project.initialScene)) {
      push({
        severity: 'error',
        code: 'MISSING_INITIAL_SCENE',
        message: `initialScene "${project.initialScene}" does not match any scene id`,
      });
    }
  } else if (project.scenes.length > 0) {
    push({
      severity: 'warning',
      code: 'NO_INITIAL_SCENE',
      message: 'No initialScene set; "hearth run" will need an explicit scene argument',
    });
  }

  const sceneNames = new Map<string, number>();
  for (const ref of project.scenes) {
    sceneNames.set(ref.name, (sceneNames.get(ref.name) ?? 0) + 1);
  }
  for (const [name, count] of sceneNames) {
    if (count > 1) {
      push({
        severity: 'warning',
        code: 'DUPLICATE_SCENE_NAME',
        message: `Scene name "${name}" is used ${count} times; prefer unique names so agents can address scenes by name`,
      });
    }
  }

  // --- assets ---
  const assetIds = new Set(store.assets.assets.map((a) => a.id));
  const assetsById = new Map(store.assets.assets.map((a) => [a.id, a]));
  for (const asset of store.assets.assets) {
    if (!(await store.fs.exists(joinPath(store.root, asset.path)))) {
      push({
        severity: 'error',
        code: 'MISSING_ASSET_FILE',
        message: `Asset "${asset.name}" (${asset.id}) points to missing file: ${asset.path}`,
        asset: asset.id,
      });
    }
  }

  // buildSettings.icon: must reference an existing sprite/tile (image) asset,
  // mirroring exportDesktop's own gate so Validate names the problem before
  // an export is attempted. Warning (not error) severity on purpose:
  // exportDesktop refuses to export when validation has ERRORS, and its own
  // icon checks carry more specific messages — an error here would mask them
  // behind the generic "N validation error(s)" refusal.
  const iconId = project.buildSettings.icon;
  if (iconId) {
    const iconAsset = assetsById.get(iconId);
    if (!iconAsset) {
      push({
        severity: 'warning',
        code: 'MISSING_ICON_ASSET',
        message: `buildSettings.icon references an unknown asset: ${iconId}; exportDesktop will fail until it is fixed or cleared`,
      });
    } else if (iconAsset.type !== 'sprite' && iconAsset.type !== 'tile') {
      push({
        severity: 'warning',
        code: 'ICON_ASSET_NOT_IMAGE',
        message: `buildSettings.icon must be a sprite or tile asset, but "${iconAsset.name}" (${iconId}) is a "${iconAsset.type}" asset; exportDesktop will fail until it is fixed or cleared`,
        asset: iconId,
      });
    }
  }

  // Pre-pass: animation assets' frame refs ("<sheetAssetId>#<frameName>").
  // Plain (no-'#') entries are sprite-asset ids, already covered above.
  for (const asset of store.assets.assets) {
    if (asset.type !== 'animation') continue;
    let data: unknown;
    try {
      data = await readJson(store.fs, joinPath(store.root, asset.path));
    } catch {
      continue; // missing/unreadable file already flagged as MISSING_ASSET_FILE
    }
    const parsed = AnimationDataSchema.safeParse(data);
    if (!parsed.success) continue;
    for (const ref of parsed.data.frames) {
      const hashIdx = ref.indexOf('#');
      if (hashIdx === -1) continue;
      const sheetId = ref.slice(0, hashIdx);
      const frameName = ref.slice(hashIdx + 1);
      const sheet = assetsById.get(sheetId);
      const frame = sheet ? findSheetFrame(sheet, frameName) : null;
      if (!frame) {
        push({
          severity: 'warning',
          code: 'ANIMATION_FRAME_NOT_FOUND',
          message: `Animation "${asset.name}" (${asset.id}) references frame "${ref}" which was not found`,
          asset: asset.id,
        });
      }
    }
  }

  // --- scripts (syntax) ---
  await validateScriptSyntax(store, push);
  const scripts = new Set(await store.listScripts());

  // --- unrecognized component keys (typos Zod silently stripped on load) ---
  await checkUnknownComponentKeys(store, push);

  // --- prefabs ---
  // Payload files are validated the same way instantiatePrefab/syncPrefabInstances
  // load them (schema parse + local-id invariants), then their component refs are
  // resolved against the same asset/script indexes scene entities use.
  for (const asset of store.assets.assets) {
    if (asset.type !== 'prefab') continue;

    const absPath = joinPath(store.root, asset.path);
    if (!(await store.fs.exists(absPath))) continue; // already flagged as MISSING_ASSET_FILE

    let raw: unknown;
    try {
      raw = await readJson(store.fs, absPath);
    } catch (err) {
      push({
        severity: 'error',
        code: 'PREFAB_DATA_INVALID',
        message: `Prefab "${asset.name}" (${asset.id}) payload (${asset.path}) could not be parsed: ${(err as Error).message}`,
        asset: asset.id,
      });
      continue;
    }

    const parsed = PrefabDataSchema.safeParse(raw);
    if (!parsed.success) {
      push({
        severity: 'error',
        code: 'PREFAB_DATA_INVALID',
        message: `Prefab "${asset.name}" (${asset.id}) payload does not match the prefab schema: ${parsed.error.message}`,
        asset: asset.id,
      });
      continue;
    }

    const data: PrefabData = parsed.data;
    const localIdProblems = validatePrefabLocalIds(data);
    if (localIdProblems.length > 0) {
      push({
        severity: 'error',
        code: 'PREFAB_DATA_INVALID',
        message: `Prefab "${asset.name}" (${asset.id}) has invalid local ids: ${localIdProblems.join('; ')}`,
        asset: asset.id,
      });
      continue;
    }

    for (const entity of data.entities) {
      const c = entity.components;
      if (c.SpriteRenderer?.assetId && !assetIds.has(c.SpriteRenderer.assetId)) {
        push({
          severity: 'error',
          code: 'PREFAB_ASSET_NOT_FOUND',
          message: `Prefab "${asset.name}" (${asset.id}) entity "${entity.name}" SpriteRenderer references unknown asset ${c.SpriteRenderer.assetId}`,
          asset: asset.id,
        });
      }
      if (c.AudioSource?.assetId && !assetIds.has(c.AudioSource.assetId)) {
        push({
          severity: 'error',
          code: 'PREFAB_ASSET_NOT_FOUND',
          message: `Prefab "${asset.name}" (${asset.id}) entity "${entity.name}" AudioSource references unknown asset ${c.AudioSource.assetId}`,
          asset: asset.id,
        });
      }
      if (c.SpriteAnimator?.assetId && !assetIds.has(c.SpriteAnimator.assetId)) {
        push({
          severity: 'error',
          code: 'PREFAB_ASSET_NOT_FOUND',
          message: `Prefab "${asset.name}" (${asset.id}) entity "${entity.name}" SpriteAnimator references unknown asset ${c.SpriteAnimator.assetId}`,
          asset: asset.id,
        });
      }
      // Reuse PREFAB_ASSET_NOT_FOUND for type mismatches to keep the prefab validation code set closed.
      if (c.SpriteAnimator?.assetId) {
        const animAsset = assetsById.get(c.SpriteAnimator.assetId);
        if (animAsset && animAsset.type !== 'animation') {
          push({
            severity: 'error',
            code: 'PREFAB_ASSET_NOT_FOUND',
            message: `Prefab "${asset.name}" (${asset.id}) entity "${entity.name}" SpriteAnimator references asset "${animAsset.name}" (${animAsset.id}) which is type '${animAsset.type}', not an animation`,
            asset: asset.id,
          });
        }
      }
      if (c.Tilemap) {
        for (const [ch, tile] of Object.entries(c.Tilemap.tileAssets)) {
          const tileAssetId = typeof tile === 'string' ? tile : tile.sheet;
          if (!assetIds.has(tileAssetId)) {
            push({
              severity: 'error',
              code: 'PREFAB_ASSET_NOT_FOUND',
              message:
                typeof tile === 'string'
                  ? `Prefab "${asset.name}" (${asset.id}) entity "${entity.name}" Tilemap maps '${ch}' to unknown asset ${tileAssetId}`
                  : `Prefab "${asset.name}" (${asset.id}) entity "${entity.name}" Tilemap autotiles '${ch}' from unknown spritesheet ${tileAssetId}`,
              asset: asset.id,
            });
          }
        }
      }
      if (c.Script?.scriptPath && !scripts.has(c.Script.scriptPath)) {
        push({
          severity: 'error',
          code: 'PREFAB_SCRIPT_NOT_FOUND',
          message: `Prefab "${asset.name}" (${asset.id}) entity "${entity.name}" references missing script ${c.Script.scriptPath}`,
          asset: asset.id,
          script: c.Script.scriptPath,
        });
      }
    }
  }

  // --- scenes / entities ---

  // Pre-pass: collect all layers used by Colliders
  const usedLayers = new Set<string>();
  for (const scene of store.scenes.values()) {
    for (const entity of scene.entities) {
      if (entity.components.Collider?.layer) {
        usedLayers.add(entity.components.Collider.layer);
      }
    }
  }

  for (const [sceneId, scene] of store.scenes) {
    const ids = new Set<string>();
    let mainCameras = 0;

    for (const entity of scene.entities) {
      if (ids.has(entity.id)) {
        push({
          severity: 'error',
          code: 'DUPLICATE_ENTITY_ID',
          message: `Duplicate entity id ${entity.id} in scene "${scene.name}"`,
          scene: sceneId,
          entity: entity.id,
        });
      }
      ids.add(entity.id);
    }

    for (const entity of scene.entities) {
      if (entity.parentId && !ids.has(entity.parentId)) {
        push({
          severity: 'error',
          code: 'MISSING_PARENT',
          message: `Entity "${entity.name}" (${entity.id}) has parentId ${entity.parentId} which does not exist in scene "${scene.name}"`,
          scene: sceneId,
          entity: entity.id,
        });
      }

      // Parent cycles
      let cursor = entity.parentId;
      const seen = new Set<string>([entity.id]);
      while (cursor) {
        if (seen.has(cursor)) {
          push({
            severity: 'error',
            code: 'PARENT_CYCLE',
            message: `Entity "${entity.name}" (${entity.id}) is part of a parent cycle in scene "${scene.name}"`,
            scene: sceneId,
            entity: entity.id,
          });
          break;
        }
        seen.add(cursor);
        cursor = scene.entities.find((e) => e.id === cursor)?.parentId ?? null;
      }

      const c = entity.components;
      if (c.Camera?.isMain) mainCameras++;

      if (c.SpriteRenderer?.assetId && !assetIds.has(c.SpriteRenderer.assetId)) {
        push({
          severity: 'error',
          code: 'MISSING_SPRITE_ASSET',
          message: `Entity "${entity.name}" SpriteRenderer references unknown asset ${c.SpriteRenderer.assetId}`,
          scene: sceneId,
          entity: entity.id,
        });
      }
      if (c.SpriteRenderer?.frame != null) {
        const sheet = c.SpriteRenderer.assetId ? assetsById.get(c.SpriteRenderer.assetId) : undefined;
        const frame = sheet ? findSheetFrame(sheet, c.SpriteRenderer.frame) : null;
        if (!frame) {
          push({
            severity: 'warning',
            code: 'FRAME_NOT_FOUND',
            message: `Entity "${entity.name}" SpriteRenderer references frame "${c.SpriteRenderer.frame}" which was not found on asset ${c.SpriteRenderer.assetId ?? '(none)'}`,
            scene: sceneId,
            entity: entity.id,
          });
        }
      }
      // Pixel-art smear: a raster texture in `stretch` renderMode whose box is
      // a non-integer or aspect-distorting scale of the native pixels. This is
      // the classic "build a platform by stretching one grass tile" mistake —
      // skill prose alone didn't stop it, so validate (which every agent loop
      // runs) catches it mechanically. Warning, not error: pre-existing
      // projects must keep loading and exporting. SVG/procedural sprites are
      // vector and scale cleanly; assets with pixelArt:false (photos, soft art)
      // opt out; `tile`/`sliced` modes always preserve native texels.
      if (c.SpriteRenderer?.assetId && c.SpriteRenderer.renderMode === 'stretch') {
        const srAsset = assetsById.get(c.SpriteRenderer.assetId);
        const isRasterImage =
          srAsset && (srAsset.type === 'sprite' || srAsset.type === 'tile') && !srAsset.path.endsWith('.svg');
        const effectivePixelArt = srAsset ? (srAsset.pixelArt ?? project.buildSettings.pixelPerfect) : false;
        if (isRasterImage && effectivePixelArt) {
          let nativeW: number | undefined;
          let nativeH: number | undefined;
          if (c.SpriteRenderer.frame != null) {
            const fr = findSheetFrame(srAsset, c.SpriteRenderer.frame);
            if (fr) {
              nativeW = fr.width;
              nativeH = fr.height;
            }
          } else {
            const mw = srAsset.metadata?.width;
            const mh = srAsset.metadata?.height;
            if (typeof mw === 'number' && mw > 0 && typeof mh === 'number' && mh > 0) {
              nativeW = mw;
              nativeH = mh;
            }
          }
          if (nativeW && nativeH) {
            const sx = c.SpriteRenderer.width / nativeW;
            const sy = c.SpriteRenderer.height / nativeH;
            const isIntegerScale = Math.abs(sx - Math.round(sx)) < 1e-9;
            if (sx !== sy || !isIntegerScale) {
              const source = c.SpriteRenderer.frame != null ? `frame "${c.SpriteRenderer.frame}" of "${srAsset.name}"` : `"${srAsset.name}"`;
              push({
                severity: 'warning',
                code: 'PIXEL_ART_STRETCHED',
                message:
                  `Entity "${entity.name}" SpriteRenderer stretches pixel art ${source} (${nativeW}×${nativeH}) ` +
                  `to ${c.SpriteRenderer.width}×${c.SpriteRenderer.height} — ${sx === sy ? 'a non-integer' : 'an aspect-distorting'} scale that smears texels. ` +
                  `For a surface/platform use renderMode 'tile' (or a Tilemap); otherwise keep the box at an integer scale of the native size (e.g. ${nativeW * 2}×${nativeH * 2}). ` +
                  `Genuinely non-pixel art (a photo, a painted backdrop) may scale freely — mark the asset pixelArt:false to opt out`,
                scene: sceneId,
                entity: entity.id,
                asset: srAsset.id,
              });
            }
          }
        }
      }
      if (c.AudioSource?.assetId && !assetIds.has(c.AudioSource.assetId)) {
        push({
          severity: 'error',
          code: 'MISSING_AUDIO_ASSET',
          message: `Entity "${entity.name}" AudioSource references unknown asset ${c.AudioSource.assetId}`,
          scene: sceneId,
          entity: entity.id,
        });
      }
      if (c.Script) {
        if (!c.Script.scriptPath) {
          push({
            severity: 'warning',
            code: 'EMPTY_SCRIPT_PATH',
            message: `Entity "${entity.name}" has a Script component with no scriptPath`,
            scene: sceneId,
            entity: entity.id,
          });
        } else if (!scripts.has(c.Script.scriptPath)) {
          push({
            severity: 'error',
            code: 'MISSING_SCRIPT',
            message: `Entity "${entity.name}" references missing script ${c.Script.scriptPath}`,
            scene: sceneId,
            entity: entity.id,
            script: c.Script.scriptPath,
          });
        }
      }
      if (entity.prefab) {
        const prefabAsset = assetsById.get(entity.prefab.asset);
        if (!prefabAsset || prefabAsset.type !== 'prefab') {
          push({
            severity: 'warning',
            code: 'PREFAB_INSTANCE_ORPHANED',
            message: `Entity "${entity.name}" (${entity.id}) is marked as an instance of prefab ${entity.prefab.asset}, but that asset is missing or is not a prefab`,
            scene: sceneId,
            entity: entity.id,
            asset: entity.prefab.asset,
          });
        }
      }
      if (c.Tilemap) {
        for (const [ch, tile] of Object.entries(c.Tilemap.tileAssets)) {
          // A tile source is either a plain asset id (string) or an autotile
          // rule (object) whose `sheet` names the spritesheet asset. Either
          // way the referenced asset must exist.
          const assetRef = typeof tile === 'string' ? tile : tile.sheet;
          if (!assetIds.has(assetRef)) {
            push({
              severity: 'error',
              code: 'MISSING_TILE_ASSET',
              message:
                typeof tile === 'string'
                  ? `Tilemap on "${entity.name}" maps '${ch}' to unknown asset ${assetRef}`
                  : `Tilemap on "${entity.name}" autotiles '${ch}' from unknown spritesheet ${assetRef}`,
              scene: sceneId,
              entity: entity.id,
            });
          }
        }
        const rowLengths = new Set(c.Tilemap.grid.map((r) => r.length));
        if (rowLengths.size > 1) {
          push({
            severity: 'warning',
            code: 'RAGGED_TILEMAP',
            message: `Tilemap on "${entity.name}" has rows of different lengths`,
            scene: sceneId,
            entity: entity.id,
          });
        }
      }
      if (c.Collider?.shape === 'polygon') {
        for (const issue of validatePolygonPoints(c.Collider.points)) {
          push({
            severity: 'error',
            code: issue.code,
            message: `Entity "${entity.name}" in scene "${scene.name}": ${issue.message}`,
            scene: sceneId,
            entity: entity.id,
          });
        }
      }
      if (c.PhysicsBody && !c.Collider && c.PhysicsBody.bodyType === 'dynamic') {
        push({
          severity: 'warning',
          code: 'BODY_WITHOUT_COLLIDER',
          message: `Entity "${entity.name}" has a dynamic PhysicsBody but no Collider; it will fall forever`,
          scene: sceneId,
          entity: entity.id,
        });
      }
      // Feet mismatch — the "floating player" disconnect. Sprites are
      // center-anchored and colliders centered + offset, so a dynamic body
      // whose collider bottom differs from its sprite bottom visibly floats
      // above the ground (or sinks into it) when physics rests the collider on
      // a surface. Intentional smaller hitboxes are fine — they align feet via
      // offset.y — so only a bottom-edge mismatch is flagged. Triggers don't
      // resolve contacts and static bodies don't rest on anything; both skip.
      if (
        c.SpriteRenderer &&
        c.Collider &&
        !c.Collider.isTrigger &&
        c.PhysicsBody?.bodyType === 'dynamic' &&
        (c.Collider.shape === 'box' || c.Collider.shape === 'circle')
      ) {
        const spriteBottom = c.SpriteRenderer.height / 2;
        const colliderHalf = c.Collider.shape === 'box' ? c.Collider.height / 2 : c.Collider.radius;
        const colliderBottom = c.Collider.offset.y + colliderHalf;
        const mismatch = spriteBottom - colliderBottom;
        // Tolerance 2px: a 1-2px overlap is a common deliberate "settle" (it
        // hides floating-point contact flicker); beyond that the disconnect is
        // clearly visible.
        if (Math.abs(mismatch) > 2) {
          const fixOffsetY = spriteBottom - colliderHalf;
          push({
            severity: 'warning',
            code: 'SPRITE_COLLIDER_FEET_MISMATCH',
            message:
              `Entity "${entity.name}" sprite bottom (${spriteBottom}) and collider bottom (${colliderBottom}) differ by ${Math.abs(mismatch)}px — ` +
              `the art will visibly ${mismatch > 0 ? 'sink into' : 'float above'} surfaces it rests on. ` +
              `Align the feet with Collider.offset.y = ${fixOffsetY} (or size the collider to match the sprite)`,
            scene: sceneId,
            entity: entity.id,
          });
        }
      }
      if (c.LineRenderer && c.LineRenderer.points.length < 2) {
        push({
          severity: 'warning',
          code: 'LINERENDERER_TOO_FEW_POINTS',
          message: `Entity "${entity.name}" has a LineRenderer with ${c.LineRenderer.points.length} point(s); LineRenderer needs at least 2 points to draw`,
          scene: sceneId,
          entity: entity.id,
        });
      }
      if (c.ParticleEmitter && c.ParticleEmitter.rate === 0 && c.ParticleEmitter.burst === 0) {
        push({
          severity: 'warning',
          code: 'PARTICLE_EMITTER_EMITS_NOTHING',
          message: `Entity "${entity.name}" has a ParticleEmitter with rate=0 and burst=0; it emits nothing`,
          scene: sceneId,
          entity: entity.id,
        });
      }
      if (c.SpriteAnimator && !c.SpriteRenderer) {
        push({
          severity: 'warning',
          code: 'SPRITE_ANIMATOR_MISSING_RENDERER',
          message: `Entity "${entity.name}" has a SpriteAnimator but no SpriteRenderer sibling; SpriteAnimator requires a SpriteRenderer`,
          scene: sceneId,
          entity: entity.id,
        });
      }
      if (c.SpriteAnimator?.assetId) {
        if (!assetIds.has(c.SpriteAnimator.assetId)) {
          push({
            severity: 'error',
            code: 'MISSING_ANIMATION_ASSET',
            message: `Entity "${entity.name}" SpriteAnimator references unknown asset ${c.SpriteAnimator.assetId}`,
            scene: sceneId,
            entity: entity.id,
          });
        } else {
          const asset = assetsById.get(c.SpriteAnimator.assetId);
          if (asset?.type !== 'animation') {
            push({
              severity: 'error',
              code: 'INVALID_ANIMATION_ASSET_TYPE',
              message: `Entity "${entity.name}" SpriteAnimator references asset ${c.SpriteAnimator.assetId} which is type '${asset?.type ?? 'unknown'}', not 'animation'`,
              scene: sceneId,
              entity: entity.id,
            });
          }
        }
      }
      if (c.Collider?.collidesWith) {
        if (c.Collider.collidesWith.length === 0) {
          push({
            severity: 'warning',
            code: 'COLLIDER_COLLIDES_WITH_NOTHING',
            message: `Entity "${entity.name}" Collider has collidesWith: [], so it collides with nothing`,
            scene: sceneId,
            entity: entity.id,
          });
        }
        for (const layer of c.Collider.collidesWith) {
          if (layer !== '*' && !usedLayers.has(layer)) {
            push({
              severity: 'warning',
              code: 'COLLIDES_WITH_UNKNOWN_LAYER',
              message: `Entity "${entity.name}" collidesWith "${layer}" but no Collider in the project uses layer "${layer}"`,
              scene: sceneId,
              entity: entity.id,
            });
          }
        }
      }
    }

    if (scene.entities.length > 0 && mainCameras === 0) {
      push({
        severity: 'warning',
        code: 'NO_MAIN_CAMERA',
        message: `Scene "${scene.name}" has no Camera with isMain=true; the runtime will use a default camera at origin`,
        scene: sceneId,
      });
    }
    if (mainCameras > 1) {
      push({
        severity: 'warning',
        code: 'MULTIPLE_MAIN_CAMERAS',
        message: `Scene "${scene.name}" has ${mainCameras} main cameras; the first one wins`,
        scene: sceneId,
      });
    }
  }

  // --- playtests ---
  for (const pt of store.playtests.values()) {
    if (!store.getScene(pt.scene)) {
      push({
        severity: 'error',
        code: 'PLAYTEST_MISSING_SCENE',
        message: `Playtest "${pt.name}" targets unknown scene "${pt.scene}"`,
      });
    }
    for (const step of pt.steps) {
      if ((step.type === 'press' || step.type === 'release') && !(step.action in store.project.inputMappings.actions)) {
        push({
          severity: 'warning',
          code: 'PLAYTEST_UNKNOWN_ACTION',
          message: `Playtest "${pt.name}" uses input action "${step.action}" which is not in inputMappings`,
        });
      }
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { valid: errors.length === 0, errors, warnings };
}
