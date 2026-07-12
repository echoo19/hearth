/**
 * Live-update classifier (Wave H). Pure, unit-testable core of the editor's
 * iteration loop: turn a mutation — whether run locally through exec() or
 * observed on the WS journal from an external tool (CLI/MCP) — into the set of
 * live actions the store applies against the running preview.
 *
 * Three outcomes matter:
 *  - patch:      live-set a component property without a restart (Inspector
 *                tweaks, arrow-key nudges, moveEntity position).
 *  - reload:     hot-reload a script, preserving vars/timers/tweens (editScript,
 *                formatScript, replaceInScripts).
 *  - structural: something the runtime can't patch in place (new/removed
 *                entities, components, settings, reparents) — surface the
 *                "Scene changed — Restart" badge instead of guessing.
 *  - none:       nothing to do (read-only commands; entries that already came
 *                through exec()).
 *
 * The store owns the side effects (getGameView().patchComponent / reloadScript,
 * fetching source, the badge). This module only decides.
 */
import { extractJournalDetail } from '@hearth/core';
import type { JournalEntry } from './types';

export type LiveAction =
  | { kind: 'patch'; scene: string; entity: string; property: string; value?: unknown; hasValue: boolean }
  | { kind: 'reload'; path: string }
  | { kind: 'asm-reload'; assetId: string }
  | { kind: 'structural' }
  | { kind: 'none' };

/**
 * Read-only core commands: they never change the running scene, so a live
 * mutation observed for them is a no-op. Kept as an explicit set (mirrors the
 * `permission: 'read-only'` commands in packages/core/src/commands) rather than
 * a name heuristic, so a new read-only command is a deliberate one-line add.
 */
const READ_ONLY = new Set([
  'inspectProject',
  'inspectScene',
  'inspectEntity',
  'inspectComponents',
  'inspectAssets',
  'inspectScripts',
  'inspectApi',
  'inspectPath',
  'readScript',
  'checkScript',
  'searchScripts',
  'listScenes',
  'listHistory',
  'listJournal',
  'listPlaytests',
  'runScene',
  'runPlaytest',
  'validateProject',
  'diffProject',
]);

/** Reload actions for the script-editing commands, from a journal-style detail. */
function reloadActions(command: string, detail: Record<string, unknown> | undefined): LiveAction[] | null {
  if (command === 'editScript' || command === 'createScript') {
    // createScript is handled as structural below (a brand-new file nothing
    // references yet can't meaningfully hot-reload); only editScript reloads.
    if (command !== 'editScript') return null;
    const path = detail?.path;
    return typeof path === 'string' ? [{ kind: 'reload', path }] : [{ kind: 'structural' }];
  }
  if (command === 'formatScript' || command === 'replaceInScripts') {
    const paths = detail?.paths;
    if (!Array.isArray(paths)) return [{ kind: 'structural' }];
    return paths.filter((p): p is string => typeof p === 'string').map((path) => ({ kind: 'reload', path }));
  }
  return null;
}

/**
 * Commands whose only editor effect is refreshing the Assets panel (which the
 * journal feed already drives): live-mirroring them into the running preview is
 * a no-op. Kept explicit — they aren't `read-only` (they mutate the project),
 * so without this they'd fall through to the structural badge.
 */
const ASSETS_PANEL_ONLY = new Set(['importAssets', 'createStateMachineAsset']);

/**
 * Export commands write build artifacts to disk but never change the running
 * scene, so a live mutation observed for them is a no-op. Kept explicit (not
 * folded into READ_ONLY — they aren't read-only, they mutate the filesystem)
 * so they resolve to `none` rather than falling through to the structural
 * restart badge.
 */
const EXPORT_ONLY = new Set(['exportDesktop', 'exportWeb']);

/**
 * Wave I command → live action, shared by the local and journal paths so an
 * external agent behaves identically to an in-editor exec. `target` is the
 * {scene, entity} the command wrote (when it records one); `assetId` is the
 * state-machine asset an ASM update touched. Returns null when `command` is not
 * a Wave I command (callers fall through to their own logic / `fallback`).
 */
function waveIActions(
  command: string,
  target: { scene: string; entity: string } | undefined,
  assetId: string | undefined,
  revert: { component?: string; path?: string } | undefined,
): LiveAction[] | null {
  if (ASSETS_PANEL_ONLY.has(command)) return [{ kind: 'none' }];
  if (command === 'updateStateMachineAsset') {
    // Hot-swap the parsed ASM doc and reset only entities bound to it. Without
    // an asset id there's nothing to target — fail safe to the restart badge.
    return assetId ? [{ kind: 'asm-reload', assetId }] : [{ kind: 'structural' }];
  }
  if (command === 'setTileAutotile') {
    // Autotile rebinds the whole Tilemap.tileAssets map; re-read + patch it as a
    // single valueless property (the same resolve-after-refresh lane as paints).
    return target
      ? [{ kind: 'patch', scene: target.scene, entity: target.entity, property: 'Tilemap.tileAssets', hasValue: false }]
      : [{ kind: 'structural' }];
  }
  if (command === 'revertPrefabOverride') {
    if (!target) return [{ kind: 'structural' }];
    // Scope the resync to exactly what the revert touched (the detail records
    // it): a single field (`component.path`), a whole component (`component`),
    // or — when neither is given — every override on the entity (''). Re-read
    // and patch that scope from the refreshed authored scene, so we never stomp
    // runtime state on components the revert didn't affect. All valueless.
    let property = '';
    if (revert?.component) property = revert.path ? `${revert.component}.${revert.path}` : revert.component;
    return [{ kind: 'patch', scene: target.scene, entity: target.entity, property, hasValue: false }];
  }
  return null;
}

