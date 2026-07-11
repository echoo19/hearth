/**
 * The CM6 host. This is the ONLY file in the editor that imports CodeMirror
 * packages — always reach it through `React.lazy(() => import('./CodeEditor'))`
 * (see ../CodePanel.tsx) so the CodeMirror chunk is split out of the main
 * bundle and only loaded once a user opens the Code panel.
 *
 * Task 8 adds completion + lint on top of this: keep new CM6 extensions
 * appended to the `extensions` array in the effect below rather than
 * reworking the EditorView lifecycle, so that task stays a small diff here.
 */
import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage, type LanguageSupport } from '@codemirror/language';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { codeTheme } from './codeTheme';

export type ScriptLanguage = 'lua' | 'js';

/** Infer the scripting language from a project-relative script path. */
export function languageForPath(path: string): ScriptLanguage {
  return path.endsWith('.js') || path.endsWith('.ts') ? 'js' : 'lua';
}

const luaLanguage = StreamLanguage.define(lua);

function languageExtension(lang: ScriptLanguage): LanguageSupport | typeof luaLanguage {
  return lang === 'js' ? javascript() : luaLanguage;
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
}

export default function CodeEditor({ path, value, onChange, onSave }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Kept in refs so the extensions built once per mount always call the
  // latest handlers without forcing a full EditorView rebuild on every
  // CodePanel re-render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

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

    const state = EditorState.create({
      doc: value,
      extensions: [basicSetup, languageExtension(languageForPath(path)), codeTheme, saveKeymap, updateListener],
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
