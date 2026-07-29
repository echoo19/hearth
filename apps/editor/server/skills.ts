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

/** Overridable for tests; otherwise Claude Code's folder in the user's home. */
export function claudeHome(): string {
  const override = process.env.HEARTH_CLAUDE_HOME?.trim();
  return override && override !== '' ? path.resolve(override) : path.join(os.homedir(), '.claude');
}

/** Overridable for tests; otherwise codex's folder in the user's home. */
export function codexHome(): string {
  const override = process.env.HEARTH_CODEX_HOME?.trim();
  return override && override !== '' ? path.resolve(override) : path.join(os.homedir(), '.codex');
}

export function skillsRoot(): string {
  return path.join(hearthHome(), 'skills');
}

/** Which agent's folder a skill was found in. */
export type SkillSourceId = 'hearth' | 'claude' | 'codex';

export interface SkillSource {
  source: SkillSourceId;
  /** Absolute path to the folder skills are read from. */
  dir: string;
  /** Whether Hearth may rewrite or delete what it finds here. */
  editable: boolean;
}

/**
 * Every folder a skill can be found in, in the order they win ties.
 *
 * Only Hearth's own folder is written to. The other two are the user's actual
 * agents — skills they already wrote, in this same format, one directory over
 * — and a Skills screen saying "no skills yet" while eighteen of them sit on
 * disk is lying about the machine. So they are read, and only read:
 * `~/.claude/skills/impeccable` belongs to Claude Code, and a game-making app
 * that deleted it would be indefensible.
 *
 * `~/.claude/plugins/**` is deliberately absent. Those skills arrive and leave
 * with a plugin manager, there are hundreds of them, and listing them would
 * bury the handful the user actually wrote under things they never chose one
 * by one.
 */
