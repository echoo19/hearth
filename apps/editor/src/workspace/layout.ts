/**
 * Pure helpers for persisting the dockview workspace layout.
 *
 * The serialized dockview layout is wrapped in a small versioned envelope so
 * a future layout rework can bump LAYOUT_VERSION and stale saves fall back to
 * the default layout instead of crashing `fromJSON`. Everything here is
 * side-effect free (no localStorage, no DOM) so it can be unit tested in node.
 */

export const LAYOUT_VERSION = 1;

export const PANEL_IDS = [
  'hierarchy',
  'scene',
  'game',
  'code',
  'inspector',
  'assets',
  'console',
  'diff',
  'agent',
  'input',
  'live',
  'animator',
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export function isPanelId(id: string): id is PanelId {
  return (PANEL_IDS as readonly string[]).includes(id);
}

/** localStorage key for a project's layout. Prefer the project id; callers fall back to the project path. */
export function layoutStorageKey(projectId: string): string {
  return `hearth.layout.${projectId}`;
}

interface StoredLayout {
  version: number;
  layout: unknown;
}

/** Wrap a dockview `toJSON()` result in the versioned envelope, ready for localStorage. */
export function serializeLayout(layout: unknown): string {
  return JSON.stringify({ version: LAYOUT_VERSION, layout } satisfies StoredLayout);
}

/**
 * Parse and validate a stored layout string. Returns the dockview layout
 * object, or null when the value is missing, malformed, from a different
 * layout version, or references panels this editor doesn't know about.
 */
export function restoreLayout(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const stored = parsed as Partial<StoredLayout>;
  if (stored.version !== LAYOUT_VERSION) return null;
  if (!isValidDockviewLayout(stored.layout)) return null;
  return stored.layout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural sanity check on a serialized dockview layout. Not a full schema:
 * it verifies the pieces `fromJSON` dereferences unconditionally and that
 * every panel maps to a registered panel component.
 */
export function isValidDockviewLayout(layout: unknown): boolean {
  if (!isRecord(layout)) return false;
  const grid = layout.grid;
  if (!isRecord(grid) || !isRecord(grid.root)) return false;
  if (typeof grid.width !== 'number' || typeof grid.height !== 'number') return false;
  const panels = layout.panels;
  if (!isRecord(panels)) return false;
  for (const [id, state] of Object.entries(panels)) {
    if (!isRecord(state)) return false;
    const component = state.contentComponent;
    if (typeof component !== 'string' || !isPanelId(component)) return false;
    if (!isPanelId(id)) return false;
  }
  return true;
}
