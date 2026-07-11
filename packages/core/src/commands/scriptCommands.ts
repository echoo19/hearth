import { z } from 'zod';
import { defineCommand, type CommandContext } from './types.js';
import { findEntity } from '../schema/scene.js';
import { createComponent } from '../schema/components.js';
import { ProjectError } from '../project/store.js';
import { joinPath, isSafeRelativePath } from '../fs.js';
import { slugify } from '../ids.js';
import { SCRIPTS_DIR } from '../schema/project.js';
import { checkScriptSource } from '../validate.js';
import { formatSource, FormatError } from '../format.js';

export const SCRIPT_TEMPLATE = `/**
 * {{NAME}} — a Hearth behavior script.
 *
 * Lifecycle hooks receive a context (ctx) with:
 *   ctx.entity        - { id, name, tags }
 *   ctx.transform     - live Transform { position, rotation, scale }
 *   ctx.getComponent(type)          - live component data (mutable)
 *   ctx.params        - parameters from the Script component
 *   ctx.input.isDown(action)        - is an input action held?
 *   ctx.input.justPressed(action)   - pressed this frame?
 *   ctx.scene.find(name)            - EntityHandle | null
 *   ctx.scene.findByTag(tag)        - EntityHandle[]
 *   ctx.scene.spawn(def)            - create an entity at runtime
 *   ctx.scene.destroy(idOrHandle)   - remove an entity at runtime
 *   ctx.scenes.current              - current scene { id, name }
 *   ctx.scenes.list()               - all scenes as { id, name }
 *   ctx.scenes.load(idOrName)       - switch scene at end of frame (false if unknown)
 *   ctx.timers.after(seconds, fn)   - run fn once; returns a cancel id
 *   ctx.timers.every(seconds, fn)   - run fn repeatedly; returns a cancel id
 *   ctx.timers.cancel(id)           - cancel a timer
 *   ctx.tweens.to(path, target, seconds, opts) - tween a numeric component
 *       property, e.g. ctx.tweens.to('Transform.position.x', 400, 0.5,
 *       { easing: 'easeOut' }); returns a cancel id
 *   ctx.tweens.cancel(id)           - cancel a tween
 *   ctx.random.next()               - seeded deterministic [0, 1)
 *   ctx.random.range(min, max)      - seeded float in [min, max)
 *   ctx.random.int(min, max)        - seeded integer, inclusive
 *   ctx.particles.burst(count)      - spawn count particles now (needs ParticleEmitter)
 *   ctx.particles.count()           - live particle count (needs ParticleEmitter)
 *   ctx.animate(assetRef)           - switch SpriteAnimator to an animation asset, restart at frame 0
 *   ctx.save(key, value)            - persistent save data (JSON values)
 *   ctx.load(key)                   - read saved data (null when absent)
 *   ctx.clearSave(key?)             - clear one key (no key = clear all)
 *   ctx.camera.getPosition() / .setPosition(x, y) - main camera position
 *   ctx.camera.getZoom() / .setZoom(zoom)         - main camera zoom
 *   ctx.camera.follow(idOrName)     - follow an entity each frame (null stops)
 *   ctx.audio.play(assetRef, opts)  - play a sound; returns a handle id
 *       (opts: { volume, loop }); ctx.audio.stop(handleOrAssetRef) stops it
 *   ctx.vars          - per-entity persistent state object
 *   ctx.time          - { elapsed, delta, frame }
 *   ctx.log(...args)  - log to the Hearth console
 *   ctx.collisions    - this entity's current collisions
 *   ctx.isGrounded()  - standing on something?
 *   ctx.destroySelf() - remove this entity
 */
export default {
  onStart(ctx) {
    // Runs once when the scene starts.
  },

  onUpdate(ctx, dt) {
    // Runs every frame. dt is seconds since last frame.
  },

  onCollision(ctx, other) {
    // Runs when this entity's collider touches another ("other" is an EntityHandle).
  },

  onUiEvent(ctx, event) {
    // Pointer/focus events on this entity's interactive UIElement
    // (event.type: click|press|release|enter|exit|drag|change|focus|blur;
    // event.value is set on "change" — the slider/toggle's new value).
  },
};
`;

