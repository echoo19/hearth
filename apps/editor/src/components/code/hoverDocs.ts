/**
 * `ctx.` hover docs for the Code panel: a pure identifier/path extractor
 * (`ctxChainMatchAt`, `ctxDocAt`) that's testable without CodeMirror, plus
 * the CM6 `hoverTooltip` extension (`ctxHoverExtension`) that wires it into
 * the editor. Sourced exclusively from `resolveCtxPath` (completion.ts) —
 * the same CTX_API trie `ctxCompletionSource` reads from — so hover docs can
 * never drift from what completion already offers; completion.test.ts's
 * drift-guard test (which walks the real `CTX_API` import against that same
 * trie) already covers this file's only data dependency.
 *
 * Imported ONLY from CodeEditor.tsx: this file pulls in `@codemirror/view`,
 * so it must stay inside the lazy CodeMirror chunk (see CodeEditor.tsx's
 * header comment on the lazy boundary).
 */
import { hoverTooltip, type Tooltip } from '@codemirror/view';
import type { CtxApiEntry } from '@hearth/core';
import { resolveCtxPath } from './completion';
import type { ScriptLanguage } from './scriptLanguage';

/**
 * Matches a `ctx` identifier followed by one or more `.segment` groups,
 * anywhere on the line — unlike `CTX_PATH_RE` in completion.ts (which is
 * anchored to "immediately before the cursor" for autocomplete), a hover can
 * land on any segment of an already-typed chain, so this has no `$` anchor
 * and is scanned with `exec` in a loop to find the chain containing `col`.
 * The negative lookbehind keeps a longer identifier merely ending in "ctx"
 * (`myctx.foo`) from matching, mirroring completion.ts.
 */
const CTX_CHAIN_RE = /(?<![\w$])ctx(?:\.\w+)+/g;

/** A `ctx.` chain match at a hover column: the dot path up to and including
 * the hovered segment (no leading "ctx."), and that segment's `[from, to)`
 * range within `lineText` — used to anchor/size the hover tooltip to just
 * the hovered identifier, not the whole chain. */
export interface CtxHoverMatch {
  path: string;
  from: number;
  to: number;
}

/**
 * Find the `ctx.` path segment under `col` (both 0-based character offsets
 * within `lineText`). Returns null when `col` isn't inside any `ctx.` chain
 * on the line, or lands on the bare `ctx` token itself before its first dot
 * (hovering "ctx" alone isn't a documented path).
 */
export function ctxChainMatchAt(lineText: string, col: number): CtxHoverMatch | null {
  CTX_CHAIN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CTX_CHAIN_RE.exec(lineText))) {
    const chainStart = match.index;
    const chainEnd = chainStart + match[0].length;
    if (col < chainStart || col > chainEnd) continue;
    const ctxEnd = chainStart + 'ctx'.length;
    if (col <= ctxEnd) return null;

    const segments: string[] = [];
    let segStart = ctxEnd + 1; // right after the dot preceding this segment
    for (const segment of match[0].slice('ctx.'.length).split('.')) {
      const segEnd = segStart + segment.length;
      segments.push(segment);
      if (col <= segEnd) return { path: segments.join('.'), from: chainStart, to: segEnd };
      segStart = segEnd + 1; // skip the next dot
    }
    return null; // unreachable: the outer bounds check already guarantees col <= chainEnd
  }
  return null;
}

/**
 * Pure lookup: resolve the CTX_API entry for the `ctx.` path segment under
 * `col` on `lineText` — null when the column isn't over a ctx path, sits on
 * the bare "ctx" token, or the path is partial/unresolved (e.g. "ctx.sce",
 * which isn't a real segment of the tree). Testable without CodeMirror.
 */
export function ctxDocAt(lineText: string, col: number): CtxApiEntry | null {
  const match = ctxChainMatchAt(lineText, col);
  if (!match) return null;
  return resolveCtxPath(match.path) ?? null;
}

/** Build the tooltip DOM for a resolved entry: signature (monospace),
 * description, and — when present for `language` — a small formatted
 * example. Plain DOM, no framework: `hoverTooltip`'s `create()` contract. */
function buildTooltipDom(entry: CtxApiEntry, language: ScriptLanguage): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-ctx-hover';

  const signature = document.createElement('div');
  signature.className = 'cm-ctx-hover-signature';
  signature.textContent = entry.signature;
  dom.appendChild(signature);

  const description = document.createElement('p');
  description.className = 'cm-ctx-hover-description';
  description.textContent = entry.description;
  dom.appendChild(description);

  const example = entry.example?.[language];
  if (example) {
    const pre = document.createElement('pre');
    pre.className = 'cm-ctx-hover-example';
    pre.textContent = example;
    dom.appendChild(pre);
  }

  return dom;
}

/**
 * `hoverTooltip` extension: shows `ctx.` API docs on hover (300ms default
 * hover delay). `language` picks which of an entry's `{ js, lua }` examples
 * to render, matching the buffer's own language. Register next to
 * `ctxCompletionSource` in CodeEditor's `languageExtensions`.
 */
export function ctxHoverExtension(language: ScriptLanguage) {
  return hoverTooltip((view, pos): Tooltip | null => {
    const line = view.state.doc.lineAt(pos);
    const match = ctxChainMatchAt(line.text, pos - line.from);
    if (!match) return null;
    const entry = resolveCtxPath(match.path);
    if (!entry) return null;
    return {
      pos: line.from + match.from,
      end: line.from + match.to,
      arrow: false,
      create: () => ({ dom: buildTooltipDom(entry, language) }),
    };
  });
}
