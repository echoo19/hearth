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
 * edits carry no journal detail in core today, so they land on the structural
 * fallback (accepted: badge, never a guessed patch); the valueless-patch path
 * is honored only when a detail explicitly records {scene,entity,property}.
 */
export function classifyJournal(entry: JournalEntry): LiveAction[] {
  if (entry.source === 'editor') return [{ kind: 'none' }];
  if (!entry.ok) return [{ kind: 'none' }];

  const reload = reloadActions(entry.command, entry.detail);
  if (reload) return reload;

  const detail = entry.detail;
  if (
    detail &&
    typeof detail.scene === 'string' &&
    typeof detail.entity === 'string' &&
    typeof detail.property === 'string'
  ) {
    return [{ kind: 'patch', scene: detail.scene, entity: detail.entity, property: detail.property, hasValue: false }];
  }

  return fallback(entry.command);
}