export const LUA_SCRIPT_TEMPLATE = `-- {{NAME}} — a Hearth behavior script (Lua).
--
-- IMPORTANT: call ctx with a dot, not a colon: ctx.log("hi"), never ctx:log("hi").
--
-- Lifecycle hooks receive a context (ctx) with:
--   ctx.entity                      - { id, name, tags }
--   ctx.transform                   - live Transform { position, rotation, scale }
--   ctx.getComponent(type)          - live component data (mutable)
--   ctx.params                      - parameters from the Script component
--   ctx.input.isDown(action)        - is an input action held?
--   ctx.input.justPressed(action)   - pressed this frame?
--   ctx.scene.find(name)            - EntityHandle or nil
--   ctx.scene.findByTag(tag)        - list of EntityHandles
--   ctx.scene.spawn(def)            - create an entity at runtime
--   ctx.scene.destroy(idOrHandle)   - remove an entity at runtime
--   ctx.scenes.current              - current scene { id, name }
--   ctx.scenes.list()               - all scenes as { id, name }
--   ctx.scenes.load(idOrName)       - switch scene at end of frame (false if unknown)
--   ctx.timers.after(seconds, fn)   - run fn once; returns a cancel id
--   ctx.timers.every(seconds, fn)   - run fn repeatedly; returns a cancel id
--   ctx.timers.cancel(id)           - cancel a timer
--   ctx.tweens.to(path, target, seconds, opts) - tween a numeric component
--       property, e.g. ctx.tweens.to("Transform.position.x", 400, 0.5,
--       { easing = "easeOut" }); returns a cancel id
--   ctx.tweens.cancel(id)           - cancel a tween
--   ctx.random.next()               - seeded deterministic [0, 1)
--   ctx.random.range(min, max)      - seeded float in [min, max)
--   ctx.random.int(min, max)        - seeded integer, inclusive
--   ctx.particles.burst(count)      - spawn count particles now (needs ParticleEmitter)
--   ctx.particles.count()           - live particle count (needs ParticleEmitter)
--   ctx.animate(assetRef)           - switch SpriteAnimator to an animation asset, restart at frame 0
--   ctx.save(key, value)            - persistent save data (JSON values)
--   ctx.load(key)                   - read saved data (nil when absent)
--   ctx.clearSave(key)              - clear one key (no key = clear all)
--   ctx.camera.getPosition() / ctx.camera.setPosition(x, y) - main camera position
--   ctx.camera.getZoom() / ctx.camera.setZoom(zoom)         - main camera zoom
--   ctx.camera.follow(idOrName)     - follow an entity each frame (nil stops)
--   ctx.audio.play(assetRef, opts)  - play a sound; returns a handle id
--       (opts: { volume = ..., loop = ... }); ctx.audio.stop(handleOrAssetRef) stops it
--   ctx.vars                        - per-entity persistent state table
--   ctx.time                        - { elapsed, delta, frame }
--   ctx.log(...)                    - log to the Hearth console
--   ctx.collisions                  - this entity's current collisions
--   ctx.isGrounded()                - standing on something?
--   ctx.destroySelf()               - remove this entity

local script = {}

function script.onStart(ctx)
  -- Runs once when the scene starts.
end

function script.onUpdate(ctx, dt)
  -- Runs every frame. dt is seconds since last frame.
end

function script.onCollision(ctx, other)
  -- Runs when this entity's collider touches another ("other" is an EntityHandle).
end

function script.onUiEvent(ctx, event)
  -- Pointer/focus events on this entity's interactive UIElement
  -- (event.type: click|press|release|enter|exit|drag|change|focus|blur;
  -- event.value is set on "change" - the slider/toggle's new value).
end

return script
`;