/** Terminal classification for a command with no patch/reload mapping. */
function fallback(command: string): LiveAction[] {
  return READ_ONLY.has(command) ? [{ kind: 'none' }] : [{ kind: 'structural' }];
}

/**
 * Classify a just-succeeded local exec. `params` are always present for a
 * local command, so property edits carry their value directly (no post-refresh
 * resolution needed) and local live-patching works fully regardless of what the
 * journal happens to record. `data` is the command's result payload.
 */
export function classifyLocal(command: string, params: Record<string, unknown>, data: unknown): LiveAction[] {
  if (EXPORT_ONLY.has(command)) return [{ kind: 'none' }];
  if (command === 'setComponentProperty') {
    return [
      {
        kind: 'patch',
        scene: String(params.scene),
        entity: String(params.entity),
        property: String(params.property),
        value: params.value,
        hasValue: true,
      },
    ];
  }
  if (command === 'setProperties') {
    const properties = (params.properties ?? {}) as Record<string, unknown>;
    return Object.entries(properties).map(([property, value]) => ({
      kind: 'patch',
      scene: String(params.scene),
      entity: String(params.entity),
      property,
      value,
      hasValue: true,
    }));
  }
  if (command === 'moveEntity') {
    // A reparent (parent set, even to null) is a hierarchy change the runtime
    // can't patch in place; a pure position move is a Transform.position patch.
    if (params.parent !== undefined) return [{ kind: 'structural' }];
    if (params.position && typeof params.position === 'object') {
      return [
        {
          kind: 'patch',
          scene: String(params.scene),
          entity: String(params.entity),
          property: 'Transform.position',
          value: params.position,
          hasValue: true,
        },
      ];
    }
    return [{ kind: 'none' }];
  }

  // Wave I commands (identical mapping to the journal path). Local params carry
  // the target directly; the ASM asset id comes off the command's result data.
  const wave = waveIActions(
    command,
    typeof params.scene === 'string' && typeof params.entity === 'string'
      ? { scene: params.scene, entity: params.entity }
      : undefined,
    typeof (data as { assetId?: unknown } | null)?.assetId === 'string'
      ? ((data as { assetId: string }).assetId)
      : undefined,
    {
      component: typeof params.component === 'string' ? params.component : undefined,
      path: typeof params.path === 'string' ? params.path : undefined,
    },
  );
  if (wave) return wave;

  // Script edits: reuse the exact detail extraction the journal uses, so local
  // and external reloads agree on which paths changed. Prefer the post-format
  // path from the result over the raw params path.
  const detail = extractJournalDetail(command, data);
  const reload = reloadActions(command, detail);
  if (reload) {
    if (command === 'editScript' && (!reload[0] || reload[0].kind !== 'reload')) {
      const path = params.path;
      if (typeof path === 'string') return [{ kind: 'reload', path }];
    }
    return reload;
  }

  return fallback(command);
}

/**
 * Classify an external journal entry (CLI/MCP) pushed over the WS channel.
 * Editor-sourced entries produce nothing — they already ran through exec() and
 * were live-applied there. Failed commands changed nothing to mirror. Property
 * writes carry their TARGET in the journal detail ({scene,entity,property}, or
 * a setProperties key list) but never the value, so they become valueless
 * patches: the store resolves the current value with one read-only query after
 * the refresh, then patches — identical live behavior to an Inspector edit.
 * Entries from older journals with no detail fall back to structural (badge,
 * never a guessed patch).
 */
export function classifyJournal(entry: JournalEntry): LiveAction[] {
  if (entry.source === 'editor') return [{ kind: 'none' }];
  if (!entry.ok) return [{ kind: 'none' }];
  if (EXPORT_ONLY.has(entry.command)) return [{ kind: 'none' }];

  const reload = reloadActions(entry.command, entry.detail);
  if (reload) return reload;

  const detail = entry.detail;

  // Wave I commands (identical mapping to the local path). Everything the
  // classification needs is in the journal detail: the {scene,entity} target,
  // or the ASM asset id for an update.
  const wave = waveIActions(
    entry.command,
    detail && typeof detail.scene === 'string' && typeof detail.entity === 'string'
      ? { scene: detail.scene, entity: detail.entity }
      : undefined,
    detail && typeof detail.assetId === 'string' ? detail.assetId : undefined,
    {
      component: detail && typeof detail.component === 'string' ? detail.component : undefined,
      path: detail && typeof detail.path === 'string' ? detail.path : undefined,
    },
  );
  if (wave) return wave;

  if (detail && typeof detail.scene === 'string' && typeof detail.entity === 'string') {
    const { scene, entity } = detail as { scene: string; entity: string };
    // Single-property target (setComponentProperty, or any command recording one).
    if (typeof detail.property === 'string') {
      return [{ kind: 'patch', scene, entity, property: detail.property, hasValue: false }];
    }
    // Multi-property key list (setProperties) — one valueless patch per key.
    if (Array.isArray(detail.properties) && detail.properties.every((p) => typeof p === 'string')) {
      return (detail.properties as string[]).map((property) => ({
        kind: 'patch',
        scene,
        entity,
        property,
        hasValue: false,
      }));
    }
  }

  return fallback(entry.command);
}
