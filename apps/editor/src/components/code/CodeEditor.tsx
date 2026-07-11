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
 * Task 8 adds completion + lint on top of this: keep new CM6 extensions
 * appended to the `extensions` array in the effect below rather than
 * reworking the EditorView lifecycle, so that task stays a small diff here.
 */
import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec, type Extension } from '@codemirror/state';
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

export interface CodeEditorProps {
  /** Project-relative script path. Only used to pick a language — the host
   * (CodePanel) forces a remount via `key` when the open script or its
   * content changes out from under the buffer, so this component never
   * needs to reconcile `value` against a live document itself. */
  path: string;
  value: string;
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
}

export default function CodeEditor({ path, value, onChange, onSave, checkScript }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Kept in refs so the extensions built once per mount always call the
  // latest handlers without forcing a full EditorView rebuild on every
  // CodePanel re-render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const checkScriptRef = useRef(checkScript);
  checkScriptRef.current = checkScript;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString());
    });

    const lang = languageForPath(path);
    // A stable wrapper (rather than passing checkScriptRef.current directly)
    // so the linter always calls the latest `checkScript` prop without
    // needing the extension itself rebuilt.
    const checkScriptStable = (source: string) => checkScriptRef.current(source);

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        ...languageExtensions(lang),
        codeTheme,
        saveKeymap,
        updateListener,
        lintGutter(),
        makeCheckScriptLinter(checkScriptStable, lang),
      ],
    });

    const view = new EditorView({ state, parent: host });

    return () => view.destroy();
    // Intentionally mount-once per `path` (the CodePanel key already forces a
    // remount on script switch or external reload): `value`/`onChange`/`onSave`
    // changing shouldn't tear down and rebuild the whole CM6 instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div className="code-editor-host" ref={hostRef} />;
}