export const createScript = defineCommand({
  name: 'createScript',
  description:
    'Create a new script file in scripts/ from the standard template (or custom source). Lua by default; language "js" for JavaScript. Returns its path.',
  permission: 'code-edit',
  mutates: true,
  paramsSchema: z.object({
    name: z.string().min(1),
    /** Scripting language; Lua is the Hearth default. */
    language: z.enum(['lua', 'js']).default('lua'),
    /** Full source; omit to use the documented template. */
    source: z.string().optional(),
    /** Override project codeStyle.formatOnSave for this call. */
    format: z.boolean().optional(),
  }),
  async run(ctx, params) {
    const filename = slugify(params.name).replace(/_/g, '-') + '.' + params.language;
    const relPath = joinPath(SCRIPTS_DIR, filename);
    const absPath = joinPath(ctx.store.root, relPath);
    if (await ctx.fs.exists(absPath)) {
      throw new ProjectError(`Script already exists: ${relPath}. Use editScript to modify it.`, 'CONFLICT');
    }
    const template = params.language === 'js' ? SCRIPT_TEMPLATE : LUA_SCRIPT_TEMPLATE;
    const rawSource = params.source ?? template.replace('{{NAME}}', params.name);
    const { source, formatted } = await applyFormatting(ctx, relPath, rawSource, params.format);
    await ctx.fs.writeFile(absPath, source);
    ctx.changed({ kind: 'script', path: relPath, name: params.name, action: 'created' });
    ctx.suggest(`attachScript --scene <scene> --entity <entity> --script ${relPath}`);
    return { path: relPath, language: params.language, lines: source.split('\n').length, source, formatted };
  },
});

/**
 * Validate an agent-supplied script path and return its normalized form.
 * The guard runs on the NORMALIZED path ('.'/'..' segments resolved via the
 * same joinPath the read/write below uses), never the raw string — a raw
 * `startsWith('scripts/')` check passes traversal payloads like
 * "scripts/../hearth.json" that normalize to files outside scripts/.
 * Throws INVALID_INPUT when the path escapes the project root or lands
 * outside scripts/.
 */
export function resolveScriptsPath(rawPath: string): string {
  const normalized = joinPath(rawPath);
  if (!isSafeRelativePath(rawPath) || !normalized.startsWith(SCRIPTS_DIR + '/')) {
    throw new ProjectError(`Script path must be inside ${SCRIPTS_DIR}/ (got: ${rawPath})`, 'INVALID_INPUT');
  }
  return normalized;
}

/** The formattable language for a script path, or undefined for others (e.g. .ts). */
function scriptLanguage(path: string): 'lua' | 'js' | undefined {
  if (path.endsWith('.lua')) return 'lua';
  if (path.endsWith('.js')) return 'js';
  return undefined;
}

/**
 * Run the on-save formatter over a script's source, honouring the per-call
 * `format` override / project `codeStyle.formatOnSave`. Formatting NEVER
 * blocks a save: an unformattable-but-writeable source falls back to a
 * verbatim write plus a `FORMAT_FAILED` warning. Paths with no formatter
 * (e.g. `.ts`) are written verbatim, silently. Returns the final on-disk
 * source and whether the formatter was applied.
 */
async function applyFormatting(
  ctx: CommandContext,
  path: string,
  source: string,
  wantFormat: boolean | undefined,
): Promise<{ source: string; formatted: boolean }> {
  const shouldFormat = wantFormat ?? ctx.store.project.codeStyle.formatOnSave;
  const language = scriptLanguage(path);
  if (!shouldFormat || !language) return { source, formatted: false };
  try {
    const { formatted } = await formatSource(language, source);
    return { source: formatted, formatted: true };
  } catch (err) {
    if (err instanceof FormatError) {
      ctx.warn('FORMAT_FAILED', `Could not format ${path} (saved as-is): ${err.message}`);
      return { source, formatted: false };
    }
    throw err;
  }
}

export const editScript = defineCommand({
  name: 'editScript',
  description: 'Replace the full source of an existing script file.',
  permission: 'code-edit',
  mutates: true,
  paramsSchema: z.object({
    path: z.string().min(1),
    source: z.string(),
    /** Override project codeStyle.formatOnSave for this call. */
    format: z.boolean().optional(),
  }),
  async run(ctx, params) {
    const path = resolveScriptsPath(params.path);
    const absPath = joinPath(ctx.store.root, path);
    if (!(await ctx.fs.exists(absPath))) {
      throw new ProjectError(`Script not found: ${path}. Use createScript first.`, 'NOT_FOUND');
    }
    const { source, formatted } = await applyFormatting(ctx, path, params.source, params.format);
    await ctx.fs.writeFile(absPath, source);
    ctx.changed({ kind: 'script', path, action: 'modified' });
    ctx.suggest('validateProject', 'runPlaytest <playtest> to verify behavior');
    return { path, lines: source.split('\n').length, source, formatted };
  },
});

