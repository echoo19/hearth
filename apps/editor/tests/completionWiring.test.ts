/**
 * Regression tests for HOW the ctx completion source is wired into the
 * editor (the no-override contract), separate from completion.test.ts which
 * covers WHAT the source completes.
 *
 * The bug this pins: `autocompletion({ override: [ctxCompletionSource(...)] })`
 * REPLACES every language-data completion source (@codemirror/autocomplete's
 * update loop does `sources = conf.override || state.languageDataAt(...)`),
 * which silently dropped @codemirror/lang-javascript's built-in snippet and
 * local-variable completion for .js scripts. The ctx source must instead be
 * registered additively via each language's `data` facet, so these tests
 * build a real EditorState from the exported `languageExtensions()` and
 * assert the built-in sources are still present and functional alongside ours.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { languageExtensions } from '../src/components/code/CodeEditor';
import type { ScriptLanguage } from '../src/components/code/scriptLanguage';

function stateFor(language: ScriptLanguage, doc: string): EditorState {
  return EditorState.create({ doc, extensions: languageExtensions(language) });
}

/** All language-data completion sources active at `pos` — exactly what the
 * autocompletion plugin reads when no `override` is configured. */
function sourcesAt(state: EditorState, pos: number): readonly CompletionSource[] {
  return state.languageDataAt<CompletionSource>('autocomplete', pos);
}

/** Run every source (sync results only — ours and lang-javascript's all are)
 * and pool the option labels. */
function allCompletionLabels(state: EditorState, pos: number): string[] {
  const context = new CompletionContext(state, pos, false);
  const labels: string[] = [];
  for (const source of sourcesAt(state, pos)) {
    const result = source(context);
    if (result && typeof (result as Promise<unknown>).then !== 'function') {
      for (const option of (result as CompletionResult).options) labels.push(option.label);
    }
  }
  return labels;
}

describe('completion wiring (no-override contract)', () => {
  it('js: keeps multiple language-data sources — the built-ins are not overridden away', () => {
    const state = stateFor('js', 'const x = 1;');
    // lang-javascript contributes two sources (snippets/keywords + locals);
    // the ctx source must be IN ADDITION to them, never a replacement.
    expect(sourcesAt(state, 0).length).toBeGreaterThanOrEqual(3);
  });

  it('js: a locally declared variable still completes (lang-javascript localCompletionSource)', () => {
    const doc = 'const myLocalCounter = 1;\nmyLo';
    const state = stateFor('js', doc);
    expect(allCompletionLabels(state, doc.length)).toContain('myLocalCounter');
  });

  it('js: a built-in keyword/snippet completion still fires (lang-javascript completeFromList)', () => {
    const doc = 'fun';
    const state = stateFor('js', doc);
    expect(allCompletionLabels(state, doc.length)).toContain('function');
  });

  it('js: the ctx source is registered and fires through the same language-data channel', () => {
    const doc = 'ctx.sce';
    const state = stateFor('js', doc);
    expect(allCompletionLabels(state, doc.length)).toContain('scene');
  });

  it('lua: the ctx source fires through language data', () => {
    const doc = 'ctx.scene.sp';
    const state = stateFor('lua', doc);
    const labels = allCompletionLabels(state, doc.length);
    expect(labels).toContain('spawn');
    expect(labels).toContain('spawnPrefab');
  });

  it('lua: bare keyword completion fires through language data', () => {
    const doc = 'fun';
    const state = stateFor('lua', doc);
    expect(allCompletionLabels(state, doc.length)).toContain('function');
  });
});
