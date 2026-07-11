/**
 * Project validation: referential integrity and common mistakes, beyond the
 * per-file schema validation that happens at load time.
 */
import { z } from 'zod';
import luaparse from 'luaparse';
import { readJson, type ProjectStore } from './project/store.js';
import { joinPath } from './fs.js';
import { AnimationDataSchema, PrefabDataSchema, type PrefabData } from './schema/project.js';
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
        'polygon Collider is not convex. Hearth supports convex polygons only — ' +
        'split concave shapes into multiple entities, each with its own convex polygon Collider',
    });
  }
  return issues;
}

/**
 * Best-effort line extraction for a `new Function(...)` SyntaxError. V8
 * reports the failing position in the error stack as `<anonymous>:LINE:COL`,
 * where LINE counts from the synthesized `function anonymous(...) {` header —
 * two lines above the script body.
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

/**
 * Per-script syntax check across the whole project: thin wrapper around
 * `checkScriptSource` that maps its diagnostics into `ValidationIssue`
 * pushes (same message format, codes, and line handling as before the
 * extraction).
 */
async function validateScriptSyntax(store: ProjectStore, push: (issue: ValidationIssue) => void): Promise<void> {
  for (const scriptPath of await store.listScripts()) {
    const source = await store.readScript(scriptPath);
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
        for (const [ch, tileAssetId] of Object.entries(c.Tilemap.tileAssets)) {
          if (!assetIds.has(tileAssetId)) {
            push({
              severity: 'error',
              code: 'PREFAB_ASSET_NOT_FOUND',
              message: `Prefab "${asset.name}" (${asset.id}) entity "${entity.name}" Tilemap maps '${ch}' to unknown asset ${tileAssetId}`,
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
        for (const [ch, assetId] of Object.entries(c.Tilemap.tileAssets)) {
          if (!assetIds.has(assetId)) {
            push({
              severity: 'error',
              code: 'MISSING_TILE_ASSET',
              message: `Tilemap on "${entity.name}" maps '${ch}' to unknown asset ${assetId}`,
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