export const checkScript = defineCommand({
  name: 'checkScript',
  description:
    'Check a script for syntax errors without saving it: pass source text directly, or path to check an ' +
    'existing project script. Read-only, never writes — pre-flight a script before editScript.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    /** Source text to check directly (bare source defaults to Lua unless language is set). */
    source: z.string().optional(),
    /** Project-relative path (must be under scripts/) to read and check instead of source. */
    path: z.string().optional(),
    language: z.enum(['lua', 'js']).optional(),
  }),
  async run(ctx, params) {
    // A plain zod .refine() here would surface as INVALID_PARAMS (thrown
    // during paramsSchema.parse, before run() is even called) rather than
    // the INVALID_INPUT code the rest of this command's validation uses
    // (matching the shared resolveScriptsPath guard) — so this is checked by hand.
    if (params.source === undefined && params.path === undefined) {
      throw new ProjectError('checkScript requires either "source" or "path"', 'INVALID_INPUT');
    }

    let source: string;
    let language: 'lua' | 'js';
    if (params.path !== undefined) {
      const path = resolveScriptsPath(params.path);
      const absPath = joinPath(ctx.store.root, path);
      if (!(await ctx.fs.exists(absPath))) {
        throw new ProjectError(`Script not found: ${path}`, 'NOT_FOUND');
      }
      source = await ctx.store.readScript(path);
      language = params.language ?? (path.endsWith('.js') ? 'js' : 'lua');
    } else {
      source = params.source as string;
      language = params.language ?? 'lua';
    }

    const diagnostics = checkScriptSource(language, source);
    return {
      valid: diagnostics.every((d) => d.severity !== 'error'),
      language,
      diagnostics,
    };
  },
});

export const formatScript = defineCommand({
  name: 'formatScript',
  description:
    'Reformat one script (path) or every .lua/.js script under scripts/ (all: true) to Hearth house style. ' +
    'Agents normally do not need this — createScript/editScript format automatically unless format:false.',
  permission: 'code-edit',
  mutates: true,
  paramsSchema: z.object({
    /** A single scripts/ file to reformat. Mutually exclusive with `all`. */
    path: z.string().optional(),
    /** Reformat every formattable script under scripts/. Mutually exclusive with `path`. */
    all: z.boolean().optional(),
  }),
  async run(ctx, params) {
    // Hand-checked (not a zod .refine) so it surfaces as INVALID_INPUT, the
    // code the rest of this file's path validation uses, not INVALID_PARAMS.
    const hasPath = params.path !== undefined;
    const hasAll = params.all === true;
    if (hasPath === hasAll) {
      throw new ProjectError('formatScript requires exactly one of "path" or "all: true"', 'INVALID_INPUT');
    }

    const targets: string[] = [];
    if (hasPath) {
      const path = resolveScriptsPath(params.path as string);
      const absPath = joinPath(ctx.store.root, path);
      if (!(await ctx.fs.exists(absPath))) {
        throw new ProjectError(`Script not found: ${path}`, 'NOT_FOUND');
      }
      // Same guard as the `all` branch: a valid, existing path with no
      // formatter (e.g. .ts) is skipped with a warning, never pushed through
      // formatJs by default.
      if (scriptLanguage(path)) {
        targets.push(path);
      } else {
        ctx.warn('SCRIPT_UNKNOWN_EXTENSION', `Skipped ${path}: no formatter for this file type.`);
      }
    } else {
      for (const path of await ctx.store.listScripts()) {
        if (scriptLanguage(path)) {
          targets.push(path);
        } else {
          ctx.warn('SCRIPT_UNKNOWN_EXTENSION', `Skipped ${path}: no formatter for this file type.`);
        }
      }
    }

    const results: Array<{ path: string; changed: boolean }> = [];
    for (const path of targets) {
      const language = scriptLanguage(path)!;
      const absPath = joinPath(ctx.store.root, path);
      const current = await ctx.store.readScript(path);
      let changed = false;
      try {
        const formatted = await formatSource(language, current);
        if (formatted.changed) {
          await ctx.fs.writeFile(absPath, formatted.formatted);
          ctx.changed({ kind: 'script', path, action: 'modified' });
          changed = true;
        }
      } catch (err) {
        if (err instanceof FormatError) {
          ctx.warn('FORMAT_FAILED', `Could not format ${path} (left unchanged): ${err.message}`);
        } else {
          throw err;
        }
      }
      results.push({ path, changed });
    }

    ctx.suggest('validateProject');
    return { results };
  },
});

