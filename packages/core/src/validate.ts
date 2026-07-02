/**
 * Project validation: referential integrity and common mistakes, beyond the
 * per-file schema validation that happens at load time.
 */
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
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
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

  // --- scenes / entities ---
  const scripts = new Set(await store.listScripts());
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
      if (c.PhysicsBody && !c.Collider && c.PhysicsBody.bodyType === 'dynamic') {
        push({
          severity: 'warning',
          code: 'BODY_WITHOUT_COLLIDER',
          message: `Entity "${entity.name}" has a dynamic PhysicsBody but no Collider; it will fall forever`,
          scene: sceneId,
          entity: entity.id,
        });
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
