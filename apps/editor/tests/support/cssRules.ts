/**
 * Reading a stylesheet the way a browser reads it, for the tests that pin CSS.
 *
 * jsdom does no layout: every box measures zero by zero, so an overflow, a
 * clipped control or a floor that outgrows its container is invisible to the
 * whole suite. The rules those failures depend on are therefore asserted as
 * TEXT, in tests/composerReach.test.ts, tests/columnReach.test.ts and
 * tests/textReach.test.tsx.
 *
 * That only works if the reading is honest, and the first version of it was
 * not. Each of those files carried its own helper:
 *
 *   new RegExp(`^\\s*${selector}\\s*\\{([^}]*)\\}`, 'm').exec(css)
 *
 * `.exec` returns the FIRST match and stops. So a stylesheet could say
 * `flex-wrap: wrap` at the top of the file and `@media (max-width: 700px) {
 * .composer-row { flex-wrap: nowrap } }` at the bottom, reintroducing the
 * original bug at exactly the width where it strands the send button, and
 * every assertion still passed: the helper never looked past the first rule.
 * Verified before this file existed, by appending that media block to a copy
 * of chat.css and running the old suite green.
 *
 * So: parse every rule, keep the at-rule context each one sits in, and let the
 * tests assert about all of them at once. A property is pinned when EVERY rule
 * that sets it agrees, not when the first one does.
 */

/** One style rule, and the at-rules it is nested inside. */
export interface CssRule {
  /** The selector list exactly as written, whitespace collapsed. */
  selector: string;
  /** Everything between the braces. */
  body: string;
  /**
   * The at-rule preludes wrapped around it, outermost first. Empty at the top
   * level; `['@media (max-width: 700px)']` inside one media query. This is
   * what a failure message needs in order to name WHERE the bad rule is.
   */
  context: readonly string[];
}

/** Where a rule lives, for a failure message: the file's top level, or an at-rule. */
export function ruleLocation(rule: CssRule): string {
  return rule.context.length === 0 ? 'top level' : rule.context.join(' > ');
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every style rule in a stylesheet, including the ones inside at-rules.
 *
 * Brace-walking rather than one regex, because the thing that has to be caught
 * is precisely the rule nested one level down. `@keyframes` frames come back
 * too, with selectors like `from` and `40%`; they match no class query, so
 * they cost nothing and are not worth a special case.
 */
export function parseRules(css: string): CssRule[] {
  const clean = stripComments(css);
  const rules: CssRule[] = [];
  const context: string[] = [];
  let prelude = '';

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];

    if (ch === '}') {
      context.pop();
      prelude = '';
      continue;
    }

    if (ch !== '{') {
      prelude += ch;
      continue;
    }

    const head = prelude.trim().replace(/\s+/g, ' ');
    prelude = '';

    // A block at-rule (@media, @supports, @keyframes, @layer): descend.
    if (head.startsWith('@')) {
      context.push(head);
      continue;
    }

    // A style rule: take everything up to its matching close brace.
    let depth = 1;
    let end = i + 1;
    while (end < clean.length && depth > 0) {
      if (clean[end] === '{') depth += 1;
      else if (clean[end] === '}') depth -= 1;
      end += 1;
    }
    rules.push({ selector: head, body: clean.slice(i + 1, end - 1), context: [...context] });
    i = end - 1;
  }

  return rules;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every rule whose selector list uses this class, wherever it sits.
 *
 * The boundary guard is what keeps `.composer-row` from answering for
 * `.composer-row-gap`, and it is why this takes a class rather than a whole
 * selector: `.chat-column[data-mode='chat'] .conversation-head` targets the
 * head just as surely as `.conversation-head` does, and a test that only knew
 * about the bare selector would not see it.
 */
export function rulesUsingClass(css: string, className: string): CssRule[] {
  const bare = className.startsWith('.') ? className.slice(1) : className;
  const used = new RegExp(`\\.${escapeForRegExp(bare)}(?![\\w-])`);
  return parseRules(css).filter((rule) => used.test(rule.selector));
}

/**
 * Every rule written with exactly this selector list, wherever it sits.
 *
 * For selectors a class query cannot express, like `.composer-row > *`.
 * Whitespace is collapsed on both sides, so formatting cannot hide a rule.
 */
export function rulesWithSelector(css: string, selector: string): CssRule[] {
  const wanted = selector.trim().replace(/\s+/g, ' ');
  return parseRules(css).filter((rule) => rule.selector === wanted);
}

/**
 * Every value a rule body gives one property, in source order.
 *
 * An array rather than a single value because a body may state a property
 * twice, and because the caller usually wants to assert about all of them.
 * The property name is matched whole, so `flex` never answers for `flex-wrap`.
 */
export function declarations(body: string, property: string): string[] {
  const named = new RegExp(`^${escapeForRegExp(property)}$`);
  const found: string[] = [];
  for (const piece of body.split(';')) {
    const colon = piece.indexOf(':');
    if (colon === -1) continue;
    if (!named.test(piece.slice(0, colon).trim())) continue;
    found.push(piece.slice(colon + 1).trim().replace(/\s+/g, ' '));
  }
  return found;
}

/** Every value any of these rules gives one property, tagged with where it was written. */
export function everyDeclaration(
  rules: readonly CssRule[],
  property: string,
): { value: string; selector: string; where: string }[] {
  return rules.flatMap((rule) =>
    declarations(rule.body, property).map((value) => ({
      value,
      selector: rule.selector,
      where: ruleLocation(rule),
    })),
  );
}
