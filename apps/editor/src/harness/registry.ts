/**
 * The harness registry — what this Hearth can reach, and what it knows how to do.
 *
 * Hearth is becoming its own harness: connectors are the things it can talk to
 * (a web game, an engine, an MCP server) and skills are the things it knows how
 * to do with them (playtesting, and whatever comes next). Both are *registered*
 * before they are *wired* — a folder can record a connector today and have the
 * app grow into consuming it later, which is why an entry carries an honest
 * `status` rather than pretending everything listed is live.
 *
 * Today only the BUILT-IN rows are wired. A connector a user adds is stored and
 * listed and nothing more: it does not reach the agent, the chat surface or the
 * probe. This is not the place a user brings their own agent — see the note at
 * the top of server/harnessRegistry.ts for where that actually lives.
 *
 * This module is the shared vocabulary: types, the merge rule, and the two
 * pure string/storage helpers the sidebar needs. Deliberately dependency-free
 * (no zod, no React, no fs) so the server (server/harnessRegistry.ts), the
 * client hook (useRegistry.ts) and the tests can all import it without
 * dragging anything of their own into the others' bundle.
 */

/** Where a connector comes from. `builtin` is reserved for server-defined rows. */
export type ConnectorKind = 'builtin' | 'mcp' | 'engine';

/**
 * How true a row is, in three honest steps:
 *   active      — wired up and consumed right now
 *   available   — registered here, nothing consumes it yet
 *   coming-soon — named, not built
 */
export type ConnectorStatus = 'active' | 'available' | 'coming-soon';

export interface ConnectorEntry {
  id: string;
  name: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  /** One short line: what this connector does, in the user's words. */
  detail?: string;
  /** Free-form settings (command, url, …). Recorded, not yet interpreted. */
  config?: Record<string, unknown>;
}

export type SkillSource = 'builtin' | 'project';
export type SkillStatus = 'active' | 'coming-soon';

export interface SkillEntry {
  id: string;
  name: string;
  description?: string;
  source: SkillSource;
  status: SkillStatus;
}

export interface HarnessRegistry {
  connectors: ConnectorEntry[];
  skills: SkillEntry[];
}

/** Which rows the server owns — the client offers Rename/Remove on the rest. */
export interface HarnessBuiltinIds {
  connectors: string[];
  skills: string[];
}

/** What GET/POST /api/harness/registry answer with. */
export interface HarnessRegistryPayload {
  registry: HarnessRegistry;
  builtins: HarnessBuiltinIds;
}

/** Where a project's user-registered entries live, relative to its root. */
export const HARNESS_FILE = '.hearth/harness.json';

/** The one route this module's server half serves. */
export const HARNESS_ROUTE = '/api/harness/registry';

/** The two collections, in the order the sidebar shows them. */
export const HARNESS_COLLECTIONS = ['connectors', 'skills'] as const;
export type HarnessCollection = (typeof HARNESS_COLLECTIONS)[number];

/** Kinds a user may register. `builtin` is not one of them — the server owns it. */
export const USER_CONNECTOR_KINDS: readonly ConnectorKind[] = ['mcp', 'engine'];

export const EMPTY_REGISTRY: HarnessRegistry = { connectors: [], skills: [] };

/**
 * Built-ins first, then whatever the folder registered, and a user entry can
 * never shadow a built-in id — otherwise a project file could rewrite what
 * "Playtesting" means (and, worse, claim `active` for something nothing runs).
 * Order inside each half is preserved: built-ins as declared, user entries as
 * added, so a row never moves under the pointer.
 */
export function mergeRegistry(builtins: HarnessRegistry, user: HarnessRegistry): HarnessRegistry {
  const connectorIds = new Set(builtins.connectors.map((c) => c.id));
  const skillIds = new Set(builtins.skills.map((s) => s.id));
  return {
    connectors: [...builtins.connectors, ...user.connectors.filter((c) => !connectorIds.has(c.id))],
    skills: [...builtins.skills, ...user.skills.filter((s) => !skillIds.has(s.id))],
  };
}

/**
 * The word for a status, for screen readers and the `soon` tag. Sentence case:
 * these are read, not shouted — there are no badges here.
 */
export function statusLabel(status: ConnectorStatus | SkillStatus): string {
  if (status === 'active') return 'Active';
  if (status === 'coming-soon') return 'Not available yet';
  return 'Registered';
}

/**
 * A stable, filename-safe id from a display name. Ids are minted server-side;
 * this lives here so the client can mint the same shape for the optimistic row
 * it shows while the POST is in flight.
 */
export function slugifyEntryId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug === '' ? 'entry' : slug;
}

/** `base`, or `base-2`, `base-3`… — the first id `taken` doesn't already hold. */
export function uniqueEntryId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Section collapse state
//
// Persisted the same way the rail's own collapsed state is (a localStorage
// flag, read once at mount): a fold you opened yesterday should still be open
// today, and it is not worth a round trip to remember it.
// ---------------------------------------------------------------------------

export function sectionStorageKey(collection: HarnessCollection): string {
  return `hearth:harness:${collection}`;
}

/** Sections start open — a fold nobody has touched should show its contents. */
export function readSectionOpen(collection: HarnessCollection): boolean {
  try {
    return localStorage.getItem(sectionStorageKey(collection)) !== '0';
  } catch {
    return true;
  }
}

export function writeSectionOpen(collection: HarnessCollection, open: boolean): void {
  try {
    localStorage.setItem(sectionStorageKey(collection), open ? '1' : '0');
  } catch {
    /* private mode / storage disabled: the fold just won't be remembered */
  }
}
