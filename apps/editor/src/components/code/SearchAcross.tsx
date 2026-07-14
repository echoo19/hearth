/**
 * Cross-script search/replace UI (Task 9). Plain React — NO CodeMirror value
 * import, on purpose: CodePanel.tsx mounts this eagerly (it lives outside the
 * `lazy(() => import('./code/CodeEditor'))` boundary), so pulling in a CM6
 * package here would drag the CM chunk back into the main bundle before the
 * Code panel is even opened.
 *
 * Talks to the engine directly via `apiCommand` (searchScripts read-only,
 * replaceInScripts's dryRun preview) rather than the store's `query`/`exec`
 * wrappers for those two calls: both wrappers unconditionally log command
 * errors to the Console, which would put a bad-regex bounce (INVALID_INPUT)
 * in the Console — the spec calls for that inline under the query input
 * instead. A regex query is also pre-validated client-side with the exact
 * same pattern/flags the engine's buildQueryRegex uses (see
 * `validateQueryRegex`), so most bad patterns never make the round trip at
 * all. The one exception is the real (non-dryRun) "Replace all", which DOES
 * go through the store's `exec()` — it needs the same commandSeq bump +
 * refresh() every other mutation gets (so e.g. the Diff panel picks up the
 * change), and by that point the query has already round-tripped cleanly
 * once via Preview, so a genuine failure there (a mid-flight disk error) is
 * rare enough that a Console line is the right amount of noise.
 *
 * Buffer refresh interplay: replaceInScripts's journal entries are stamped
 * `source: 'editor'` (every command this server runs is, regardless of which
 * panel triggered it — see projectServer.ts), and `decideExternalChange`
 * deliberately ignores same-source entries (they're assumed to be a buffer's
 * own save echoing back). That assumption doesn't hold for a cross-script
 * replace, which can touch OTHER open buffers than whichever one this panel
 * happens to have active. So this component doesn't rely on the journal-feed
 * follow effect at all for its own mutation — it hands the exact list of
 * changed paths back to CodePanel via `onReplaceApplied`, which resolves
 * each one through the very same `decideExternalChange`/reload/banner path
 * the journal effect uses, just called directly instead of inferred from a
 * feed.
 */
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { apiCommand } from '../../api';
import { useEditor } from '../../store';
import { comboDisplay } from '../../keybinds';
import { Icon } from '../ui';
import { Button, IconButton } from '../ui/Button';

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests (searchAcross.test.ts). No DOM, no
// store access; every side-effecting call in the component funnels through
// these before touching the network or the store.
// ---------------------------------------------------------------------------

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SearchGroup {
  path: string;
  matches: SearchMatch[];
}

/** Buckets a flat searchScripts match list by path, preserving each match's
 * relative order within its group (and first-seen order across groups). */
export function groupMatchesByPath(matches: SearchMatch[]): SearchGroup[] {
  const order: string[] = [];
  const byPath = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    let bucket = byPath.get(m.path);
    if (!bucket) {
      bucket = [];
      byPath.set(m.path, bucket);
      order.push(m.path);
    }
    bucket.push(m);
  }
  return order.map((path) => ({ path, matches: byPath.get(path)! }));
}

/** The "14 matches in 3 scripts" summary line (and the quiet "No matches" case). */
export function matchSummaryText(total: number, fileCount: number): string {
  if (total === 0) return 'No matches';
  const matchWord = total === 1 ? 'match' : 'matches';
  const scriptWord = fileCount === 1 ? 'script' : 'scripts';
  return `${total} ${matchWord} in ${fileCount} ${scriptWord}`;
}

/** searchScripts/replaceInScripts both cap at 500 results server-side. */
const RESULT_CAP = 500;

export function cappedHintText(capped: boolean): string | null {
  if (!capped) return null;
  return `Showing the first ${RESULT_CAP} matches — narrow your search text to see the rest.`;
}

/**
 * Client-side mirror of the engine's buildQueryRegex (scriptCommands.ts):
 * same pattern-vs-escaped choice, same flags. In plain-text mode the query
 * is always a valid pattern (it gets escaped), so this only ever rejects in
 * regex mode — letting the UI show the exact engine-shaped message inline
 * without a round trip.
 */
