/**
 * The CM6 host. This is the only file the rest of the editor reaches
 * eagerly — always through `React.lazy(() => import('./CodeEditor'))` (see
 * ../CodePanel.tsx) — so the CodeMirror chunk is split out of the main
 * bundle and only loaded once a user opens the Code panel. `./completion`
 * and `./lint` also import CodeMirror packages (they build a
 * `CompletionSource` and a lint `Extension`), but since this file is their
 * only importer that matters, they still only ever load inside the lazy
 * chunk. `./scriptLanguage` stays CodeMirror-free on purpose — CodePanel.tsx
 * needs `languageForPath` outside the lazy boundary, to pick the `language`
 * param for its `checkScript` query.
 *
 * ONE EditorView for the whole panel: the Code panel is tabbed (many open
 * buffers), and per-tab undo history is the feature. Rather than remount a
 * view per tab (which throws away history), this component keeps a single
 * view and swaps its `EditorState` on tab switch — snapshotting the outgoing
 * state into the host-owned `stateCache` and restoring the incoming one via
 * `view.setState`. A cached state carries its own doc, selection, undo
 * history AND its language extensions, so a Lua tab and a JS tab can share
 * the same view. `revision` is the escape hatch for external reloads: when it
 * bumps for the current path, we throw that path's cache away and rebuild a
 * fresh state from the new `value`.
 */
