/**
 * `ctx.` completion for the Code panel, built from `CTX_API` (the same
 * machine-readable reference agents and generated docs use — see
 * packages/core/src/ctxApi.ts). A prefix tree is derived from the real
 * imported array once at module load, so this file can never silently drift
 * from CTX_API the way a hand-maintained completion list could (see
 * `resolveCtxPath` and its drift-guard test in completion.test.ts).
 *
 * Lua scripts get a second, unrelated completion source: a short static list
 * of reserved words, since CodeMirror's legacy Lua stream-mode has no
 * language-data-driven keyword completion of its own.
 */
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { CTX_API, type CtxApiEntry } from '@hearth/core';
import type { ScriptLanguage } from './scriptLanguage';

interface TrieNode {
  children: Map<string, TrieNode>;
  entry?: CtxApiEntry;
}

function buildCtxTree(entries: readonly CtxApiEntry[]): TrieNode {
  const root: TrieNode = { children: new Map() };
  for (const entry of entries) {
    let node = root;
    for (const segment of entry.path.split('.')) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.entry = entry;
  }
  return root;
}

const CTX_TREE = buildCtxTree(CTX_API);

/**
 * Resolve a dot path (e.g. "scene.spawn", without the leading `ctx.`) by
 * walking the same tree the completion source reads from. Used by the
 * drift-guard test: it iterates the real `CTX_API` import and asserts every
 * entry's path resolves here, so a hand-forked copy of the API surface
 * (rather than an import) would fail the test.
 */
export function resolveCtxPath(path: string): CtxApiEntry | undefined {
  let node: TrieNode = CTX_TREE;
  for (const segment of path.split('.')) {
    const child = node.children.get(segment);
    if (!child) return undefined;
    node = child;
  }
  return node.entry;
}

/**
 * Text immediately before the cursor must be `ctx` followed by one or more
 * `.segment` groups, the last of which may be a partial word being typed —
 * e.g. `ctx.`, `ctx.sce`, `ctx.scene.sp`. The negative lookbehind keeps a
 * longer identifier that merely ends in "ctx" (`myctx.foo`) from matching.
 */
const CTX_PATH_RE = /(?<![\w$])ctx\.(?:\w+\.)*\w*$/;

function ctxOptionsFor(node: TrieNode, prefix: string): Completion[] {
  const options: Completion[] = [];
  for (const [key, child] of node.children) {
    if (!key.startsWith(prefix)) continue;
    options.push({
      label: key,
      type: child.entry?.kind ?? 'namespace',
      info: child.entry ? `${child.entry.signature}\n\n${child.entry.description}` : undefined,
    });
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  return options;
}

/** Reserved words for Lua 5.3 — CodeMirror's legacy stream-mode Lua language has no built-in keyword completion. */
const LUA_KEYWORDS = [
  'and',
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'false',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'local',
  'nil',
  'not',
  'or',
  'repeat',
  'return',
  'then',
  'true',
  'until',
  'while',
];

const LUA_WORD_RE = /[A-Za-z_]\w*$/;

/**
 * `CompletionSource` for the Code panel: completes `ctx.` paths from
 * CTX_API for both languages, plus bare Lua keywords for `.lua` scripts.
 */
export function ctxCompletionSource(language: ScriptLanguage): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const ctxMatch = context.matchBefore(CTX_PATH_RE);
    if (ctxMatch) {
      const afterCtx = ctxMatch.text.slice('ctx.'.length);
      const segments = afterCtx.split('.');
      const prefix = segments.pop() ?? '';
      let node: TrieNode = CTX_TREE;
      for (const segment of segments) {
        const child = node.children.get(segment);
        if (!child) return null;
        node = child;
      }
      const options = ctxOptionsFor(node, prefix);
      if (options.length === 0) return null;
      return { from: ctxMatch.to - prefix.length, options, validFor: /^\w*$/ };
    }

    if (language === 'lua') {
      const wordMatch = context.matchBefore(LUA_WORD_RE);
      if (wordMatch && (wordMatch.text.length > 0 || context.explicit)) {
        const options = LUA_KEYWORDS.filter((kw) => kw.startsWith(wordMatch.text)).map(
          (label): Completion => ({ label, type: 'keyword' }),
        );
        if (options.length === 0) return null;
        return { from: wordMatch.from, options, validFor: /^\w*$/ };
      }
    }

    return null;
  };
}
