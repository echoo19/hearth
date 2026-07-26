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

async function post(body: unknown): Promise<SkillsAnswer> {
  try {
    const res = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as SkillsAnswer;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
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
      setError((err as Error).message);
    } finally {
      setLoading(false);
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
