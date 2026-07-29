/**
 * The skills list, for whoever is showing it.
 *
 * One tiny store rather than a slice of the app store: skills are global, they
 * change only when someone is looking at the panel, and nothing else in the
 * app needs to re-render when one is switched off.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SkillDraft, SkillRecord } from '../../server/skills';

export type { SkillDraft, SkillRecord };

interface SkillsAnswer {
  ok?: boolean;
  error?: string;
  skills?: SkillRecord[];
  root?: string;
}

/**
 * What to say when the request never came back.
 *
 * The browser's own words for this are "Failed to fetch", and for a while that
 * string was put on the screen verbatim — a sentence about an API, shown to
 * someone who was trying to write a skill. Nothing that lands here is the
 * user's doing: either the app could not reach the server it starts itself, or
 * that server answered with something that is not JSON. Both are worth saying
 * plainly, and they are worth telling apart, because only one of them is
 * likely to fix itself.
 *
 * The real error is not thrown away — every caller logs it first.
 */
export function requestFailedMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/json|unexpected token/i.test(raw)) {
    return "Hearth's own server answered with something Hearth could not read. The list may be out of date.";
  }
  return 'Hearth could not reach its own server. It may still be starting up, so try again in a moment.';
}

async function post(body: unknown): Promise<SkillsAnswer> {
  try {
    const res = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as SkillsAnswer;
  } catch (err) {
    console.error('[skills] request failed', err);
    return { ok: false, error: requestFailedMessage(err) };
  }
}

/**
 * Filter a list the way a search box should: every word has to appear
 * somewhere in the name or the description, in any order.
 */
export function matchesQuery(skill: SkillRecord, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return true;
  const haystack = `${skill.name} ${skill.id} ${skill.description}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Whose folder a skill was found in. */
export type SkillSource = 'hearth' | 'claude' | 'codex';

/**
 * `source` and `editable` are what the record says about where it came from
 * and whether Hearth may touch it. They are read off the record rather than
 * destructured from it because the discovery that fills them in is landing in
 * server/skills.ts separately: an answer from a server that predates it has
 * neither field, and the screen still has to decide what to show.
 *
 * The defaults are the cautious ones. A record that does not say it is
 * editable is treated as read-only, so a missing field can never put a Delete
 * in front of somebody; a record that does not say where it came from is
 * treated as Hearth's own, which is the only folder Hearth writes to.
 */
type Marked = SkillRecord & { source?: unknown; editable?: unknown };

export function skillSource(skill: SkillRecord): SkillSource {
  const raw = (skill as Marked).source;
  return raw === 'claude' || raw === 'codex' ? raw : 'hearth';
}

export function skillEditable(skill: SkillRecord): boolean {
  return (skill as Marked).editable === true;
}

/** The agent whose folder this is, in the words that agent is known by. */
export function skillSourceLabel(source: SkillSource): string {
  return source === 'claude' ? 'Claude Code' : source === 'codex' ? 'Codex' : 'Hearth';
}

/** A run of skills under one heading. `title` is null when it needs none. */
export interface SkillGroup {
  title: string | null;
  skills: SkillRecord[];
}

/**
 * Split the list into the groups the screen shows.
 *
 * Two, and they are a real distinction rather than a decorative one: Hearth
 * reads the skills Claude Code and Codex already have, and it reads them
 * strictly — those folders belong to those tools, so Hearth lists them, lets
 * you switch them off for its own agents, and changes nothing inside them.
 * That is exactly the line `editable` draws, so it is the line the headings
 * draw too. Anything that cannot be edited is something you installed
 * elsewhere; everything else you wrote here.
 *
 * A heading only appears when its group has something under it — one heading
 * over the whole list is a label, not a grouping.
 */
export function groupSkills(skills: readonly SkillRecord[]): SkillGroup[] {
  const groups: SkillGroup[] = [];
  const installed = skills.filter((skill) => !skillEditable(skill));
  const mine = skills.filter((skill) => skillEditable(skill));
  if (installed.length > 0) groups.push({ title: 'Installed', skills: installed });
  if (mine.length > 0) groups.push({ title: 'Created by me', skills: mine });
  return groups;
}

/** "3 files · edited today", or as much of it as is true. */
export function skillMeta(skill: SkillRecord, now = Date.now()): string {
  const parts: string[] = [];
  if (skill.files > 1) parts.push(`${skill.files} files`);
  const age = now - new Date(skill.updatedAt).getTime();
  if (Number.isFinite(age) && age >= 0) {
    const days = Math.floor(age / 86_400_000);
    parts.push(days === 0 ? 'edited today' : days === 1 ? 'edited yesterday' : `edited ${days} days ago`);
  }
  return parts.join(' · ');
}

export interface SkillsApi {
  skills: SkillRecord[];
  root: string;
  loading: boolean;
  /**
   * Whether the list has been read at all yet — false only before the first
   * answer, whatever that answer was.
   *
   * `loading` cannot carry this: it is false before the effect that reads has
   * run, so an empty list plus `loading: false` is BOTH "you have no skills"
   * and "nobody has looked", and the screen was drawing the first of those
   * over the second on every open.
   */
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  create(draft: SkillDraft): Promise<boolean>;
  update(id: string, draft: SkillDraft): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  importFolder(name: string, files: { relPath: string; data: string }[]): Promise<boolean>;
  /** The markdown behind one skill, for the editor. */
  source(id: string): Promise<SkillDraft | null>;
}

export function useSkills(open: boolean): SkillsApi {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((answer: SkillsAnswer): boolean => {
    if (answer.skills) setSkills(answer.skills);
    if (answer.root) setRoot(answer.root);
    setError(answer.ok === false ? (answer.error ?? 'That did not work.') : null);
    return answer.ok !== false;
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch('/api/skills');
      adopt((await res.json()) as SkillsAnswer);
    } catch (err) {
      console.error('[skills] could not read the list', err);
      setError(requestFailedMessage(err));
    } finally {
      setLoading(false);
      // Read, even if what came back was a failure. "We looked and could not"
      // is still an answer, and the screen says so with the error rather than
      // sitting on a spinner forever.
      setLoaded(true);
    }
  }, [adopt]);

  // Re-read on open rather than on mount: a skill the agent just wrote for
  // itself should be there the next time the panel is looked at.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  return {
    skills,
    root,
    loading,
    loaded,
    error,
    refresh,
    create: async (draft) => adopt(await post({ action: 'create', draft })),
    update: async (id, draft) => adopt(await post({ action: 'update', id, draft })),
    remove: async (id) => adopt(await post({ action: 'delete', id })),
    setEnabled: async (id, enabled) => {
      // Optimistic: a switch that waits for a round trip feels broken.
      setSkills((current) => current.map((skill) => (skill.id === id ? { ...skill, enabled } : skill)));
      adopt(await post({ action: 'enable', id, enabled }));
    },
    importFolder: async (name, files) => adopt(await post({ action: 'import', name, files })),
    source: async (id) => {
      try {
        const res = await fetch(`/api/skills/source?id=${encodeURIComponent(id)}`);
        const body = (await res.json()) as { ok?: boolean; draft?: SkillDraft };
        return body.ok && body.draft ? body.draft : null;
      } catch {
        return null;
      }
    },
  };
}
