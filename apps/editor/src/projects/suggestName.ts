/**
 * A name to put in front of someone, not a name to give a folder.
 *
 * Projects used to be named FROM the first message, silently, by the server:
 * you typed "make me a little game where a raccoon steals bins" and a folder
 * called `little-game-where-raccoon` appeared with no way to say otherwise. The
 * name is the one thing about a project that is hard to change later and easy
 * to decide up front, so it is asked for now. This only writes the first draft
 * of the answer into the field, already selected, so the fast path is still one
 * keystroke.
 *
 * Deliberately dumb. It takes the words that are there rather than trying to
 * understand the game, because a guess that is obviously mechanical is easy to
 * correct while a guess that is nearly right is the one people accept and then
 * live with. Nothing here knows or cares what kind of game is being described.
 */

/**
 * Openers people put in front of the actual idea. Only stripped from the FRONT,
 * and only while the words that follow still say something: "make a game" is
 * left as "Game" rather than reduced to nothing.
 */
const OPENERS = [
  // Politeness and intent, peeled one layer at a time so combinations work
  // ("can you please make a game where…" is three of these in a row).
  'can you',
  'could you',
  'would you',
  'i want',
  'i would',
  "i'd",
  'i wanna',
  'we should',
  'help me',
  'please',
  "let's",
  'lets',
  // The verb.
  'to make',
  'to build',
  'to create',
  'make',
  'build',
  'create',
  'start',
  'me',
  // The lead-in that says "a game" when the whole app is about making one.
  'a game where',
  'a game about',
  'a game called',
  'game where',
  'game about',
  'game called',
  'called',
  'a',
  'an',
  'the',
  // Longest first, so "a game about" wins over "a".
].sort((a, b) => b.length - a.length);

/** Words too small to carry a name if they end up last. */
const TRAILING_FILLER = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'and',
  'where',
  'about',
  'that',
  // Manners, which land at the end as often as the front.
  'please',
  'pls',
  'thanks',
  'thank',
  'you',
]);

/** Nothing but filler is not an idea, whatever it is made of. */
function isAllFiller(text: string): boolean {
  return text.split(' ').every((word) => word === '' || TRAILING_FILLER.has(word));
}

/** How many words a suggestion keeps. Four fits a rail row and a title bar. */
const MAX_WORDS = 4;
/** Folder names get unwieldy past this, whatever the words were. */
const MAX_CHARS = 32;

/**
 * The first draft of a project's name, from the first thing someone typed.
 * Empty when there is nothing to work with, which the dialog shows as an empty
 * field rather than inventing something.
 */
export function suggestProjectName(prompt: string): string {
  let text = prompt
    .toLowerCase()
    // Punctuation carries no name, but it does end one: a full stop is a
    // better boundary than four words when the first sentence is short.
    .replace(/[\r\n]+/g, ' ')
    .split(/[.!?]/)[0]
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip openers repeatedly: "can you please make a game where..." is three.
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const opener of OPENERS) {
      if (!text.startsWith(`${opener} `)) continue;
      const rest = text.slice(opener.length + 1).trim();
      // The opener IS the idea: "make a game" must not reduce to nothing, and
      // "a game about the" must keep "game about" rather than peel down to
      // the one word left holding the door open.
      if (rest === '' || isAllFiller(rest)) continue;
      text = rest;
      stripped = true;
      break;
    }
  }

  const words = text.split(' ').filter((word) => word !== '');
  while (words.length > 1 && TRAILING_FILLER.has(words[words.length - 1])) words.pop();
  const kept: string[] = [];
  for (const word of words.slice(0, MAX_WORDS)) {
    if (kept.length > 0 && [...kept, word].join(' ').length > MAX_CHARS) break;
    kept.push(word);
  }
  while (kept.length > 1 && TRAILING_FILLER.has(kept[kept.length - 1])) kept.pop();
  if (kept.length === 0) return '';

  // Sentence case, not title case. A project is a thing you named, not a
  // product with a wordmark, and Capitalising Every Word reads like one.
  const name = kept.join(' ').slice(0, MAX_CHARS).trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}
