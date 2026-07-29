/**
 * What a project calls itself: one mark, one colour, and its name.
 *
 * Kept in `.hearth/project.json` rather than in `app.json`, which holds API
 * keys and is written 0600 for that reason. Identity is not a secret — it is
 * the sort of thing you WANT committed, so a repo someone clones opens with
 * the same mark and the same name the author saw.
 *
 * THE NAME IS NOT THE FOLDER, AND MUST NEVER BECOME ONE
 *
 * The folder is a slug: lowercase ASCII, no punctuation, no spaces, because it
 * is a path and a path has to survive every filesystem, shell and git remote.
 * The name has to survive none of that, so it keeps every character it was
 * given — `우주 게임` is a name and `new-game` is not, and for as long as the
 * basename WAS the name, someone who does not write in Latin script could not
 * name their game at all.
 *
 * So this string is display-only. It is never joined into a path, never used
 * to look anything up, and never compared to a directory entry. Every path in
 * the app comes from `workspaceSlug.ts` and from nowhere else; the only reason
 * it is safe to store a name with `..` or `/` in it is that nothing here ever
 * hands it to `path.join`. Keep it that way.
 *
 * The server deliberately owns no palette. It stores the strings it is given
 * and hands them back; which marks exist, which colours, and what a project
 * with no stored identity looks like are all questions about how the rail
 * draws, and they are answered in src/projects/identity.ts. That split is what
 * lets the vocabulary change without a migration.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** Where identity lives, relative to the project root. */
export const IDENTITY_FILE = path.join('.hearth', 'project.json');

/** Longest value stored, so a malformed client can't write a novel to disk. */
const MAX_VALUE = 32;

/**
 * Longest name kept. Wider than a mark key because this is prose someone
 * chose, and a title in a script that spells a word in one character is not
 * the same length as a title in English. Long enough for any real name, short
 * enough that a rail row still has something to render.
 */
export const MAX_NAME = 120;

export interface ProjectIdentity {
  /** Name from the app's icon set. Absent means "derive one". */
  icon?: string;
  /** Palette key. Absent means "derive one". */
  color?: string;
  /**
   * What the person called this game, exactly as they typed it. Absent means
   * "use the folder basename", which is what every project made before this
   * existed does, and is why there is no migration.
   *
   * Display only. See the header: this must never build a path.
   */
  name?: string;
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
 * Everything below U+0020, plus DEL, flattened to a space.
 *
 * Written as a scan rather than a regex on purpose: a character class of raw
 * control codes is unreadable in source and easy to get wrong, and this runs
 * once per name. A name pasted out of a document arrives with tabs and
 * newlines in it, and those render as invisible holes in a rail row.
 */
function withoutControls(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return out;
}

/**
 * The display name, or undefined when there is nothing usable there.
 *
 * No character rule, on purpose: any rule about which letters a name may hold
 * is a rule about who is allowed to name a game, and there is no such rule.
 * What IS done is the housekeeping a paste needs — NFC so the same name typed
 * on two machines is the same string, control characters flattened to spaces
 * (they would otherwise render as invisible holes in the rail), and runs of
 * whitespace collapsed.
 *
 * Over-long is truncated rather than rejected. Rejecting would drop the name
 * entirely and fall back to the slug, which is the exact failure this whole
 * file exists to end; the cap is here to bound what reaches the disk, and
 * keeping the first 120 characters does that without throwing the name away.
 */
function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = withoutControls(value.normalize('NFC')).replace(/\s+/g, ' ').trim();
  if (cleaned === '') return undefined;
  return cleaned.length > MAX_NAME ? cleaned.slice(0, MAX_NAME).trim() : cleaned;
}

/** Which cleaner answers for which field. */
const CLEANERS: Record<keyof ProjectIdentity, (value: unknown) => string | undefined> = {
  icon: field,
  color: field,
  name: displayName,
};

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
    const name = displayName(source.name);
    return { ...(icon ? { icon } : {}), ...(color ? { color } : {}), ...(name ? { name } : {}) };
  } catch {
    return {};
  }
}

/**
 * Change one, some or all of them. Merges rather than replaces, so setting a
 * colour does not silently drop a chosen mark; an explicitly empty string
 * clears a field back to "derive one", which is how the picker offers Reset
 * and, for the name, means "go back to the folder basename".
 */
export async function writeProjectIdentity(
  projectRoot: string,
  patch: ProjectIdentity,
): Promise<ProjectIdentity> {
  const next: ProjectIdentity = { ...(await readProjectIdentity(projectRoot)) };
  for (const key of ['icon', 'color', 'name'] as const) {
    const incoming = patch[key];
    if (incoming === undefined) continue;
    const cleaned = CLEANERS[key](incoming);
    if (cleaned) next[key] = cleaned;
    else delete next[key];
  }
  const file = path.join(projectRoot, IDENTITY_FILE);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}
