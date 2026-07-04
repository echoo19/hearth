/**
 * Project validation: referential integrity and common mistakes, beyond the
 * per-file schema validation that happens at load time.
 */
import luaparse from 'luaparse';
import type { ProjectStore } from './project/store.js';
import { joinPath } from './fs.js';

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

/**
 * Per-script syntax check. JS scripts get the same `export default` rewrite
 * the runtime's compileScript performs, then a compile-only `new Function`
 * (never executed). Lua scripts are parsed with luaparse.
 */
async function validateScriptSyntax(store: ProjectStore, push: (issue: ValidationIssue) => void): Promise<void> {
  for (const scriptPath of await store.listScripts()) {
    const source = await store.readScript(scriptPath);
    if (scriptPath.endsWith('.js')) {
      try {
        const body = source.replace(/export\s+default/, 'module.exports =');
        // Compile-only syntax check; the factory is never invoked.
        new Function('module', 'exports', body);
      } catch (err) {
        const line = extractJsErrorLine(err);
        push({
          severity: 'error',
          code: 'SCRIPT_SYNTAX_ERROR',
          message: `Script ${scriptPath}${line ? `:${line}` : ''}: ${(err as Error).message}`,
          script: scriptPath,
          ...(line !== undefined ? { line } : {}),
        });
      }
    } else if (scriptPath.endsWith('.lua')) {
      try {
        luaparse.parse(source, { luaVersion: '5.3' });
      } catch (err) {
        const e = err as Error & { line?: number };
        const line = typeof e.line === 'number' ? e.line : undefined;
        push({
          severity: 'error',
          code: 'SCRIPT_SYNTAX_ERROR',
          message: `Script ${scriptPath}${line ? `:${line}` : ''}: ${e.message}`,
          script: scriptPath,
          ...(line !== undefined ? { line } : {}),
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

  // --- scripts (syntax) ---
  await validateScriptSyntax(store, push);

  // --- scenes / entities ---
  const scripts = new Set(await store.listScripts());

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
