/**
 * Naming a FOLDER for a game. Not naming the game.
 *
 * Sending the first message from Home creates the project: there is no picker
 * and no "name your project" step, so the folder name has to come from the
 * prompt itself. That makes the slug rule a product decision, not a utility —
 * `make me a little platformer with slimes` should land in `~/Hearth/little-
 * platformer-slimes`, not `~/Hearth/make-me-a-little`.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 *
 * A slug is lowercase ASCII with single hyphens, and that is not an aesthetic
 * preference: it is a path, and a path has to survive being typed into a
 * shell, checked into git, cloned onto a case-insensitive filesystem, and
 * handed to a Windows API that still reserves CON and LPT1. Everything below
 * defends that.
 *
 * It is NOT the project's name. The name is whatever the person typed, stored
 * beside the mark and colour in `.hearth/project.json` and shown everywhere;
 * see projectIdentity.ts. For as long as the two were the same string, a name
 * this file could not spell was a name the app threw away, and `우주 게임`
 * came back as `new-game` — the app answering a question it had just asked
 * with a shrug. So the rules here only have to produce a workable path, and
 * they are allowed to be lossy, because nothing is lost any more.
 *
 * Everything here is pure except `uniqueFolderName`, which is the one part
 * that has to look at the disk.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Folder under the user's home where auto-created projects live. */
export const PROJECTS_DIR_NAME = 'Hearth';

/** The name used when a prompt carries nothing worth naming a folder after. */
export const FALLBACK_SLUG = 'new-game';

/**
 * Stem for a name made entirely of characters a path cannot hold — every
 * Korean, Japanese, Chinese, Thai, Hebrew or Arabic title there is. A digest
 * of the name follows it, which keeps the folder stable for a given name and
 * distinct between two of them; see `derivedSlug`.
 */
export const DERIVED_SLUG_STEM = 'project';

/** How many words of the prompt survive into the folder name. */
export const SLUG_MAX_WORDS = 4;

/** Hard cap on the slug's length, before the dedupe suffix. */
export const SLUG_MAX_CHARS = 40;

/**
 * Words that say nothing about what the game IS. Dropped before the first four
 * words are taken, which is what makes "make me a game with slimes" name
 * itself `slimes` rather than `make-me-a-game`.
 */
const STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'app',
  'build',
  'can',
  'could',
  'create',
  'do',
  'for',
  'game',
  'generate',
  'give',
  'i',
  'im',
  'in',
  'is',
  'it',
  'just',
  'let',
  'lets',
  'like',
  'make',
  'me',
  'my',
  'need',
  'new',
  'of',
  'on',
  'please',
  'project',
  'some',
  'that',
  'the',
  'this',
  'to',
  'us',
  'using',
  'want',
  'we',
  'with',
  'would',
  'write',
  'you',
  'your',
]);

/**
 * Device names Windows still reserves, in any case and with or without an
 * extension. `mkdir con` fails on Windows and succeeds everywhere else, so a
 * project called "Con" was a create that worked on the developer's Mac and
 * refused on half the machines that would ever run it.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** What a reserved name becomes. Still recognisable, no longer a device. */
const RESERVED_SUFFIX = '-project';

/**
 * The words a slug can be built from: lowercase ASCII runs, with accents
 * folded onto their base letter first.
 *
 * The folding is decomposition, not transliteration. NFKD splits `é` into `e`
 * plus a combining acute, and dropping the mark leaves the letter — so `Café
 * Adventure` names `cafe-adventure` instead of `caf-adventure`, which was the
 * app deleting a letter out of the middle of someone's word. Scripts that do
 * not decompose to Latin (Hangul, kana, Cyrillic, Arabic) survive this
 * untouched and are then dropped by the ASCII split, which is what
 * `derivedSlug` is for.
 */
