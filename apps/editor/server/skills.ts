/**
 * Skills: instructions that extend what your agent knows how to do.
 *
 * A skill is a folder with a `SKILL.md` in it, and that is not Hearth's
 * invention — it is the format Claude Code and codex both already read, which
 * is the entire reason this is worth building rather than faking. One folder,
 * two agents, no translation:
 *
 *   ~/.hearth/skills/<slug>/SKILL.md      the skill
 *   ~/.hearth/skills.json                 which ones are switched off
 *
 * The skills live in the user's home, not in a project, because that is what
 * people mean by a skill: something you taught your agent once and expect it
 * to still know in the next game you start.
 *
 * Reaching each backend takes one step, and they are different steps:
 *
 *   codex   `skills/extraRoots/set` — a real method on the app-server
 *           protocol, verified against CODEX_TESTED_VERSION, which adds a
 *           directory to the ones codex scans.
 *   Claude  a link at `<project>/.claude/skills/<slug>`, because the Agent SDK
 *           discovers skills from the filesystem around its cwd and offers no
 *           way to point it elsewhere. A symlink where the platform allows one,
 *           a copy where it doesn't.
 *
 * Both are applied when a conversation BINDS its agent, not per message: the
 * SDK's query and codex's thread are long-lived, so a skill switched on or off
 * mid-conversation is felt by the next conversation, not the next sentence.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Overridable for tests; otherwise the app's folder in the user's home. */
export function hearthHome(): string {
  const override = process.env.HEARTH_HOME?.trim();
  return override && override !== '' ? path.resolve(override) : path.join(os.homedir(), '.hearth');
}

export function skillsRoot(): string {
  return path.join(hearthHome(), 'skills');
}

/** Where the disabled list lives — beside the folder, never inside it. */
export function skillsConfigPath(): string {
  return path.join(hearthHome(), 'skills.json');
}

/** The file every skill folder is identified by. */
export const SKILL_FILE = 'SKILL.md';

/** Ceilings for an imported folder: a skill is instructions, not a payload. */
export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_BYTES = 4 * 1024 * 1024;

export interface SkillRecord {
  /** The folder name, which is also the name agents match on. */
  id: string;
  name: string;
  description: string;
  /** Absolute path to the skill's folder. */
  path: string;
  enabled: boolean;
  /** How many files the folder holds, so the UI can say "3 files". */
  files: number;
  /** ISO, from the SKILL.md's mtime — what "edited just now" reads from. */
  updatedAt: string;
}

/** What a create/edit sends. Body is the markdown under the frontmatter. */
export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

/**
 * Fold a display name into a folder name. Agents match skills by this, so it
 * has to be stable, lowercase and free of anything a path would argue with.
 */
export function skillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
    .join('-')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug === '' ? 'skill' : slug;
}

