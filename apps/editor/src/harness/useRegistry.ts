/**
 * The harness registry, client side.
 *
 * Small on purpose: one module-level cache keyed by project folder, one fetch
 * in flight at a time, and a React subscription over it. It deliberately does
 * NOT live in the app store — the registry is one sidebar's concern, it is
 * read by exactly the two sections that render it, and nothing else in the app
 * has an opinion about it yet. When something does (a connector that actually
 * connects), that is the moment to promote it, not before.
 *
 * Mutations are optimistic: the row appears the instant you save it, then the
 * server's merged answer replaces the guess. A failed write puts the previous
 * state back and surfaces the message, rather than leaving a row that looks
 * saved and isn't.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  HARNESS_ROUTE,
  slugifyEntryId,
  uniqueEntryId,
  type ConnectorEntry,
  type ConnectorKind,
  type HarnessBuiltinIds,
  type HarnessCollection,
  type HarnessRegistry,
  type HarnessRegistryPayload,
  type SkillEntry,
} from './registry';

export interface RegistryState {
  registry: HarnessRegistry;
  builtins: HarnessBuiltinIds;
  /** A first load is in flight and there is nothing to show yet. */
  loading: boolean;
  /** The last failure, in one line, or null. */
  error: string | null;
}

const IDLE: RegistryState = {
  registry: { connectors: [], skills: [] },
  builtins: { connectors: [], skills: [] },
  loading: false,
  error: null,
};

const states = new Map<string, RegistryState>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();

function getState(project: string): RegistryState {
  return states.get(project) ?? IDLE;
}

function setState(project: string, next: RegistryState): void {
  states.set(project, next);
  for (const listener of listeners.get(project) ?? []) listener();
}

function subscribe(project: string, listener: () => void): () => void {
  const set = listeners.get(project) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(project, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(project);
  };
}

/** Test seam: drop every cached folder so suites start from a known state. */
export function resetHarnessRegistryCache(): void {
  states.clear();
  listeners.clear();
  inflight.clear();
}

function messageFrom(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error.trim() !== '' ? error : fallback;
}

/**
 * A failure someone wrote the words for — the server's own explanation, or one
 * of the fallbacks below. Everything else caught here is the browser talking,
 * and the browser says things like "Failed to fetch".
 */
class RegistryError extends Error {}

/**
 * What the rail shows when a read or write fails. An explanation we wrote goes
 * through unchanged; anything else becomes the plain sentence the caller
 * supplied, and the original goes to the console for whoever is debugging it.
 */
function humanError(err: unknown, fallback: string): string {
  if (err instanceof RegistryError) return err.message;
  console.error('harness registry: request failed', err);
  return fallback;
}

/** Read the folder's registry. Coalesced: a second call while one is in flight joins it. */
export function loadRegistry(project: string): Promise<void> {
  const running = inflight.get(project);
  if (running) return running;
  const current = getState(project);
  setState(project, { ...current, loading: true, error: null });
  const run = (async () => {
    try {
      const res = await fetch(`${HARNESS_ROUTE}?project=${encodeURIComponent(project)}`);
      const body = (await res.json()) as Partial<HarnessRegistryPayload> & { ok?: boolean };
      if (!res.ok || !body.ok || !body.registry || !body.builtins) {
        throw new RegistryError(messageFrom(body, 'Could not read this folder’s connectors and skills.'));
      }
      setState(project, { registry: body.registry, builtins: body.builtins, loading: false, error: null });
    } catch (err) {
      const error = humanError(
        err,
        'Could not read this folder’s connectors and skills. Hearth’s own server did not answer.',
      );
      setState(project, { ...getState(project), loading: false, error });
    } finally {
      inflight.delete(project);
    }
  })();
  inflight.set(project, run);
  return run;
}

interface MutationBody {
  project: string;
  action: 'upsert' | 'remove';
  collection: HarnessCollection;
  entry?: Record<string, unknown>;
  id?: string;
}

/** What a write answers with: the failure message travels with the failure. */
export type HarnessWrite = { ok: true } | { ok: false; error: string };

/**
 * Apply one change: show it immediately, send it, then take the server's
 * merged registry as the truth. A failed write puts back exactly what was on
 * screen before and hands the message to the caller, so the form that tried
 * can say what went wrong where it happened.
 */
