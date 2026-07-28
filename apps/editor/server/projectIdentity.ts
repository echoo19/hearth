/**
 * What a project looks like in the rail: one mark, one colour.
 *
 * Kept in `.hearth/project.json` rather than in `app.json`, which holds API
 * keys and is written 0600 for that reason. Identity is not a secret — it is
 * the sort of thing you WANT committed, so a repo someone clones opens with
 * the same mark the author saw.
 *
 * The server deliberately owns no palette. It stores the two strings it is
 * given and hands them back; which marks exist, which colours, and what a
 * project with no stored identity looks like are all questions about how the
 * rail draws, and they are answered in src/projects/identity.ts. That split is
 * what lets the vocabulary change without a migration.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** Where identity lives, relative to the project root. */
export const IDENTITY_FILE = path.join('.hearth', 'project.json');

/** Longest value stored, so a malformed client can't write a novel to disk. */
const MAX_VALUE = 32;

export interface ProjectIdentity {
  /** Name from the app's icon set. Absent means "derive one". */
  icon?: string;
  /** Palette key. Absent means "derive one". */
  color?: string;
}

/** One field, or undefined when it isn't a short plain string. */
function field(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_VALUE) return undefined;
  // Names and keys only: this is read back as a CSS custom property lookup and
  // an icon-set index, and neither should ever carry punctuation.
  return /^[a-z0-9-]+$/i.test(trimmed) ? trimmed : undefined;
}

/**
 * Read what a project says it looks like. Anything missing, unreadable or the
 * wrong shape reads as "nothing stored", which is a complete answer — the
 * renderer derives a mark from the path in that case.
 */
export async function readProjectIdentity(projectRoot: string): Promise<ProjectIdentity> {
  try {
    const raw = await fsp.readFile(path.join(projectRoot, IDENTITY_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    const icon = field(source.icon);
    const color = field(source.color);
    return { ...(icon ? { icon } : {}), ...(color ? { color } : {}) };
  } catch {
    return {};
  }
}

/**
 * Change one or both. Merges rather than replaces, so setting a colour does
 * not silently drop a chosen mark; an explicitly empty string clears a field
 * back to "derive one", which is how the picker offers Reset.
 */
export async function writeProjectIdentity(
  projectRoot: string,
  patch: ProjectIdentity,
): Promise<ProjectIdentity> {
  const next: ProjectIdentity = { ...(await readProjectIdentity(projectRoot)) };
  for (const key of ['icon', 'color'] as const) {
    const incoming = patch[key];
    if (incoming === undefined) continue;
    const cleaned = field(incoming);
    if (cleaned) next[key] = cleaned;
    else delete next[key];
  }
  const file = path.join(projectRoot, IDENTITY_FILE);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}