function slugWords(text: string): string[] {
  return text
    .normalize('NFKD')
    // The combining marks NFKD just separated out.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    // Apostrophes join a word rather than splitting it ("don't" -> "dont").
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/** True when there is a letter or a digit here in ANY script. */
function hasWritingIn(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * FNV-1a, hex. The same hash the rail derives a project's mark with (see
 * src/projects/identity.ts) and for the same reason: deterministic across
 * machines and sessions, so a given name always names the same folder and two
 * different names never quietly name one.
 */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A folder for a name that has real writing in it but nothing an ASCII path
 * can spell. `project-1f0ac33e`, and the same one every time.
 *
 * Not readable, and deliberately not pretending to be: the alternative is
 * transliteration, which would have Hearth deciding that `게임` is spelled
 * "geim" and putting that in front of the person who wrote it. The folder is
 * a filing detail; the NAME is what they see, and it is theirs, unchanged.
 */
function derivedSlug(text: string): string {
  return `${DERIVED_SLUG_STEM}-${digest(text.normalize('NFC').trim())}`;
}

/**
 * The last thing every slug passes through: the cap, and the Windows device
 * names. Cutting on a word boundary when one is near the limit keeps the name
 * readable rather than ending it mid-word.
 */
function finish(joined: string): string {
  let slug = joined;
  if (slug.length > SLUG_MAX_CHARS) {
    const cut = slug.slice(0, SLUG_MAX_CHARS);
    const dash = cut.lastIndexOf('-');
    slug = (dash > SLUG_MAX_CHARS * 0.5 ? cut.slice(0, dash) : cut).replace(/-+$/, '');
  }
  if (slug === '') return FALLBACK_SLUG;
  return WINDOWS_RESERVED.test(slug) ? slug + RESERVED_SUFFIX : slug;
}

/**
 * A folder name for a prompt (or an explicit project name). Lowercase kebab of
 * the first few meaningful words, punctuation stripped, capped — and never
 * empty: a prompt made entirely of stopwords still has to name something.
 */
export function slugFromPrompt(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const words = slugWords(text);
  // "make me a game" is all scaffolding and no game: naming the folder after
  // it would be worse than not naming it at all.
  const chosen = words.filter((word) => !STOPWORDS.has(word)).slice(0, SLUG_MAX_WORDS);
  if (chosen.length > 0) return finish(chosen.join('-'));
  // No ASCII words at all, but the prompt was written in something: a request
  // typed in Korean asks for a game as clearly as one typed in English, and
  // must not land in the same `new-game` as an empty one.
  if (words.length === 0 && hasWritingIn(text)) return derivedSlug(text);
  return FALLBACK_SLUG;
}

/**
 * A folder name for a name someone actually typed.
 *
 * The difference from `slugFromPrompt` is the stopword list, and it matters:
 * a prompt is a sentence with scaffolding in it, so dropping "make me a" is
 * what saves the folder from being called `make-me-a`. A NAME has no
 * scaffolding — every word in it was chosen. Running one through the prompt
 * rule turns "My New Game" into `new-game` (all three words are stopwords, so
 * it falls through to the generic fallback) and "My Space Game" into `space`,
 * which reads as the app ignoring what it just asked for.
 *
 * Everything else is shared: same character rules, same caps, same guarantee
 * of a non-empty result — a name of pure punctuation still has to land
 * somewhere.
 *
 * A name written in a script with no ASCII in it lands in `project-<digest>`
 * rather than the generic fallback. That folder is not readable and does not
 * try to be; what makes it the right answer is that it is derived from the
 * name, stable for it, and different for a different one. The readable thing
 * is the NAME, which is stored intact and is what anyone actually sees.
 */
export function slugFromName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const words = slugWords(text).slice(0, SLUG_MAX_WORDS);
  if (words.length > 0) return finish(words.join('-'));
  // No ASCII to build a path from. If there is writing here at all, the name
  // is real and gets a folder of its own; only a name with no letters and no
  // digits anywhere (pure punctuation, emoji, whitespace) has nothing to
  // derive from and falls through to the generic one.
  return hasWritingIn(text) ? derivedSlug(text) : FALLBACK_SLUG;
}

/**
 * Where auto-created projects go: an explicit override (tests), else
 * HEARTH_PROJECTS_DIR, else `~/Hearth`. Read at call time rather than cached,
 * so a test that sets the env var doesn't depend on import order.
 */
export function resolveProjectsHome(override?: string): string {
  if (override && override.trim() !== '') return path.resolve(override.trim());
  const env = process.env.HEARTH_PROJECTS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), PROJECTS_DIR_NAME);
}

/**
 * `slug`, or `slug-2` / `slug-3` / … when that name is taken. Two games can
 * genuinely be described the same way, and clobbering the first one's folder
 * would be destroying the user's work.
 */
export async function uniqueFolderName(parent: string, slug: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? slug : `${slug}-${n}`;
    try {
      await fsp.access(path.join(parent, candidate));
    } catch {
      return candidate; // nothing there: the name is free
    }
  }
  // Absurd, but a name is still needed and a timestamp is always distinct.
  return `${slug}-${Date.now()}`;
}