async function mutate(project: string, body: MutationBody, optimistic: HarnessRegistry): Promise<HarnessWrite> {
  const before = getState(project);
  setState(project, { ...before, registry: optimistic, error: null });
  try {
    const res = await fetch(HARNESS_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await res.json()) as Partial<HarnessRegistryPayload> & { ok?: boolean };
    if (!res.ok || !payload.ok || !payload.registry || !payload.builtins) {
      throw new RegistryError(messageFrom(payload, 'That change could not be saved.'));
    }
    setState(project, {
      registry: payload.registry,
      builtins: payload.builtins,
      loading: false,
      error: null,
    });
    return { ok: true };
  } catch (err) {
    const error = humanError(err, 'That change could not be saved. Hearth’s own server did not answer.');
    setState(project, { ...before, error });
    return { ok: false, error };
  }
}

export interface ConnectorDraft {
  name: string;
  /** `builtin` is the server's word, never a client's. */
  kind: Exclude<ConnectorKind, 'builtin'>;
  /** The one optional field the add form collects, keyed by kind. */
  command?: string;
  url?: string;
}

export interface SkillDraft {
  name: string;
  description?: string;
}

export interface HarnessRegistryApi extends RegistryState {
  /** Server-owned rows: no rename, no remove. */
  isBuiltin(collection: HarnessCollection, id: string): boolean;
  addConnector(draft: ConnectorDraft): Promise<HarnessWrite>;
  addSkill(draft: SkillDraft): Promise<HarnessWrite>;
  rename(collection: HarnessCollection, id: string, name: string): Promise<HarnessWrite>;
  remove(collection: HarnessCollection, id: string): Promise<HarnessWrite>;
  refresh(): Promise<void>;
}

const NOOP_API_STATE = IDLE;

export function useHarnessRegistry(project: string | null): HarnessRegistryApi {
  const key = project ?? '';
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => (key === '' ? () => {} : subscribe(key, listener)), [key]),
    useCallback(() => (key === '' ? NOOP_API_STATE : getState(key)), [key]),
    useCallback(() => NOOP_API_STATE, []),
  );

  useEffect(() => {
    if (key !== '') void loadRegistry(key);
  }, [key]);

  return useMemo<HarnessRegistryApi>(() => {
    const guard = async (): Promise<HarnessWrite> => ({ ok: false, error: 'No folder is open.' });
    if (key === '') {
      return {
        ...state,
        isBuiltin: () => true,
        addConnector: guard,
        addSkill: guard,
        rename: guard,
        remove: guard,
        refresh: async () => {},
      };
    }
    const { registry, builtins } = state;
    return {
      ...state,
      isBuiltin: (collection, id) => builtins[collection].includes(id),
      addConnector: (draft) => {
        const id = uniqueEntryId(slugifyEntryId(draft.name), registry.connectors.map((c) => c.id));
        const config: Record<string, unknown> = {};
        if (draft.kind === 'mcp' && draft.command?.trim()) config.command = draft.command.trim();
        if (draft.kind === 'engine' && draft.url?.trim()) config.url = draft.url.trim();
        const entry: ConnectorEntry = { id, name: draft.name.trim(), kind: draft.kind, status: 'available' };
        if (Object.keys(config).length > 0) entry.config = config;
        return mutate(
          key,
          {
            project: key,
            action: 'upsert',
            collection: 'connectors',
            entry: { name: entry.name, kind: entry.kind, ...(entry.config ? { config: entry.config } : {}) },
          },
          { ...registry, connectors: [...registry.connectors, entry] },
        );
      },
      addSkill: (draft) => {
        const id = uniqueEntryId(slugifyEntryId(draft.name), registry.skills.map((s) => s.id));
        const entry: SkillEntry = {
          id,
          name: draft.name.trim(),
          source: 'project',
          status: 'coming-soon',
        };
        const description = draft.description?.trim();
        if (description) entry.description = description;
        return mutate(
          key,
          {
            project: key,
            action: 'upsert',
            collection: 'skills',
            entry: { name: entry.name, ...(description ? { description } : {}) },
          },
          { ...registry, skills: [...registry.skills, entry] },
        );
      },
      rename: (collection, id, name) => {
        const next = name.trim();
        const optimistic: HarnessRegistry =
          collection === 'connectors'
            ? { ...registry, connectors: registry.connectors.map((c) => (c.id === id ? { ...c, name: next } : c)) }
            : { ...registry, skills: registry.skills.map((s) => (s.id === id ? { ...s, name: next } : s)) };
        return mutate(key, { project: key, action: 'upsert', collection, entry: { id, name: next } }, optimistic);
      },
      remove: (collection, id) => {
        const optimistic: HarnessRegistry =
          collection === 'connectors'
            ? { ...registry, connectors: registry.connectors.filter((c) => c.id !== id) }
            : { ...registry, skills: registry.skills.filter((s) => s.id !== id) };
        return mutate(key, { project: key, action: 'remove', collection, id }, optimistic);
      },
      refresh: () => loadRegistry(key),
    };
  }, [key, state]);
}
