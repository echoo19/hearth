/**
 * Per-project persistence for which Inspector component cards are collapsed
 * (INSPECTOR-4 / L-037). Kept out of Inspector.tsx so the set/localStorage
 * logic stays unit-testable without a DOM (same idiom as vec2List.ts /
 * stringList.ts). Collapse state is keyed by component TYPE, not per entity —
 * folding a Transform card keeps every entity's Transform folded while you
 * browse, which is the ergonomic the audit asked for.
 */

const KEY_PREFIX = 'hearth:inspectorCollapsed:';

/** localStorage key scoping collapse state to a single project (path). */
export function collapseStorageKey(project: string | null): string {
  return `${KEY_PREFIX}${project ?? '_'}`;
}

/** Read the persisted set of collapsed component types for a project. */
export function loadCollapsed(project: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(collapseStorageKey(project));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

/** Persist the set of collapsed component types for a project. */
export function saveCollapsed(project: string | null, collapsed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(collapseStorageKey(project), JSON.stringify([...collapsed]));
  } catch {
    // Private-mode / quota failures are non-fatal — collapse is a convenience.
  }
}

/** New set with `type` toggled in/out of the collapsed set. */
export function toggleCollapsed(collapsed: ReadonlySet<string>, type: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(type)) next.delete(type);
  else next.add(type);
  return next;
}

/** True when every one of `types` is currently collapsed (and there is at least one). */
export function allCollapsed(collapsed: ReadonlySet<string>, types: readonly string[]): boolean {
  return types.length > 0 && types.every((t) => collapsed.has(t));
}

/**
 * Collapse-all / expand-all over the current entity's component `types`.
 * Expand-all removes only those types (leaving other projects' persisted
 * collapse state untouched); collapse-all adds them all.
 */
export function setAllCollapsed(
  collapsed: ReadonlySet<string>,
  types: readonly string[],
  collapse: boolean,
): Set<string> {
  const next = new Set(collapsed);
  for (const t of types) {
    if (collapse) next.add(t);
    else next.delete(t);
  }
  return next;
}