/** Search results are capped at this many entries; `capped: true` signals more exist. */
const SEARCH_CAP = 500;

/** Match previews are trimmed to at most this many characters, centered on the match. */
const PREVIEW_MAX_LEN = 120;

/** Escape regex metacharacters so a plain-text query matches literally, not as a pattern. */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a simple glob to a RegExp anchored to the whole path: `*` matches
 * any run of non-slash characters, `**` matches any run including slashes,
 * `?` matches exactly one character. Everything else is matched literally.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (c === '?') {
      pattern += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      pattern += '\\' + c;
    } else {
      pattern += c;
    }
  }
  pattern += '$';
  return new RegExp(pattern);
}

/**
 * Build the shared search/replace regex: non-regex queries are escaped so
 * they match literally; a `regex: true` query is compiled as-is. Always
 * global (so callers can iterate every match on a line) plus case-
 * insensitive unless `caseSensitive`. An invalid pattern surfaces as
 * INVALID_INPUT carrying the engine's own SyntaxError message verbatim (no
 * stack) rather than throwing an unhandled SyntaxError.
 */
function buildQueryRegex(query: string, regex: boolean | undefined, caseSensitive: boolean | undefined): RegExp {
  const pattern = regex ? query : escapeRegExp(query);
  const flags = 'g' + (caseSensitive ? '' : 'i');
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new ProjectError((err as Error).message, 'INVALID_INPUT');
  }
}

/** Trim a matched line to a window of at most PREVIEW_MAX_LEN chars, centered on the match. */
function buildPreview(line: string, matchStart: number, matchLen: number): string {
  if (line.length <= PREVIEW_MAX_LEN) return line.trim();
  const center = matchStart + matchLen / 2;
  let start = Math.round(center - PREVIEW_MAX_LEN / 2);
  start = Math.max(0, Math.min(start, line.length - PREVIEW_MAX_LEN));
  return line.slice(start, start + PREVIEW_MAX_LEN).trim();
}

/** Every script path, optionally narrowed to those matching a glob (e.g. "scripts/enemies/*"). */
async function scriptsToScan(ctx: CommandContext, pathGlob: string | undefined): Promise<string[]> {
  const all = await ctx.store.listScripts();
  if (!pathGlob) return all;
  const re = globToRegExp(pathGlob);
  return all.filter((path) => re.test(path));
}

export const searchScripts = defineCommand({
  name: 'searchScripts',
  description:
    'Search script source across scripts/ for a plain-text or regex query, returning 1-based line/column plus ' +
    'a preview (≤120 chars, centered on the match) per hit. Matching is line-based — patterns never span ' +
    'multiple lines. Case-insensitive by default; set caseSensitive:true to narrow. Narrow the file set with ' +
    'pathGlob (e.g. "scripts/enemies/*"). Capped at 500 matches; capped:true means more exist beyond what was ' +
    'returned — narrow with pathGlob or a more specific query.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    query: z.string().min(1),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    pathGlob: z.string().optional(),
  }),
  async run(ctx, params) {
    const re = buildQueryRegex(params.query, params.regex, params.caseSensitive);
    const paths = await scriptsToScan(ctx, params.pathGlob);

    const matches: Array<{ path: string; line: number; column: number; preview: string }> = [];
    let total = 0;
    for (const path of paths) {
      const source = await ctx.store.readScript(path);
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          total++;
          if (matches.length < SEARCH_CAP) {
            matches.push({
              path,
              line: i + 1,
              column: m.index + 1,
              preview: buildPreview(line, m.index, m[0].length),
            });
          }
          if (m[0].length === 0) re.lastIndex++; // avoid an infinite loop on a zero-width match
        }
      }
    }

    const capped = total > SEARCH_CAP;
    if (capped) {
      ctx.suggest(`narrow with pathGlob (e.g. "scripts/enemies/*") — ${total} matches found, only the first ${SEARCH_CAP} are returned`);
    }
    return { matches, total, capped };
  },
});

