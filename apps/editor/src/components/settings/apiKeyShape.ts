/**
 * Is this string shaped like the key it claims to be?
 *
 * A truncated paste is the failure this exists for. Before it, any non-empty
 * string was accepted, written into the folder's `.hearth/app.json`, answered
 * for with `hasKey: true` and shown as a green Connected badge, and the user
 * found out several screens later, from a turn that failed for no stated
 * reason, with nothing on that screen pointing back at the field they pasted
 * into. A confident green badge is the expensive kind of wrong.
 *
 * SHAPE, NOT VALIDITY. Nothing here can tell a real key from a well-formed
 * fake; that takes a request to the vendor, and a key must not leave the
 * renderer for anywhere but Hearth's own process, so the honest home for that
 * is a server route that does not exist yet. This catches the mistake, not the
 * lie, and every sentence below is written to claim only the first.
 *
 * AND IT IS NOT A GATE. Hearth does not get to decide which strings its user
 * is allowed to own. Vendors change their prefixes, and a pane that refused a
 * new format would be a bug in Hearth reported by everyone as a bug in their
 * key. So the caller offers to save it anyway on a second press, and this
 * function only ever answers what looks wrong.
 */
import type { ChatProvider } from '../../types';

/**
 * The shortest thing that could be a real key.
 *
 * Both vendors issue keys around a hundred characters and up: an Anthropic key
 * runs to about 108, a legacy OpenAI one to 51, and an `sk-proj-` one well past
 * 150. So this still sits far below every real floor and is not policing a
 * length that is not ours to police.
 *
 * It was 24, which is the number that made this whole module vacuous for its
 * own stated purpose. `sk-ant-api03-AAAAAAAAAAAA` is 25 characters, has the
 * right prefix, and is a paste that lost 83 of its 95 body characters — and it
 * went through and earned a green Connected badge. A floor set below the
 * shortest plausible truncation catches nothing.
 */
export const MIN_KEY_LENGTH = 40;

/** The prefix each vendor has been issuing. Checked, never required. */
export const KEY_PREFIX: Record<ChatProvider, string> = {
  anthropic: 'sk-ant-',
  openai: 'sk-',
};

/**
 * Prefixes specific enough to name the vendor that issued them.
 *
 * The point is the direction the plain prefix check cannot see. OpenAI's
 * prefix is `sk-`, so every Anthropic key ever issued starts with it, and an
 * `sk-ant-…` pasted into the OpenAI box passed silently — on a pane that shows
 * both fields, with near-identical placeholders, which makes it the single most
 * likely mistake there is to make here. `sk-` is deliberately absent: it is not
 * distinctive, and claiming an unrecognised `sk-` string came from OpenAI would
 * be inventing a fact.
 */
const ISSUED_BY: readonly { prefix: string; provider: ChatProvider }[] = [
  { prefix: 'sk-ant-', provider: 'anthropic' },
];

/** The vendor's own name for itself, for a sentence about its keys. */
const VENDOR: Record<ChatProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/**
 * What looks wrong with this key, or null when nothing does.
 *
 * Ordered by how likely each one is to be what actually happened: a paste that
 * dragged a newline in with it, then the other vendor's key in this vendor's
 * box, then a string that was never a key at all, then one that lost its end.
 * Each sentence names the mistake rather than the rule, because "must match
 * ^sk-ant-" tells you what the checker wants and not what you did.
 */
export function keyShapeProblem(provider: ChatProvider, raw: string): string | null {
  const value = raw.trim();
  if (value === '') return 'Paste a key first.';
  if (/\s/.test(value)) {
    return 'There is a space or a line break inside that, so something else came along with the paste.';
  }
  // Ahead of the plain prefix check, and it has to be: `sk-ant-…` satisfies
  // OpenAI's `sk-` prefix, so this is the only thing standing between the two
  // fields on this pane and each other.
  const elsewhere = ISSUED_BY.find((issuer) => issuer.provider !== provider && value.startsWith(issuer.prefix));
  if (elsewhere) {
    return `That begins with ${elsewhere.prefix}, which is how ${VENDOR[elsewhere.provider]} keys start. This box wants the ${VENDOR[provider]} one.`;
  }
  const prefix = KEY_PREFIX[provider];
  if (!value.startsWith(prefix)) {
    return `${VENDOR[provider]} keys begin with ${prefix} and this one does not, so it may not be the string you meant to copy.`;
  }
  if (value.length < MIN_KEY_LENGTH) {
    return 'That is much shorter than a key from either vendor, so the paste probably lost its end.';
  }
  return null;
}
