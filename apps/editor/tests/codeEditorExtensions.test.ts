/**
 * Regression test for the in-file search wiring in CodeEditor.tsx.
 *
 * @codemirror/search's `searchKeymap` (Mod-f, F3, …) is already bound by
 * `basicSetup` — but basicSetup never calls `search()` itself, and its
 * commands (`openSearchPanel`, `findNext`, `getSearchQuery`, …) read a state
 * field that only `search()` provides. Without it, those commands throw at
 * runtime the first time a user presses Mod-f. This builds a real
 * `EditorState` from the exact extension list CodeEditor.tsx composes
 * (`languageExtensions` + the exported `searchExtensions`) and asserts the
 * search state is actually queryable — no DOM/EditorView needed for this
 * part, since `getSearchQuery`/`searchPanelOpen` only read state.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { languageExtensions, searchExtensions } from '../src/components/code/CodeEditor';

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [...languageExtensions('lua'), ...searchExtensions] });
}

describe('CodeEditor search wiring', () => {
  it('provides a queryable search state (search() extension present)', () => {
    const state = stateFor('local x = 1');
    // Would throw "No search state field available" without search({top:true}).
    expect(() => getSearchQuery(state)).not.toThrow();
    expect(getSearchQuery(state).search).toBe('');
  });

  it('starts with the search panel closed', () => {
    const state = stateFor('local x = 1');
    expect(searchPanelOpen(state)).toBe(false);
  });

  it('restates the search panel phrases in plain language', () => {
    const state = stateFor('local x = 1');
    expect(state.phrase('Find')).toBe('Find');
    expect(state.phrase('Replace')).toBe('Replace');
    expect(state.phrase('next')).toBe('next');
    expect(state.phrase('previous')).toBe('previous');
    expect(state.phrase('all')).toBe('all');
  });

  it('does not throw when the js extension set is combined with search', () => {
    expect(() =>
      EditorState.create({ doc: 'const x = 1', extensions: [...languageExtensions('js'), ...searchExtensions] }),
    ).not.toThrow();
  });
});
