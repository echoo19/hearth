/**
 * Naming a folder for a game nobody has named yet.
 *
 * Sending the first message from Home creates the project: there is no picker
 * and no "name your project" step, so the folder name has to come from the
 * prompt itself. That makes the slug rule a product decision, not a utility —
 * `make me a little platformer with slimes` should land in `~/Hearth/little-
 * platformer-slimes`, not `~/Hearth/make-me-a-little`.
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
 * A folder name for a prompt (or an explicit project name). Lowercase kebab of
 * the first few meaningful words, punctuation stripped, capped — and never
 * empty: a prompt made entirely of stopwords still has to name something.
 */
export function slugFromPrompt(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const words = text
    .toLowerCase()
    // Apostrophes join a word rather than splitting it ("don't" -> "dont").
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  // "make me a game" is all scaffolding and no game: naming the folder after
  // it would be worse than not naming it at all.
  const chosen = words.filter((word) => !STOPWORDS.has(word)).slice(0, SLUG_MAX_WORDS);
  if (chosen.length === 0) return FALLBACK_SLUG;
  const joined = chosen.join('-');
  if (joined.length <= SLUG_MAX_CHARS) return joined;
  // Cut on a word boundary when one is near the limit, so the name stays
  // readable rather than ending mid-word.
  const cut = joined.slice(0, SLUG_MAX_CHARS);
  const dash = cut.lastIndexOf('-');
  const trimmed = (dash > SLUG_MAX_CHARS * 0.5 ? cut.slice(0, dash) : cut).replace(/-+$/, '');
  return trimmed === '' ? FALLBACK_SLUG : trimmed;
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
 */
export function slugFromName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const words = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
    .slice(0, SLUG_MAX_WORDS);
  if (words.length === 0) return FALLBACK_SLUG;
  const joined = words.join('-');
  if (joined.length <= SLUG_MAX_CHARS) return joined;
  const cut = joined.slice(0, SLUG_MAX_CHARS);
  const dash = cut.lastIndexOf('-');
  const trimmed = (dash > SLUG_MAX_CHARS * 0.5 ? cut.slice(0, dash) : cut).replace(/-+$/, '');
  return trimmed === '' ? FALLBACK_SLUG : trimmed;
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