export function validateQueryRegex(query: string, regexMode: boolean, caseSensitive: boolean): string | null {
  if (!regexMode || query.length === 0) return null;
  try {
    new RegExp(query, 'g' + (caseSensitive ? '' : 'i'));
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export interface HighlightSpan {
  before: string;
  match: string;
  after: string;
}

/** Splits a result row's preview text around the first match, for emphasis.
 * Best-effort: the preview is a cropped/trimmed window of the source line
 * (see the engine's buildPreview), so a query that doesn't re-match inside
 * that window (rare edge case at the crop boundary) just renders unemphasized. */
export function highlightMatch(preview: string, query: string, regexMode: boolean, caseSensitive: boolean): HighlightSpan | null {
  if (query.length === 0) return null;
  let re: RegExp;
  try {
    const pattern = regexMode ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch {
    return null;
  }
  const m = re.exec(preview);
  if (!m) return null;
  return { before: preview.slice(0, m.index), match: m[0], after: preview.slice(m.index + m[0].length) };
}

// ---- Replace flow state machine --------------------------------------------
// idle -> previewing (dryRun request in flight, then loaded with per-file
// counts) -> applying -> done. Cancel resets to idle from anywhere. A failed
// preview drops back to idle (nothing to show yet); a failed apply falls
// back to previewing (keeps the counts on screen so Replace all can retry).

export interface ReplaceChange {
  path: string;
  count: number;
  preview?: string;
}

export interface ReplaceFlowState {
  status: 'idle' | 'previewing' | 'applying' | 'done';
  loading: boolean;
  changes: ReplaceChange[];
  total: number;
  filesChanged: number;
  totalReplaced: number;
  error: string | null;
}

export const initialReplaceFlowState: ReplaceFlowState = {
  status: 'idle',
  loading: false,
  changes: [],
  total: 0,
  filesChanged: 0,
  totalReplaced: 0,
  error: null,
};

export type ReplaceFlowAction =
  | { type: 'PREVIEW_START' }
  | { type: 'PREVIEW_SUCCESS'; changes: ReplaceChange[]; total: number }
  | { type: 'PREVIEW_ERROR'; message: string }
  | { type: 'APPLY_START' }
  | { type: 'APPLY_SUCCESS'; filesChanged: number; totalReplaced: number }
  | { type: 'APPLY_ERROR'; message: string }
  | { type: 'CANCEL' };

export function replaceFlowReducer(state: ReplaceFlowState, action: ReplaceFlowAction): ReplaceFlowState {
  switch (action.type) {
    case 'PREVIEW_START':
      // A fresh preview always clears any stale results/error from a prior run.
      return { ...initialReplaceFlowState, status: 'previewing', loading: true };
    case 'PREVIEW_SUCCESS':
      if (state.status !== 'previewing') return state;
      return { ...state, loading: false, changes: action.changes, total: action.total, error: null };
    case 'PREVIEW_ERROR':
      // Deliberately NOT gated to status === 'previewing': runPreview's
      // client-side regex pre-validation dispatches this straight from idle
      // (or done, on a re-run) before any PREVIEW_START — a first-use bad
      // pattern must still surface. Only an apply genuinely in flight is
      // off-limits, so a stray preview error can't clobber it.
      if (state.status === 'applying') return state;
      return { ...initialReplaceFlowState, error: action.message };
    case 'APPLY_START':
      if (state.status !== 'previewing' || state.loading) return state;
      return { ...state, status: 'applying', loading: true, error: null };
    case 'APPLY_SUCCESS':
      if (state.status !== 'applying') return state;
      return { ...state, status: 'done', loading: false, filesChanged: action.filesChanged, totalReplaced: action.totalReplaced };
    case 'APPLY_ERROR':
      if (state.status !== 'applying') return state;
      return { ...state, status: 'previewing', loading: false, error: action.message };
    case 'CANCEL':
      return { ...initialReplaceFlowState };
    default:
      return state;
  }
}

/**
 * Whether an edit to query/regexMode/caseSensitive/replacement should reset
 * an already-run replace flow back to idle. Preview only predicts what
 * Replace all does for the exact inputs it ran against; once the query,
 * flags, or replacement text change, a 'previewing' result (or a stale
 * 'done' summary) no longer matches what Replace all would send, so the
 * flow must be invalidated and re-previewed before Replace all is offered
 * again. An in-flight 'applying' apply is intentionally left alone — it was
 * already dispatched with the inputs at that moment.
 */
export function shouldResetReplaceFlow(status: ReplaceFlowState['status']): boolean {
  return status === 'previewing' || status === 'done';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SearchResponse {
  matches: SearchMatch[];
  total: number;
  capped: boolean;
}

interface ReplaceResponse {
  changes: ReplaceChange[];
  total: number;
  applied: boolean;
}

/** A search result row flattened for keyboard nav, independent of how
 * `groupMatchesByPath` happens to bucket the list for display. */
interface FlatRow {
  match: SearchMatch;
  groupPath: string;
}

export interface SearchAcrossProps {
  /** Bumped by the global keybind (and re-firable while already open) to
   * (re)focus + select-all the query input — see keybinds.ts's `allowWhileTyping`
   * 'search-scripts' row. */
  focusNonce: number;
  /** Esc, or the header toggle closing an already-open panel. */
  onClose: () => void;
  /** Fired once a real (non-dryRun) replace succeeds, with every touched
   * path — CodePanel reconciles its open buffers against this list. */
  onReplaceApplied: (paths: string[]) => void;
}

export function SearchAcross({ focusNonce, onClose, onReplaceApplied }: SearchAcrossProps) {
  const projectPath = useEditor((s) => s.projectPath);
  const openScriptAt = useEditor((s) => s.openScriptAt);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);

  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexMode, setRegexMode] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState('');

  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const [replaceFlow, dispatchReplace] = useReducer(replaceFlowReducer, initialReplaceFlowState);

  const queryRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Autofocus on mount, and refocus+select-all on every keybind repress
  // (even while already open — mirrors browser Cmd+F).
  useEffect(() => {
    queryRef.current?.focus();
    queryRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  async function runSearch() {
    const q = query.trim();
    if (!projectPath) {
      setSearchError('Open a project to search its scripts.');
      return;
    }
    if (!q) {
      setResults(null);
      setSearchError(null);
      return;
    }
    const regexErr = validateQueryRegex(q, regexMode, caseSensitive);
    if (regexErr) {
      setSearchError(regexErr);
      setResults(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    const res = await apiCommand<SearchResponse>(projectPath, 'searchScripts', {
      query: q,
      regex: regexMode,
      caseSensitive,
    });
    setSearching(false);
    if (!res.success || !res.data) {
      setSearchError(res.errors[0]?.message ?? 'Search failed.');
      setResults(null);
      return;
    }
    setResults(res.data);
    setActiveIndex(0);
  }

  async function runPreview() {
    const q = query.trim();
    if (!projectPath || !q) return;
    const regexErr = validateQueryRegex(q, regexMode, caseSensitive);
    if (regexErr) {
      dispatchReplace({ type: 'PREVIEW_ERROR', message: regexErr });
      return;
    }
    dispatchReplace({ type: 'PREVIEW_START' });
    const res = await apiCommand<ReplaceResponse>(projectPath, 'replaceInScripts', {
      query: q,
      replacement,
      regex: regexMode,
      caseSensitive,
      dryRun: true,
    });
    if (!res.success || !res.data) {
      dispatchReplace({ type: 'PREVIEW_ERROR', message: res.errors[0]?.message ?? 'Preview failed.' });
      return;
    }
    dispatchReplace({ type: 'PREVIEW_SUCCESS', changes: res.data.changes, total: res.data.total });
  }

  async function runApply() {
    const q = query.trim();
    if (!projectPath || !q) return;
    dispatchReplace({ type: 'APPLY_START' });
    const result = await exec<ReplaceResponse>(
      'replaceInScripts',
      { query: q, replacement, regex: regexMode, caseSensitive, dryRun: false },
      { quiet: true },
    );
    if (!result.success || !result.data) {
      dispatchReplace({ type: 'APPLY_ERROR', message: result.errors[0]?.message ?? 'Replace failed.' });
      return;
    }
    const { changes, total } = result.data;
    dispatchReplace({ type: 'APPLY_SUCCESS', filesChanged: changes.length, totalReplaced: total });
    onReplaceApplied(changes.map((c) => c.path));
    const matchWord = total === 1 ? 'match' : 'matches';
    const scriptWord = changes.length === 1 ? 'script' : 'scripts';
    log('info', 'command', `Replaced ${total} ${matchWord} across ${changes.length} ${scriptWord}.`);
  }

  function cancelReplace() {
    dispatchReplace({ type: 'CANCEL' });
  }

  // Any edit to the query/flags/replacement while a preview is on screen (or
  // a replace just completed) invalidates it — see shouldResetReplaceFlow.
  // Replace all must never fire against stale counts.
  function updateQuery(value: string) {
    setQuery(value);
    if (shouldResetReplaceFlow(replaceFlow.status)) dispatchReplace({ type: 'CANCEL' });
  }

  function toggleCaseSensitive() {
    setCaseSensitive((v) => !v);
    if (shouldResetReplaceFlow(replaceFlow.status)) dispatchReplace({ type: 'CANCEL' });
  }

  function toggleRegexMode() {
    setRegexMode((v) => !v);
    if (shouldResetReplaceFlow(replaceFlow.status)) dispatchReplace({ type: 'CANCEL' });
  }

  function updateReplacement(value: string) {
    setReplacement(value);
    if (shouldResetReplaceFlow(replaceFlow.status)) dispatchReplace({ type: 'CANCEL' });
  }

  const groups = results ? groupMatchesByPath(results.matches) : [];
  const rows: FlatRow[] = groups.flatMap((g) => g.matches.map((m) => ({ match: m, groupPath: g.path })));

  function selectRow(row: FlatRow) {
    openScriptAt(row.match.path, row.match.line);
  }

  function focusRow(index: number) {
    rowRefs.current.get(index)?.focus();
  }

  function onResultKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(index + 1, rows.length - 1);
      setActiveIndex(next);
      focusRow(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(index - 1, 0);
      setActiveIndex(prev);
      focusRow(prev);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectRow(rows[index]);
    }
  }

  function onQueryKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runSearch();
    }
  }

  function onRootKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  const summary = results ? matchSummaryText(results.total, groups.length) : null;
  const cappedHint = results ? cappedHintText(results.capped) : null;

  return (
    <div className="code-search-bar" role="search" aria-label="Search scripts" onKeyDown={onRootKeyDown}>
      <div className="code-search-inputs">
        <input
          ref={queryRef}
          className="input"
          type="text"
          placeholder="Search scripts…"
          aria-label="Search query"
          value={query}
          onChange={(e) => updateQuery(e.target.value)}
          onKeyDown={onQueryKeyDown}
        />
        <Button
          size="sm"
          variant={caseSensitive ? 'primary' : 'default'}
          className="code-search-toggle"
          aria-pressed={caseSensitive}
          title="Match case"
          onClick={toggleCaseSensitive}
        >
          Aa
        </Button>
        <Button
          size="sm"
          variant={regexMode ? 'primary' : 'default'}
          className="code-search-toggle"
          aria-pressed={regexMode}
          title="Use a regular expression"
          onClick={toggleRegexMode}
        >
          .*
        </Button>
        <Button size="sm" onClick={() => void runSearch()} disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </Button>
        <span style={{ flex: 1 }} />
        <IconButton
          size="sm"
          icon="cross"
          iconSize={11}
          label="Close search"
          shortcut={comboDisplay('escape')}
          onClick={onClose}
        />
      </div>

      {searchError && <div className="code-search-error">{searchError}</div>}

      <div className="code-search-replace">
        <button
          type="button"
          className="code-search-replace-toggle"
          aria-expanded={replaceOpen}
          onClick={() => setReplaceOpen((v) => !v)}
        >
          <Icon name="chevron" size={10} />
          <span>Replace</span>
        </button>
        {replaceOpen && (
          <div className="code-search-replace-body">
            <input
              className="input"
              type="text"
              placeholder="Replace with…"
              aria-label="Replacement text"
              value={replacement}
              onChange={(e) => updateReplacement(e.target.value)}
            />
            <div className="code-search-replace-actions">
              <Button
                size="sm"
                onClick={() => void runPreview()}
                disabled={!query.trim() || (replaceFlow.status === 'previewing' && replaceFlow.loading)}
              >
                {replaceFlow.status === 'previewing' && replaceFlow.loading ? 'Previewing…' : 'Preview'}
              </Button>
              {(replaceFlow.status === 'previewing' || replaceFlow.status === 'applying' || replaceFlow.status === 'done') && (
                <Button
                  size="sm"
                  onClick={cancelReplace}
                  disabled={replaceFlow.status === 'applying'}
                  title={replaceFlow.status === 'applying' ? 'Replace is already in progress and cannot be cancelled' : undefined}
                >
                  {replaceFlow.status === 'done' ? 'Dismiss' : 'Cancel'}
                </Button>
              )}
            </div>

            {replaceFlow.error && <div className="code-search-error">{replaceFlow.error}</div>}

            {replaceFlow.status === 'previewing' && !replaceFlow.loading && (
              <div className="code-search-replace-preview">
                <div className="code-search-summary">{matchSummaryText(replaceFlow.total, replaceFlow.changes.length)}</div>
                {replaceFlow.changes.length > 0 && (
                  <>
                    <ul className="code-search-replace-list">
                      {replaceFlow.changes.map((c) => (
                        <li key={c.path}>
                          <span className="code-search-group-path">{c.path}</span>
                          <span className="code-search-replace-count">
                            {c.count} {c.count === 1 ? 'match' : 'matches'}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <Button size="sm" variant="primary" onClick={() => void runApply()}>
                      Replace all
                    </Button>
                  </>
                )}
              </div>
            )}

            {replaceFlow.status === 'applying' && <div className="code-search-summary">Replacing…</div>}

            {replaceFlow.status === 'done' && (
              <div className="code-search-summary">
                Replaced {replaceFlow.totalReplaced} {replaceFlow.totalReplaced === 1 ? 'match' : 'matches'} across{' '}
                {replaceFlow.filesChanged} {replaceFlow.filesChanged === 1 ? 'script' : 'scripts'}.
              </div>
            )}
          </div>
        )}
      </div>

      {results && (rows.length > 0 ? <div className="code-search-summary">{summary}</div> : <div className="code-search-empty">No matches</div>)}

      {rows.length > 0 && (
        <div className="code-search-results" role="listbox" aria-label="Search results">
          {groups.map((group) => (
            <div key={group.path} className="code-search-group">
              <div className="code-search-group-path">{group.path}</div>
              {group.matches.map((m) => {
                const index = rows.findIndex((r) => r.match === m);
                const span = highlightMatch(m.preview, query, regexMode, caseSensitive);
                return (
                  <div
                    key={`${m.path}:${m.line}:${m.column}`}
                    ref={(el) => {
                      if (el) rowRefs.current.set(index, el);
                      else rowRefs.current.delete(index);
                    }}
                    role="option"
                    aria-selected={index === activeIndex}
                    tabIndex={index === activeIndex ? 0 : -1}
                    className="code-search-row"
                    onClick={() => {
                      setActiveIndex(index);
                      selectRow({ match: m, groupPath: group.path });
                    }}
                    onKeyDown={(e) => onResultKeyDown(e, index)}
                  >
                    <span className="code-search-line-no">{m.line}:</span>
                    <span className="code-search-preview">
                      {span ? (
                        <>
                          {span.before}
                          <mark>{span.match}</mark>
                          {span.after}
                        </>
                      ) : (
                        m.preview
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {cappedHint && <div className="code-search-hint">{cappedHint}</div>}
    </div>
  );
}