export const replaceInScripts = defineCommand({
  name: 'replaceInScripts',
  description:
    'Find-and-replace across script files: plain-text or regex query, with $1-style capture-group references ' +
    'in the replacement when regex:true. Matching is line-based — patterns never span multiple lines. Case-' +
    'insensitive by default; set caseSensitive:true to narrow. Narrow the file set with pathGlob. Surgical: the ' +
    'result is written verbatim, NOT re-formatted — call formatScript afterward for cleanup. Pass dryRun:true ' +
    'first to preview per-file counts with nothing written (recommended agent workflow: dryRun, inspect, then a ' +
    'real call).',
  permission: 'code-edit',
  mutates: true,
  paramsSchema: z.object({
    query: z.string().min(1),
    replacement: z.string(),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    pathGlob: z.string().optional(),
    dryRun: z.boolean().optional(),
  }),
  async run(ctx, params) {
    const re = buildQueryRegex(params.query, params.regex, params.caseSensitive);
    const paths = await scriptsToScan(ctx, params.pathGlob);
    const applied = params.dryRun !== true;

    const changes: Array<{ path: string; count: number; preview?: string }> = [];
    for (const path of paths) {
      const source = await ctx.store.readScript(path);
      const lines = source.split('\n');
      let count = 0;
      let preview: string | undefined;

      const nextLines = lines.map((line) => {
        re.lastIndex = 0;
        const lineMatches = [...line.matchAll(re)];
        if (lineMatches.length === 0) return line;
        count += lineMatches.length;
        const replaced = line.replace(re, params.replacement);
        if (preview === undefined) {
          const first = lineMatches[0];
          // Best-effort centering: the replacement can change the line's
          // length, so this centers the preview on the ORIGINAL match
          // position rather than tracking the exact post-replace offset.
          preview = buildPreview(replaced, first.index ?? 0, first[0].length);
        }
        return replaced;
      });

      if (count === 0) continue;
      changes.push({ path, count, preview });

      if (applied) {
        const absPath = joinPath(ctx.store.root, path);
        await ctx.fs.writeFile(absPath, nextLines.join('\n'));
        ctx.changed({ kind: 'script', path, action: 'modified' });
      }
    }

    const total = changes.reduce((sum, c) => sum + c.count, 0);
    if (applied && changes.length > 0) {
      ctx.suggest('formatScript');
    }
    return { changes, total, applied };
  },
});

export const attachScript = defineCommand({
  name: 'attachScript',
  description:
    'Attach a script to an entity (adds or updates its Script component). Optional params are exposed to the script as ctx.params.',
  permission: 'code-edit',
  mutates: true,
  paramsSchema: z.object({
    scene: z.string().min(1),
    entity: z.string().min(1),
    script: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  async run(ctx, params) {
    const scene = ctx.store.getScene(params.scene);
    if (!scene) throw new ProjectError(`Scene not found: ${params.scene}`, 'NOT_FOUND');
    const entity = findEntity(scene, params.entity);
    if (!entity) throw new ProjectError(`Entity not found: ${params.entity}`, 'NOT_FOUND');

    const scripts = await ctx.store.listScripts();
    if (!scripts.includes(params.script)) {
      throw new ProjectError(
        `Script not found: ${params.script}. Known scripts: ${scripts.join(', ') || '(none; use createScript)'}`,
        'NOT_FOUND',
      );
    }
    entity.components.Script = createComponent('Script', {
      scriptPath: params.script,
      params: params.params,
    }) as typeof entity.components.Script;
    ctx.changed({ kind: 'component', id: entity.id, name: 'Script', scene: scene.id, action: 'modified' });
    return { entityId: entity.id, script: params.script, params: params.params };
  },
});
