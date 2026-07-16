/**
 * Pure helpers for persisting the dockview workspace layout.
 *
 * The serialized dockview layout is wrapped in a small versioned envelope so
 * a future layout rework can bump LAYOUT_VERSION. Stale saves from unknown
 * versions fall back to the default layout instead of crashing `fromJSON`;
 * v1 envelopes are migrated rather than discarded (see `RestoredLayout`).
 * Everything here is side-effect free (no localStorage, no DOM) so it can be
 * unit tested in node.
 */

export const LAYOUT_VERSION = 2;

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
  'gameSettings',
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

export interface RestoredLayout {
  layout: unknown;
  /**
   * True when the envelope predates v2 — the Agent panel's move from the
   * bottom dock to its own right-hand dock. After `fromJSON` the caller must
   * relocate the agent panel (Workspace's `relocateAgentPanel`) so a v1 save
   * keeps the user's layout but the agent lands in the new dock.
   */
  migrateAgentDock: boolean;
}

/**
 * Parse and validate a stored layout string. Returns the dockview layout
 * object plus a migration flag, or null when the value is missing,
 * malformed, from an unknown layout version, or references panels this
 * editor doesn't know about. v1 envelopes are accepted (not discarded) with
 * `migrateAgentDock: true` so the caller can relocate the Agent panel.
 */
export function restoreLayout(raw: string | null | undefined): RestoredLayout | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const stored = parsed as Partial<StoredLayout>;
  if (stored.version !== 1 && stored.version !== LAYOUT_VERSION) return null;
  if (!isValidDockviewLayout(stored.layout)) return null;
  return { layout: stored.layout, migrateAgentDock: stored.version === 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The slice of the dockview api that {@link ensureGroupsActive} touches. Kept
 * structural (not the concrete `DockviewApi`) so this stays a pure, DOM-free
 * helper the node test suite can exercise directly. The real `DockviewApi`
 * satisfies it.
 */
export interface GroupsActiveApi {
  readonly groups: ReadonlyArray<{
    readonly panels: ReadonlyArray<{ readonly api: { setActive(): void } }>;
    readonly activePanel: unknown;
  }>;
  readonly activePanel: { readonly api: { setActive(): void } } | undefined;
}

/**
 * Guarantee every non-empty dockview group has an active panel.
 *
 * Dockview renders the watermark ("All panels are closed") into any group that
 * holds panels but has no active one. That state is easy to fall into: a
 * group whose only/leading panels were all added `inactive` never gets an
 * active panel, and older persisted layouts saved that condition as
 * `activeView: null`, so it survives a `fromJSON` restore too. The result was
 * the watermark showing in the Hierarchy, Inspector, and bottom groups on
 * essentially every project open even though their tabs existed.
 *
 * Activating a headless group's first panel evicts the watermark. Each
 * activation also makes that panel's group the dock-wide active one, so we
 * snapshot the previously active panel and re-activate it last. That's purely
 * cosmetic — it keeps the expected group (e.g. the Scene) styled as active
 * instead of whichever group the sweep touched last; editor keybinds are
 * window-global and don't depend on dockview's active panel.
 */
export function ensureGroupsActive(api: GroupsActiveApi): void {
  const focused = api.activePanel;
  for (const group of api.groups) {
    if (group.panels.length > 0 && !group.activePanel) {
      group.panels[0].api.setActive();
    }
  }
  focused?.api.setActive();
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