export function skillSources(): SkillSource[] {
  return [
    { source: 'hearth', dir: skillsRoot(), editable: true },
    { source: 'claude', dir: path.join(claudeHome(), 'skills'), editable: false },
    { source: 'codex', dir: path.join(codexHome(), 'skills'), editable: false },
  ];
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
  /** Which agent's folder this skill was found in. */
  source: SkillSourceId;
  /** Whether Hearth may rewrite or delete it. False for anything discovered. */
  editable: boolean;
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
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    const key = field[1].toLowerCase();
    const raw = field[2].trim();
    // A block scalar — `description: >` or `description: |`, with optional
    // chomping and indent indicators. The value is not on this line; it is the
    // indented lines under it. Handling this is not scope creep into being a
    // YAML parser: skills written by hand routinely use `>` for a description
    // too long for one line, and reading the marker as the value put a literal
    // ">" on screen where the sentence should be.
    const block = /^([|>])[+-]?\d*$/.exec(raw);
    if (block) {
      const collected: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        // Blank lines belong to the block; a line at column 0 ends it.
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        collected.push(next.trim());
        i += 1;
      }
      // `>` folds its lines into one paragraph, `|` keeps them apart. Either
      // way trailing blank lines are chomping noise, not content.
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      fields[key] = block[1] === '>' ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n').trim();
      continue;
    }
    fields[key] = raw.replace(/^["']|["']$/g, '');
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

/**
 * How a skill is named inside `~/.hearth/skills.json`.
 *
 * A bare id means a Hearth skill — which is what every entry in every existing
 * skills.json already means, because that file predates there being anywhere
 * else to read from. Keeping the bare form is the whole compatibility rule:
 * nobody's switched-off list resets because Hearth learned to look in two more
 * folders. Discovered skills are qualified with the agent they came from,
 * since `claude/humanizer` and a Hearth `humanizer` are two different folders
 * that a single flat name could not tell apart. The forms cannot collide:
 * `safeSegment` refuses a `/`, so a bare id is never `claude/…`.
 */
export function disabledKey(source: SkillSourceId, id: string): string {
  return source === 'hearth' ? id : `${source}/${id}`;
}

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

/**
 * Which root an id actually names, hearth first.
 *
 * The id stays the folder name — that is the name agents match on, the name in
 * the disabled list, the name of the link in a project — so the same name can
 * genuinely exist in two roots. Hearth's copy wins and the discovered one is
 * dropped: a skill someone wrote here shadows one they were given, which is
 * also what the agents themselves do, since they match on folder name and only
 * one folder of a given name can win there either.
 */
export async function resolveSkillSource(id: string): Promise<SkillSource | null> {
  const segment = safeSegment(id);
  if (!segment) return null;
  for (const source of skillSources()) {
    try {
      await fsp.stat(path.join(source.dir, segment, SKILL_FILE));
      return source;
    } catch {
      /* not in this root, try the next */
    }
  }
  return null;
}

/** Every skill in every root, hearth's first, alphabetical within each. Never throws. */
export async function listSkills(): Promise<SkillRecord[]> {
  const disabled = await readDisabled();
  const skills: SkillRecord[] = [];
  const seen = new Set<string>();
  for (const source of skillSources()) {
    let entries: string[];
    try {
      entries = (await fsp.readdir(source.dir, { withFileTypes: true }))
        // A symlinked skill is still a skill: the discovered roots belong to
        // other people's setups, where linking a folder in is ordinary.
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch {
      // A root that is missing or unreadable is simply not a place skills came
      // from today. It must never take the rest of the list down with it.
      continue;
    }
    for (const id of entries.sort()) {
      if (seen.has(id)) continue;
      const record = await readSkillAt(source, id, disabled);
      if (!record) continue;
      seen.add(id);
      skills.push(record);
    }
  }
  return skills;
}

/** One skill, or null when the folder holds no SKILL.md to read. */
export async function readSkill(id: string, disabled?: ReadonlySet<string>): Promise<SkillRecord | null> {
  const source = await resolveSkillSource(id);
  return source ? readSkillAt(source, id, disabled) : null;
}

/** The same read, once the root is already known — what listing walks with. */
async function readSkillAt(
  source: SkillSource,
  id: string,
  disabled?: ReadonlySet<string>,
): Promise<SkillRecord | null> {
  const segment = safeSegment(id);
  if (!segment) return null;
  const dir = path.join(source.dir, segment);
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
      enabled: !off.has(disabledKey(source.source, segment)),
      files: contents.length,
      updatedAt: stat.mtime.toISOString(),
      source: source.source,
      editable: source.editable,
    };
  } catch {
    return null;
  }
}

/** The markdown body, for the editor — from whichever root the skill is in. */
export async function readSkillSource(id: string): Promise<SkillDraft | null> {
  const segment = safeSegment(id);
  if (!segment) return null;
  const source = await resolveSkillSource(segment);
  if (!source) return null;
  try {
    const text = await fsp.readFile(path.join(source.dir, segment, SKILL_FILE), 'utf8');
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
 *
 * Nothing here writes outside `skillsRoot()`. An id is resolved to the root it
 * actually lives in and refused unless that root is Hearth's own, because the
 * cost of getting this wrong is not a failed request — it is overwriting a
 * skill the user wrote for Claude Code months ago.
 */
export async function writeSkill(draft: SkillDraft, id?: string): Promise<SkillRecord | null> {
  if (id !== undefined) {
    // Naming a skill to rewrite means rewriting THAT skill. An id that doesn't
    // validate, or names nothing, used to fall through to the create path and
    // quietly fork a duplicate under a fresh slug — so a stale id after a
    // delete silently made a second skill instead of saying it was gone.
    const target = safeSegment(id);
    if (!target) return null;
    const source = await resolveSkillSource(target);
    if (!source || !source.editable) return null;
    const dir = path.join(source.dir, target);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, SKILL_FILE), renderSkillFile(draft));
    return readSkillAt(source, target);
  }
  // Taken names span every root, not just Hearth's: minting `humanizer` here
  // when Claude Code already has one would shadow theirs and leave the user
  // with two things of one name, only one of which any agent would load.
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
  const source = await resolveSkillSource(segment);
  // Discovered skills are not Hearth's to remove. The folder belongs to
  // another agent, and the user did not install a game-making app to have it
  // delete their toolkit.
  if (!source || !source.editable) return false;
  const dir = path.join(source.dir, segment);
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
  if (disabled.delete(disabledKey(source.source, segment))) await writeDisabled(disabled);
  return true;
}

/**
 * Switch a skill on or off. Works on discovered skills too, and has to:
 * read-only means Hearth will not rewrite someone's folder, not that the user
 * cannot say no to a skill they can see in the list.
 */
export async function setSkillEnabled(id: string, enabled: boolean): Promise<SkillRecord | null> {
  const segment = safeSegment(id);
  if (!segment) return null;
  // Only skills that exist get an entry: a disabled list that accumulates
  // names of things that were never here is a file that only ever grows.
  const source = await resolveSkillSource(segment);
  if (!source) return null;
  const disabled = await readDisabled();
  const key = disabledKey(source.source, segment);
  if (enabled) disabled.delete(key);
  else disabled.add(key);
  await writeDisabled(disabled);
  return readSkillAt(source, segment);
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
  // An import always lands in Hearth's own root, and the slug steps aside for
  // every name already visible — including discovered ones — so there is no
  // arrangement of inputs where this writes into another agent's folder or
  // quietly buries a skill that was already there.
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
    return { skill: null, error: 'Hearth could not save that skill to disk.' };
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
 * The first line of the `.gitignore` Hearth maintains inside a project's
 * `.claude/skills/`, and the only thing that identifies the file as ours.
 *
 * Matched before the file is ever rewritten or removed, so a `.gitignore` a
 * person wrote there by hand is left exactly alone — the same rule `.hearth-copy`
 * enforces for the mirrors themselves.
 */
export const MIRROR_IGNORE_MARKER = '# Written by Hearth: mirrored skills, not this project’s own.';

/**
 * Keep a project's git repo free of the skills Hearth mirrored into it.
 *
 * A skill belongs to the PERSON — that is the whole promise of the feature, and
 * `~/.hearth/skills` is where it is kept. `syncSkillsIntoProject` then has to
 * materialise a copy of that personal library inside the game folder, because
 * the Agent SDK discovers skills from the filesystem around its cwd and offers
 * no way to point it elsewhere. A game folder is an ordinary git repo the person
 * will push, so without this the mirror is committed: on macOS and Linux as
 * symlinks into `/Users/<name>/.hearth/skills/...`, which leak the user's home
 * layout and resolve to nothing for whoever clones the game; on Windows without
 * developer mode as full COPIES, which publish the text of every private skill.
 *
 * Named entry by entry rather than as a blanket `.claude/skills/` rule, because
 * this folder holds two different things. The `hearth-*` skills a template
 * scaffolds are the PROJECT's, they are meant to be committed, and they travel
 * with the repo. Only what Hearth mirrored here goes in the list, so the two
 * cannot be confused and switching a skill off takes its line out with it.
 *
 * An empty list deletes the file rather than leaving an empty one: a project
 * with no mirrors in it should look untouched.
 */
async function writeMirrorIgnore(target: string, mirrored: readonly string[]): Promise<void> {
  const file = path.join(target, '.gitignore');
  const existing = await fsp.readFile(file, 'utf8').catch(() => null);
  // Somebody else's file. Hearth does not get to edit it, and it does not get
  // to delete it either.
  if (existing !== null && !existing.startsWith(MIRROR_IGNORE_MARKER)) return;
  if (mirrored.length === 0) {
    if (existing !== null) await fsp.rm(file, { force: true }).catch(() => undefined);
    return;
  }
  const body = [
    MIRROR_IGNORE_MARKER,
    '# These are links to your own skill library, put here so the agent can find',
    '# them. They are yours, not this game’s, so they stay out of its history.',
    '# Anything else in this folder is the project’s own and is committed as usual.',
    // Sorted so a reorder in the mirror list is not a diff, and leading-slashed
    // so each name is anchored to THIS folder rather than matching anywhere
    // deeper in the tree.
    ...[...mirrored].sort().map((id) => `/${id}`),
    '',
  ].join('\n');
  if (existing === body) return;
  await fsp.writeFile(file, body, 'utf8').catch(() => undefined);
}

/**
 * Mirror the enabled skills into a project so the Agent SDK can discover them.
 *
 * Links rather than copies, so editing a skill in one place changes it
 * everywhere; falls back to copying where the platform refuses a symlink
 * (Windows without developer mode). Links Hearth previously made and no longer
 * wants are removed — a skill switched off has to actually go away — and
 * anything the user put there by hand is left strictly alone.
 *
 * Discovered skills are mirrored like any other, which is worth saying out
 * loud because it looks redundant: Claude Code already reads
 * `~/.claude/skills` for itself. It is not redundant for the query Hearth
 * opens. That query is the Agent SDK with the project as its cwd and no
 * setting sources, so the project folder is the only discovery path Hearth
 * controls; skipping the mirror would leave a switch marked ON that did
 * nothing, which is a worse lie than a duplicate link. Where the CLI does read
 * both, the link points at the very same folder, so it resolves to one file
 * either way.
 *
 * The reverse is honest too, and narrower than it looks: switching a
 * discovered skill off removes the link HEARTH made. It cannot stop Claude
 * Code from reading its own folder when the user runs the CLI themselves.
 * Hearth only ever controls what Hearth put there.
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
  //
  // Every root counts, not just Hearth's: a link into `~/.claude/skills` is
  // still a link Hearth made, and recognising only its own root would strand
  // exactly the skills it can least afford to strand — a discovered one
  // switched off would stay live to the agent while the panel said it was off.
  const roots = skillSources().map((source) => source.dir + path.sep);
  const wanted = new Set(skills.map((skill) => skill.id));
  for (const name of existing) {
    if (wanted.has(name)) continue;
    const link = path.join(target, name);
    const points = await fsp.readlink(link).catch(() => null);
    if (points && roots.some((root) => points.startsWith(root))) {
      await fsp.rm(link, { force: true });
    } else if (points === null && (await isOurCopy(link))) {
      await fsp.rm(link, { recursive: true, force: true });
    }
  }
  // Last, so the list it writes is exactly what survived the loops above: a
  // skill that could not be mirrored is not in `linked` and must not be ignored,
  // or the person's own folder of the same name would go quiet.
  await writeMirrorIgnore(target, linked);
  return linked;
}