/** A slug that isn't taken yet, by appending -2, -3, … like Finder does. */
export function uniqueSkillSlug(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

/**
 * Read the `name` and `description` out of a SKILL.md.
 *
 * Deliberately a small reader rather than a YAML parser: the frontmatter both
 * agents require is two scalar fields, and a skill someone wrote by hand
 * should not fail to load because a parser disliked something three lines
 * further down. Quotes are stripped, everything else is left alone.
 */
export function parseSkillFile(text: string): { name: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { name: '', description: '', body: text.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    fields[field[1].toLowerCase()] = field[2].trim().replace(/^["']|["']$/g, '');
  }
  return {
    name: fields.name ?? '',
    description: fields.description ?? '',
    body: text.slice(match[0].length).trim(),
  };
}

/**
 * Write one out. Values are kept on a single line and quoted, because a
 * description with a colon in it is the obvious way to produce frontmatter
 * that every reader downstream refuses.
 */
export function renderSkillFile(draft: SkillDraft): string {
  const escape = (value: string): string => value.replace(/\s+/g, ' ').trim().replace(/"/g, "'");
  return `---\nname: ${escape(draft.name)}\ndescription: "${escape(draft.description)}"\n---\n\n${draft.body.trim()}\n`;
}

/** A path segment safe to write: one level, no traversal, no control bytes. */
export function safeSegment(raw: string): string | null {
  const segment = raw.trim();
  if (segment === '' || segment === '.' || segment === '..') return null;
  if (/[\u0000-\u001f<>:"|?*\\/]/.test(segment)) return null;
  return segment;
}

/** A relative path inside an imported skill folder, or null if it escapes. */
export function safeRelativePath(raw: string): string | null {
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.length > 8) return null;
  const safe: string[] = [];
  for (const part of parts) {
    const segment = safeSegment(part);
    if (!segment) return null;
    safe.push(segment);
  }
  return safe.join('/');
}

// ---------------------------------------------------------------------------
// The disabled list
// ---------------------------------------------------------------------------

async function readDisabled(): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fsp.readFile(skillsConfigPath(), 'utf8')) as { disabled?: unknown };
    return new Set(Array.isArray(raw.disabled) ? raw.disabled.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

async function writeDisabled(disabled: ReadonlySet<string>): Promise<void> {
  await fsp.mkdir(hearthHome(), { recursive: true });
  await fsp.writeFile(skillsConfigPath(), `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Everything in the skills folder, alphabetical. Never throws. */
export async function listSkills(): Promise<SkillRecord[]> {
  const root = skillsRoot();
  const disabled = await readDisabled();
  let entries: string[];
  try {
    entries = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const skills: SkillRecord[] = [];
  for (const id of entries.sort()) {
    const record = await readSkill(id, disabled);
    if (record) skills.push(record);
  }
  return skills;
}

/** One skill, or null when the folder holds no SKILL.md to read. */
export async function readSkill(id: string, disabled?: ReadonlySet<string>): Promise<SkillRecord | null> {
  const segment = safeSegment(id);
  if (!segment) return null;
  const dir = path.join(skillsRoot(), segment);
  const file = path.join(dir, SKILL_FILE);
  try {
    const [text, stat, contents] = await Promise.all([
      fsp.readFile(file, 'utf8'),
      fsp.stat(file),
      fsp.readdir(dir).catch(() => [] as string[]),
    ]);
    const parsed = parseSkillFile(text);
    const off = disabled ?? (await readDisabled());
    return {
      id: segment,
      // The folder name is what an agent matches on, so it wins over a
      // frontmatter `name` that drifted away from it.
      name: parsed.name !== '' ? parsed.name : segment,
      description: parsed.description,
      path: dir,
      enabled: !off.has(segment),
      files: contents.length,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/** The markdown body, for the editor. */
export async function readSkillSource(id: string): Promise<SkillDraft | null> {
  const segment = safeSegment(id);
  if (!segment) return null;
  try {
    const text = await fsp.readFile(path.join(skillsRoot(), segment, SKILL_FILE), 'utf8');
    const parsed = parseSkillFile(text);
    return { name: parsed.name !== '' ? parsed.name : segment, description: parsed.description, body: parsed.body };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Create a skill, or rewrite one in place when `id` names an existing folder.
 * A rename keeps the folder: the folder name is the identity an agent has
 * already been told about, and shuffling it under a running conversation would
 * make a skill disappear mid-sentence.
 */
export async function writeSkill(draft: SkillDraft, id?: string): Promise<SkillRecord | null> {
  if (id !== undefined) {
    // Naming a skill to rewrite means rewriting THAT skill. An id that doesn't
    // validate, or names nothing, used to fall through to the create path and
    // quietly fork a duplicate under a fresh slug — so a stale id after a
    // delete silently made a second skill instead of saying it was gone.
    const target = safeSegment(id);
    if (!target || !(await readSkill(target))) return null;
    const dir = path.join(skillsRoot(), target);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, SKILL_FILE), renderSkillFile(draft));
    return readSkill(target);
  }
  const taken = new Set((await listSkills()).map((skill) => skill.id));
  const slug = uniqueSkillSlug(skillSlug(draft.name), taken);
  const dir = path.join(skillsRoot(), slug);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, SKILL_FILE), renderSkillFile(draft));
  return readSkill(slug);
}

export async function deleteSkill(id: string): Promise<boolean> {
  const segment = safeSegment(id);
  if (!segment) return false;
  const dir = path.join(skillsRoot(), segment);
  if (!dir.startsWith(skillsRoot() + path.sep)) return false;
  // `rm --force` succeeds on a folder that was never there, so existence is
  // checked first: "deleted" has to mean something was.
  try {
    await fsp.stat(dir);
  } catch {
    return false;
  }
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    return false;
  }
  const disabled = await readDisabled();
  if (disabled.delete(segment)) await writeDisabled(disabled);
  return true;
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<SkillRecord | null> {
  const segment = safeSegment(id);
  if (!segment) return null;
  // Only skills that exist get an entry: a disabled list that accumulates
  // names of things that were never here is a file that only ever grows.
  if (!(await readSkill(segment))) return null;
  const disabled = await readDisabled();
  if (enabled) disabled.delete(segment);
  else disabled.add(segment);
  await writeDisabled(disabled);
  return readSkill(segment);
}

/** One file of an uploaded skill folder. */
export interface SkillImportFile {
  /** Path relative to the folder that was chosen, e.g. `SKILL.md`. */
  relPath: string;
  /** base64 contents. */
  data: string;
}

/**
 * Take a folder someone picked on their computer. The rules are the ones that
 * make an import safe and a result honest: it has to contain a SKILL.md
 * (otherwise it is not a skill and no agent would ever load it), nothing may
 * escape the folder it claims to be in, and the whole thing has to be small.
 */
export async function importSkill(
  files: readonly SkillImportFile[],
  fallbackName: string,
): Promise<{ skill: SkillRecord | null; error?: string }> {
  const cleaned: { relPath: string; bytes: Buffer }[] = [];
  let total = 0;
  for (const file of files.slice(0, MAX_SKILL_FILES)) {
    const relPath = safeRelativePath(file.relPath);
    if (!relPath) continue;
    const bytes = Buffer.from(file.data, 'base64');
    total += bytes.length;
    if (total > MAX_SKILL_BYTES) {
      return { skill: null, error: `That folder is larger than ${MAX_SKILL_BYTES / (1024 * 1024)} MB.` };
    }
    cleaned.push({ relPath, bytes });
  }
  const manifest = cleaned.find((file) => file.relPath.toLowerCase() === SKILL_FILE.toLowerCase());
  if (!manifest) return { skill: null, error: `That folder has no ${SKILL_FILE} in it.` };

  const parsed = parseSkillFile(manifest.bytes.toString('utf8'));
  const taken = new Set((await listSkills()).map((skill) => skill.id));
  const slug = uniqueSkillSlug(skillSlug(parsed.name !== '' ? parsed.name : fallbackName), taken);
  const dir = path.join(skillsRoot(), slug);
  try {
    for (const file of cleaned) {
      const abs = path.join(dir, file.relPath);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, file.bytes);
    }
  } catch {
    // A half-written skill is worse than none: it would list, and load into an
    // agent, missing whatever failed.
    await fsp.rm(dir, { recursive: true, force: true });
    return { skill: null, error: 'That folder could not be written.' };
  }
  return { skill: await readSkill(slug) };
}

// ---------------------------------------------------------------------------
// Reaching the agents
// ---------------------------------------------------------------------------

/**
 * Dropped into a COPIED skill so a later sync can tell its own copy from a
 * folder the user created by hand. Only reached where the platform refuses a
 * symlink (Windows without developer mode).
 */
const COPY_MARKER = '.hearth-copy';

/** True when this directory is a copy Hearth made, not the user's own folder. */
async function isOurCopy(dir: string): Promise<boolean> {
  try {
    await fsp.stat(path.join(dir, COPY_MARKER));
    return true;
  } catch {
    return false;
  }
}

/** Where the Agent SDK looks, relative to the folder it is working in. */
export const CLAUDE_SKILLS_DIR = path.join('.claude', 'skills');

/**
 * Mirror the enabled skills into a project so the Agent SDK can discover them.
 *
 * Links rather than copies, so editing a skill in one place changes it
 * everywhere; falls back to copying where the platform refuses a symlink
 * (Windows without developer mode). Links Hearth previously made and no longer
 * wants are removed — a skill switched off has to actually go away — and
 * anything the user put there by hand is left strictly alone.
 */
export async function syncSkillsIntoProject(projectRoot: string): Promise<string[]> {
  const skills = (await listSkills()).filter((skill) => skill.enabled);
  const target = path.join(projectRoot, CLAUDE_SKILLS_DIR);
  const linked: string[] = [];
  let existing: string[] = [];
  try {
    existing = await fsp.readdir(target);
  } catch {
    if (skills.length === 0) return [];
  }
  await fsp.mkdir(target, { recursive: true }).catch(() => undefined);

  for (const skill of skills) {
    const link = path.join(target, skill.id);
    try {
      const current = await fsp.readlink(link).catch(() => null);
      if (current === skill.path) {
        linked.push(skill.id);
        continue;
      }
      // A real directory here belongs to the user — unless it is a copy we
      // made ourselves, which is stale and has to be replaced.
      if (current === null && existing.includes(skill.id) && !(await isOurCopy(link))) continue;
      await fsp.rm(link, { recursive: true, force: true });
      await fsp.symlink(skill.path, link, 'dir');
      linked.push(skill.id);
    } catch {
      try {
        await fsp.rm(link, { recursive: true, force: true });
        await fsp.cp(skill.path, link, { recursive: true });
        // Mark it, because a copy is indistinguishable from a folder the user
        // put here — and without the mark it could never be refreshed when the
        // skill changed, nor removed when the skill was switched off.
        await fsp.writeFile(path.join(link, COPY_MARKER), `${skill.path}\n`);
        linked.push(skill.id);
      } catch {
        /* a skill that cannot be mirrored is simply not offered */
      }
    }
  }

  // Clean up what we put here before and no longer should — links AND copies.
  // A skill switched off has to actually go away; leaving a copy behind would
  // keep it live to the agent while the panel says it is off.
  const wanted = new Set(skills.map((skill) => skill.id));
  for (const name of existing) {
    if (wanted.has(name)) continue;
    const link = path.join(target, name);
    const points = await fsp.readlink(link).catch(() => null);
    if (points && points.startsWith(skillsRoot() + path.sep)) {
      await fsp.rm(link, { force: true });
    } else if (points === null && (await isOurCopy(link))) {
      await fsp.rm(link, { recursive: true, force: true });
    }
  }
  return linked;
}
