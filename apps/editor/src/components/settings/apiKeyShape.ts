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
 * The shortest thing that could be a real key. Both vendors issue keys around
 * a hundred characters long, so this sits nowhere near the real floor on
 * purpose: it is here to catch a paste that lost its tail, not to police a
 * length that is not ours to police.
 */
export const MIN_KEY_LENGTH = 24;

/** The prefix each vendor has been issuing. Checked, never required. */
export const KEY_PREFIX: Record<ChatProvider, string> = {
  anthropic: 'sk-ant-',
  openai: 'sk-',
};

/** The vendor's own name for itself, for a sentence about its keys. */
const VENDOR: Record<ChatProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/**
 * What looks wrong with this key, or null when nothing does.
 *
 * Ordered by how likely each one is to be what actually happened: a paste that
 * dragged a newline in with it, then a string that was never a key at all,
 * then one that lost its end. Each sentence names the mistake rather than the
 * rule, because "must match ^sk-ant-" tells you what the checker wants and not
 * what you did.
 */
export function keyShapeProblem(provider: ChatProvider, raw: string): string | null {
  const value = raw.trim();
  if (value === '') return 'Paste a key first.';
  if (/\s/.test(value)) {
    return 'There is a space or a line break inside that, so something else came along with the paste.';
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
