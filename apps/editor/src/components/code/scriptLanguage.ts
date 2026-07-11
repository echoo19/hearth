/**
 * The scripting language type and the path→language inference, split out of
 * CodeEditor.tsx so callers that need it (CodePanel.tsx, to pick the
 * `language` param for a `checkScript` query; completion.ts and lint.ts, for
 * their exported function signatures) never have to import CodeEditor.tsx
 * itself — that file is the ONLY one allowed to import CodeMirror packages
 * (see its module doc), and it must stay reachable only through the lazy
 * `React.lazy(() => import('./CodeEditor'))` boundary in CodePanel.tsx. A
 * plain value import of anything from CodeEditor.tsx would pull the whole
 * CodeMirror chunk back into the main bundle.
 */
export type ScriptLanguage = 'lua' | 'js';

/** Infer the scripting language from a project-relative script path. */
export function languageForPath(path: string): ScriptLanguage {
  return path.endsWith('.js') || path.endsWith('.ts') ? 'js' : 'lua';
}