import { useEffect, useRef } from 'react';
import { EditorView, keymap, Decoration, type DecorationSet } from '@codemirror/view';
import { EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { StreamLanguage } from '@codemirror/language';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { lintGutter } from '@codemirror/lint';
import { codeTheme } from './codeTheme';
import { ctxCompletionSource } from './completion';
import { makeCheckScriptLinter, type ScriptDiagnostic } from './lint';
import { languageForPath, type ScriptLanguage } from './scriptLanguage';

const luaLanguage = StreamLanguage.define(lua);

/**
 * Language support plus the ctx completion source, registered ADDITIVELY via
 * each language's `data` facet — the same channel @codemirror/lang-javascript
 * uses for its own snippet/keyword and local-variable sources. Never wire the
 * ctx source through `autocompletion({ override: [...] })`: the completion
 * plugin reads `conf.override || state.languageDataAt('autocomplete', ...)`,
 * so an override REPLACES every built-in language-data source (JS scripts
 * would silently lose local-variable and snippet completion). basicSetup's
 * own config-free `autocompletion()` picks all of these up.
 *
 * Exported for the no-override regression tests (completionWiring.test.ts),
 * which build a real EditorState from this and assert the built-in sources
 * remain present and functional alongside ours.
 */
export function languageExtensions(lang: ScriptLanguage): Extension[] {
  return lang === 'js'
    ? [javascript(), javascriptLanguage.data.of({ autocomplete: ctxCompletionSource('js') })]
    : [luaLanguage, luaLanguage.data.of({ autocomplete: ctxCompletionSource('lua') })];
}

// Transient "ember line" highlight for openScriptAt(path, line): a decoration
// on one line, cleared ~1.5s later. Lives in the state (so it survives while
// the tab is active) and is driven by a StateEffect. Module-level so the field
// identity is stable across the states this component builds.
const setEmberLine = StateEffect.define<number | null>();
const emberLineDeco = Decoration.line({ class: 'cm-ember-line' });
const emberLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setEmberLine)) {
        if (e.value === null) {
          deco = Decoration.none;
        } else {
          const lineNo = Math.max(1, Math.min(e.value, tr.state.doc.lines));
          const line = tr.state.doc.line(lineNo);
          deco = Decoration.set([emberLineDeco.range(line.from)]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Snapshot the outgoing buffer's state into the cache on a swap/teardown —
 * but only when the host still considers that path open. Without the guard,
 * closing the ACTIVE tab leaks: CodePanel deletes the cache entry in
 * doClose(), but the very next render switches `path` to a neighbour and the
 * swap effect would re-insert the just-closed path's full doc + undo history
 * into the Map, keeping it alive for the whole session. Exported for unit
 * testing (codePanelBuffers.test.ts) — pure with respect to its arguments.
 */
export function cacheOutgoingState(
  stateCache: Map<string, EditorState>,
  outgoingPath: string | null,
  state: EditorState,
  shouldCache: (path: string) => boolean,
): void {
  if (outgoingPath !== null && shouldCache(outgoingPath)) stateCache.set(outgoingPath, state);
}

export interface CodeEditorProps {
  /** Project-relative path of the active buffer. Drives both the language
   * and the state-cache swap (see the swap effect below). */
  path: string;
  /** Initial content for `path` — read only when building a FRESH state (a
   * first-time-shown buffer or an external reload). Live typing is not fed
   * back in: the view already owns the document. */
  value: string;
  /** Bumps only on an external reload of `path`; a change here (same path)
   * rebuilds that path's state from `value` and evicts its cache entry. */
  revision: number;
  /** Host-owned per-path EditorState cache. This component reads/writes it to
   * preserve each tab's undo history and selection across switches. */
  stateCache: Map<string, EditorState>;
  /** Whether a path is still an open buffer in the host. Consulted before
   * snapshotting an outgoing state into the cache, so a just-closed tab's
   * state isn't resurrected by the swap that follows its close (see
   * cacheOutgoingState). */
  shouldCacheState: (path: string) => boolean;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+S while the editor has focus. */
  onSave: () => void;
  /**
   * Syntax-check a candidate source string (wired by CodePanel to the
   * store's silent `query('checkScript', { source, language })`, which
   * already resolves to `null` — mapped here to no diagnostics — on a
   * failed/offline command). Debounced ~500ms by the lint extension itself.
   */
  checkScript: (source: string) => Promise<ScriptDiagnostic[]>;
  /** When the nonce changes, scroll to `line` (1-based) and flash it. */
  focusRequest?: { line: number; nonce: number } | null;
  /** When the nonce changes, replace the whole doc with `text` (preserving
   * undo history + selection mapping) — the formatted-on-save result. */
  applyContent?: { text: string; nonce: number } | null;
}

export default function CodeEditor({
  path,
  value,
  revision,
  stateCache,
  shouldCacheState,
  onChange,
  onSave,
  checkScript,
  focusRequest,
  applyContent,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The (path, revision) the view currently holds — so the swap effect can
  // tell a tab switch (path changed → restore cache) from an external reload
  // (same path, revision bumped → rebuild fresh) and skip its own mount run.
  const shownPathRef = useRef<string | null>(null);
  const shownRevRef = useRef<number>(revision);

  // Latest values/handlers in refs so a single set of extensions (built per
  // state) always calls through to the current props without rebuilding the
  // view. `value` is here too, so buildState always reads the freshest doc.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const checkScriptRef = useRef(checkScript);
  checkScriptRef.current = checkScript;
  const shouldCacheStateRef = useRef(shouldCacheState);
  shouldCacheStateRef.current = shouldCacheState;

  // Build a full EditorState for a given path + doc. Every state carries its
  // own language extensions, so states for different languages swap freely
  // into the one view. The handler extensions read refs, so the closures here
  // never go stale even though the state is built once and kept.
  const buildStateRef = useRef<(p: string, doc: string) => EditorState>(() => EditorState.create({}));
  buildStateRef.current = (p: string, doc: string): EditorState => {
    const saveKeymap = Prec.highest(
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
      ]),
    );
    // Note: basicSetup's searchKeymap also binds Mod-d to "select next
    // occurrence" — this intentionally shadows the editor-wide Duplicate
    // keybind (keybinds.ts) while the Code panel has focus, since the global
    // dispatcher's isTypingTarget guard already skips this contenteditable
    // surface. Not a bug; documented so a future reader investigating
    // "duplicate doesn't work in the Code panel" doesn't file it as one.
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString());
    });
    const lang = languageForPath(p);
    const checkScriptStable = (source: string) => checkScriptRef.current(source);
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        ...languageExtensions(lang),
        codeTheme,
        saveKeymap,
        updateListener,
        lintGutter(),
        makeCheckScriptLinter(checkScriptStable, lang),
        emberLineField,
      ],
    });
  };

  // Mount once: create the view with the initial state for the active buffer
  // (a cached state if we somehow already have one, else fresh from `value`).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = stateCache.get(path) ?? buildStateRef.current(path, valueRef.current);
    const view = new EditorView({ state: initial, parent: host });
    viewRef.current = view;
    shownPathRef.current = path;
    shownRevRef.current = revision;
    return () => {
      // Preserve the current buffer's state (if it's still open) for a later
      // reopen, then tear down.
      cacheOutgoingState(stateCache, shownPathRef.current, view.state, shouldCacheStateRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // Mount-once; the swap effect below handles every subsequent path/revision
    // change against the single view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap on tab switch or external reload — never a remount (that is the whole
  // point: undo history survives a switch).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const shownPath = shownPathRef.current;
    const shownRev = shownRevRef.current;
    if (shownPath === path && shownRev === revision) return; // mount run, or nothing changed

    if (shownPath !== path) {
      // Tab switch: snapshot the outgoing buffer (unless the host just closed
      // it — a closed tab's state must not be resurrected into the cache),
      // then restore (or first-build) the incoming one. Cached state brings
      // its undo history and selection back.
      cacheOutgoingState(stateCache, shownPath, view.state, shouldCacheStateRef.current);
      const cached = stateCache.get(path);
      view.setState(cached ?? buildStateRef.current(path, valueRef.current));
    } else {
      // Same path, revision bumped: external reload. Throw the stale cache
      // away and rebuild from the freshly-read content.
      stateCache.delete(path);
      view.setState(buildStateRef.current(path, valueRef.current));
    }
    shownPathRef.current = path;
    shownRevRef.current = revision;
  }, [path, revision, stateCache]);

  // Formatted-on-save: replace the whole doc in ONE transaction so undo
  // history and selection mapping are preserved (a fresh setState would drop
  // both). Guarded by nonce so it fires once per save.
  const appliedNonceRef = useRef<number | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !applyContent) return;
    if (appliedNonceRef.current === applyContent.nonce) return;
    appliedNonceRef.current = applyContent.nonce;
    if (applyContent.text === view.state.doc.toString()) return; // no-op if already formatted
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: applyContent.text } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyContent?.nonce]);

  // openScriptAt(path, line): scroll to the line, put the caret there, flash an
  // ember highlight that fades after ~1.5s.
  const focusedNonceRef = useRef<number | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !focusRequest) return;
    if (focusedNonceRef.current === focusRequest.nonce) return;
    focusedNonceRef.current = focusRequest.nonce;
    const lineNo = Math.max(1, Math.min(focusRequest.line, view.state.doc.lines));
    const pos = view.state.doc.line(lineNo).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: [EditorView.scrollIntoView(pos, { y: 'center' }), setEmberLine.of(lineNo)],
    });
    view.focus();
    const timer = window.setTimeout(() => {
      const v = viewRef.current;
      if (v) v.dispatch({ effects: setEmberLine.of(null) });
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  return <div className="code-editor-host" ref={hostRef} />;
}
