/**
 * Code panel: a tabbed, multi-buffer script editor. Host responsibilities
 * live here (open/activate scripts, per-buffer dirty tracking, load/save,
 * unsaved-changes guard on close, external-change follow across every open
 * buffer); the CodeMirror instance itself is lazy-loaded from
 * ./code/CodeEditor so the CM6 chunk never lands in the main bundle until a
 * user actually opens this panel.
 *
 * The buffer list is a plain `Buffer[]` + `activePath`, mutated only through
 * the pure reducers in ./code/buffers. Per-buffer undo history is preserved
 * across tab switches by a SINGLE EditorView whose EditorState is cached
 * per-path in `stateCacheRef` and swapped by CodeEditor — never a remount.
 */
import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { EditorState } from '@codemirror/state';
import { useEditor } from '../store';
import { fileUrl } from '../api';
import { comboDisplay } from '../keybinds';
import { ConfirmDialog, Icon } from './ui';
import { decideExternalChange } from './code/externalChange';
import {
  type Buffer,
  type BufferState,
  closeBuffer,
  findBuffer,
  isDirty,
  openBuffer,
  patchBuffer,
  toExternalChangeEntries,
} from './code/buffers';
import type { CommandResult, ScriptDiagnostic } from '../types';
import { languageForPath } from './code/scriptLanguage';
import { SearchAcross } from './code/SearchAcross';

const CodeEditor = lazy(() => import('./code/CodeEditor'));

/** A script's file name, without the scripts/ prefix, for tab + picker labels. */
function scriptLabel(path: string): string {
  return path.replace(/^scripts\//, '');
}

/**
 * Pure guard for whether a Save should actually run. The toolbar Save
 * button already disables itself on `!dirty || saving` — but CM6's local
 * `Mod-s` keymap (CodeEditor.tsx) calls `onSave()` unconditionally on every
 * keypress, bypassing that. Pressing Cmd+S on an already-saved script must
 * be a true no-op: no redundant disk write, no fake undo/journal entry.
 * Exported for unit testing (see codePanelSave.test.ts).
 */
export function shouldSave(state: { selectedPath: string | null; saving: boolean; dirty: boolean }): boolean {
  return state.selectedPath !== null && !state.saving && state.dirty;
}

/**
 * Pure classifier for a failed `editScript` result: a missing file (the
 * script was undone/reverted out from under the open buffer) needs a
 * different message and recovery path than any other save failure. Exported
 * for unit testing.
 */
export function classifySaveFailure(
  errors: CommandResult<unknown>['errors'],
): { kind: 'missing' } | { kind: 'error'; message: string } {
  const first = errors[0];
  if (first?.code === 'NOT_FOUND') return { kind: 'missing' };
  return { kind: 'error', message: first?.message ?? 'Save failed.' };
}

export function CodePanel() {
  const projectPath = useEditor((s) => s.projectPath);
  const scripts = useEditor((s) => s.info?.scripts ?? []);
  // Task 2's project setting, default true (older projects predate the
  // field). `exec('updateSettings', …)` refreshes `s.info` on success (see
  // store.ts's `refresh()` after every mutating exec), so this selector is
  // the toggle's whole state — no local optimistic copy needed.
  const formatOnSave = useEditor((s) => s.info?.codeStyle?.formatOnSave ?? true);
  const journalFeed = useEditor((s) => s.journalFeed);
  const codeOpenRequest = useEditor((s) => s.codeOpenRequest);
  const codeSearchRequest = useEditor((s) => s.codeSearchRequest);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);
  const query = useEditor((s) => s.query);

  const [{ buffers, activePath }, setBufferState] = useState<BufferState>({ buffers: [], activePath: null });
  const [saving, setSaving] = useState(false);
  const [savingAsNew, setSavingAsNew] = useState(false);
  /** null = nothing pending; a path = the dirty buffer whose close is waiting on the user's choice. */
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  /** Drives CodeEditor's scroll-to-line + ember flash for openScriptAt. */
  const [focusRequest, setFocusRequest] = useState<{ path: string; line: number; nonce: number } | null>(null);
  /** Drives CodeEditor's full-doc replace with a formatted-on-save result. */
  const [applyContent, setApplyContent] = useState<{ path: string; text: string; nonce: number } | null>(null);
  const applyNonceRef = useRef(0);
  /** Task 9: whether the cross-script search bar is showing under the tab strip. */
  const [searchOpen, setSearchOpen] = useState(false);
  /** Wraps the editor host so closeSearch() can hand focus back to CodeMirror's
   * contenteditable surface (a plain DOM query — CodeEditor.tsx exposes no
   * imperative focus handle, and reaching for `.cm-content` here keeps that
   * lazy chunk's API untouched). */
  const editorContainerRef = useRef<HTMLDivElement>(null);

  const active = activePath !== null ? findBuffer(buffers, activePath) : undefined;
  const activeDirty = active ? isDirty(active) : false;

  /** Host-owned per-path EditorState cache — the seam that lets a single
   * CodeMirror view carry every open buffer's undo history across switches. */
  const stateCacheRef = useRef<Map<string, EditorState>>(new Map());

  // Refs so the journal-feed effect (which must not re-subscribe on every
  // keystroke) always sees the latest values without becoming its dependency.
  const bufferStateRef = useRef<BufferState>({ buffers, activePath });
  bufferStateRef.current = { buffers, activePath };
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const lastSeqRef = useRef(0);

  /**
   * Consulted by CodeEditor before it snapshots an outgoing EditorState into
   * the cache: only still-open paths get cached. Closing the ACTIVE tab
   * would otherwise leak — doClose() deletes the cache entry, but the
   * follow-up render activates a neighbour and CodeEditor's swap effect
   * would re-insert the just-closed path's full doc + undo history, keeping
   * it alive for the whole session. Reads through bufferStateRef (refreshed
   * during render), so by the time the post-close swap effect runs, the
   * closed path is already gone from the list.
   */
  const shouldCacheState = (path: string) => findBuffer(bufferStateRef.current.buffers, path) !== undefined;

  async function readScript(path: string): Promise<string> {
    const project = projectPathRef.current;
    if (!project) throw new Error('No project open');
    const res = await fetch(fileUrl(project, path));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  }

  /** Immutably patch one buffer's fields in place. */
  function patch(path: string, p: Partial<Buffer>) {
    setBufferState((s) => ({ ...s, buffers: patchBuffer(s.buffers, path, p) }));
  }

  /**
   * Injected into the lazy CodeEditor as its `checkScript` prop — wraps the
   * store's silent `query('checkScript', ...)` (no Console noise, `null` on
   * a failed/offline command) and unwraps to just the diagnostics array, so
   * the lint extension never has to special-case a missing result itself.
   * Uses the active buffer's path to pick the language.
   */
  async function checkScript(source: string): Promise<ScriptDiagnostic[]> {
    const path = activePathRef.current;
    if (!path) return [];
    const result = await query<{ valid: boolean; language: 'lua' | 'js'; diagnostics: ScriptDiagnostic[] }>(
      'checkScript',
      { source, language: languageForPath(path) },
    );
    return result?.diagnostics ?? [];
  }

  /** Load a buffer's content off disk into its slot. */
  async function loadInto(path: string) {
    patch(path, { loading: true, loadError: null });
    try {
      const text = await readScript(path);
      stateCacheRef.current.delete(path); // fresh content → any stale cached state must go
      patch(path, { source: text, savedSource: text, loading: false, loadError: null });
    } catch (err) {
      patch(path, { loading: false, loadError: (err as Error).message });
    }
  }

  /** Open a script (appends a tab) or, if already open, just activates it. */
  function activateOrOpen(path: string) {
    const already = findBuffer(bufferStateRef.current.buffers, path) !== undefined;
    setBufferState((s) => {
      const { state, evicted } = openBuffer(s, path);
      for (const p of evicted) stateCacheRef.current.delete(p);
      return state;
    });
    if (!already) {
      // Entries already in the feed predate this open; only react to ones that
      // arrive from here on (advance-only so other open buffers keep their
      // baseline). Note the narrow race with the [journalFeed] effect: if an
      // entry arrived between that effect's last run and this open, jumping
      // the cursor here would skip it for the OTHER open buffers too. Safe in
      // practice: React flushes the journal effect for any feed change before
      // this handler can run (effects fire before the next user event), so at
      // this point lastSeqRef has already caught up with everything the other
      // buffers needed to see.
      const tail = journalFeed.length ? journalFeed[journalFeed.length - 1].seq : 0;
      lastSeqRef.current = Math.max(lastSeqRef.current, tail);
      void loadInto(path);
    }
  }

  function requestClose(path: string) {
    const buf = findBuffer(buffers, path);
    if (buf && isDirty(buf)) setPendingClose(path);
    else doClose(path);
  }

  function doClose(path: string) {
    setBufferState((s) => closeBuffer(s, path).state);
    stateCacheRef.current.delete(path);
  }

  function confirmPendingClose() {
    const target = pendingClose;
    setPendingClose(null);
    if (target !== null) doClose(target);
  }

  // openScriptAt(path, line?): open/activate the buffer and, when a line is
  // given, hand CodeEditor a focus request (it scrolls + flashes the line).
  useEffect(() => {
    if (!codeOpenRequest) return;
    activateOrOpen(codeOpenRequest.path);
    if (codeOpenRequest.line != null) {
      setFocusRequest({ path: codeOpenRequest.path, line: codeOpenRequest.line, nonce: codeOpenRequest.nonce });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeOpenRequest?.nonce]);

  // The global "Search scripts" shortcut (keybinds.ts) bumps this counter;
  // Workspace.tsx surfaces the Code panel on the same signal. Only ever
  // opens (never toggles closed) — SearchAcross's own focusNonce prop (fed
  // this same counter) re-focuses the query input on every repress, even
  // while already open, mirroring a browser's Cmd+F.
  useEffect(() => {
    if (codeSearchRequest > 0) setSearchOpen(true);
  }, [codeSearchRequest]);

  /** Esc from SearchAcross, or the header toggle button closing an already-open
   * search bar: hide the bar and hand focus back to the CodeMirror surface. */
  function closeSearch() {
    setSearchOpen(false);
    requestAnimationFrame(() => {
      editorContainerRef.current?.querySelector<HTMLElement>('.cm-content')?.focus();
    });
  }

  /**
   * SearchAcross's completion hook for a real (non-dryRun) replace: resolve
   * every touched path against this panel's OPEN buffers, the same way the
   * journalFeed effect below resolves an external edit — dirty gets the
   * conflict banner, clean gets a silent reload. Can't just rely on the
   * journalFeed effect itself: replaceInScripts' journal entries are
   * stamped `source: 'editor'` (every command this server runs is,
   * regardless of which panel triggered it), and `decideExternalChange`
   * deliberately ignores same-source entries as "already reflected, it's
   * just this buffer's own save echoing back" — an assumption that doesn't
   * hold for a cross-script replace touching OTHER open buffers. So this
   * calls the exact same decision helper directly against the known
   * changed-path list instead of inferring it from the feed.
   */
  function onReplaceApplied(paths: string[]) {
    for (const path of paths) {
      const buf = findBuffer(bufferStateRef.current.buffers, path);
      if (!buf) continue;
      const action = decideExternalChange({
        openPath: path,
        dirty: isDirty(buf),
        entry: { kind: 'script', source: 'search-replace', path },
      });
      if (action === 'banner') {
        patch(path, { conflict: true });
      } else if (action === 'reload') {
        void reloadBuffer(path).then(() => {
          log('info', 'editor', `${scriptLabel(path)} was updated by a cross-script replace — reloaded.`);
        });
      }
    }
  }

  /**
   * Shared body of Save and Format & save — the only difference is the
   * `format` flag sent to `editScript` and, for a plain Save, the
   * `shouldSave` no-op guard (a Cmd+S on a clean buffer must not write; a
   * deliberate Format & save always does, even on a clean buffer, since
   * formatting can change bytes on disk without the buffer having been
   * hand-edited). There is no format-without-save: both the header's
   * "Format & save" button and CodeEditor's Shift-Alt-F keymap call
   * `formatAndSave`, which lands here with `format: true`.
   */
  async function runSave(format: boolean) {
    if (!active || saving) return;
    const path = active.path;
    const source = active.source;
    if (!format && !shouldSave({ selectedPath: path, saving, dirty: activeDirty })) return;
    setSaving(true);
    patch(path, { saveError: null, scriptMissing: false });
    const result = await exec<{ path: string; source?: string; formatted?: boolean }>('editScript', {
      path,
      source,
      ...(format ? { format: true } : {}),
    });
    setSaving(false);
    if (result.success) {
      // When editScript returns the formatted source (Task 2), adopt it as
      // both the buffer's live and saved content (so the tab is clean) and
      // push it into the view in one transaction (preserving undo history +
      // selection). Guard for absence in case format was off and codeStyle
      // formatting didn't run.
      const data = result.data;
      if (data && data.formatted && typeof data.source === 'string') {
        const formatted = data.source;
        patch(path, { source: formatted, savedSource: formatted, conflict: false });
        setApplyContent({ path, text: formatted, nonce: ++applyNonceRef.current });
      } else {
        patch(path, { savedSource: source, conflict: false });
      }
    } else {
      const outcome = classifySaveFailure(result.errors);
      if (outcome.kind === 'missing') patch(path, { scriptMissing: true });
      else patch(path, { saveError: outcome.message });
    }
  }

  async function save() {
    await runSave(false);
  }

  async function formatAndSave() {
    await runSave(true);
  }

  /**
   * Recovery path for a save onto a script that no longer exists on disk
   * (scriptMissing): the engine has no "recreate at this exact path" command
   * (createScript derives its filename from `name`, not an explicit path),
   * so this is a genuine save-as — the buffer's content survives, possibly
   * under a slightly different filename. The buffer is re-keyed to the new path.
   */
  async function saveAsNewScript() {
    if (!active || savingAsNew) return;
    const oldPath = active.path;
    const source = active.source;
    setSavingAsNew(true);
    patch(oldPath, { saveError: null });
    const language = languageForPath(oldPath);
    const name = scriptLabel(oldPath).replace(/\.(lua|js)$/, '');
    const result = await exec<{ path: string }>('createScript', { name, language, source });
    setSavingAsNew(false);
    if (result.success && result.data) {
      const newPath = result.data.path;
      // Move the buffer to the new path: drop the dead one, open the new (loaded) slot.
      stateCacheRef.current.delete(oldPath);
      setBufferState((s) => {
        const withoutOld = closeBuffer(s, oldPath).state;
        const opened = openBuffer(withoutOld, newPath).state;
        return {
          buffers: patchBuffer(opened.buffers, newPath, {
            source,
            savedSource: source,
            loading: false,
            loadError: null,
            scriptMissing: false,
          }),
          activePath: newPath,
        };
      });
    } else {
      patch(oldPath, { saveError: result.errors[0]?.message ?? 'Save failed.' });
    }
  }

  async function reloadBuffer(path: string) {
    try {
      const text = await readScript(path);
      stateCacheRef.current.delete(path);
      setBufferState((s) => {
        const buf = findBuffer(s.buffers, path);
        if (!buf) return s;
        return {
          ...s,
          buffers: patchBuffer(s.buffers, path, {
            source: text,
            savedSource: text,
            conflict: false,
            revision: buf.revision + 1,
          }),
        };
      });
    } catch {
      /* the file may have been removed by the same external change; leave the buffer as-is */
    }
  }

  // External follow: react to newly-pushed journal entries against EVERY open
  // buffer. Never silently reloads over unsaved local edits — a dirty buffer
  // surfaces its conflict banner (Reload / Keep mine) on its own tab, so a
  // later Save can never clobber an external edit without the user knowing.
  useEffect(() => {
    if (journalFeed.length === 0) return;
    const openBuffers = bufferStateRef.current.buffers;
    const tail = journalFeed[journalFeed.length - 1].seq;
    if (openBuffers.length === 0) {
      lastSeqRef.current = tail;
      return;
    }
    const fresh = journalFeed.filter((e) => e.seq > lastSeqRef.current);
    if (fresh.length === 0) return;
    lastSeqRef.current = tail;

    const toReload = new Set<string>();
    const toBanner = new Set<string>();
    for (const entry of fresh) {
      if (!entry.ok) continue;
      for (const changeEntry of toExternalChangeEntries(entry)) {
        for (const buf of openBuffers) {
          const action = decideExternalChange({ openPath: buf.path, dirty: isDirty(buf), entry: changeEntry });
          if (action === 'reload') toReload.add(buf.path);
          else if (action === 'banner') toBanner.add(buf.path);
        }
      }
    }
    for (const p of toBanner) patch(p, { conflict: true });
    for (const p of toReload) {
      if (toBanner.has(p)) continue; // a dirty buffer bannered this pass; never also reload it
      void reloadBuffer(p).then(() => {
        log('info', 'editor', `${scriptLabel(p)} was updated outside the editor — reloaded.`);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalFeed]);

  function reloadFromConflict() {
    if (!active) return;
    void reloadBuffer(active.path);
  }

  function keepMine() {
    // The buffer already holds the edits the user wants to keep; dismissing
    // the banner is enough — the next Save overwrites the external change,
    // and that's the whole point of "keep mine" (an explicit, informed choice).
    if (active) patch(active.path, { conflict: false });
  }

  // ---- Tab strip keyboard nav (roving tabindex) --------------------------
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  function focusTab(path: string) {
    tabRefs.current.get(path)?.focus();
  }
  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = buffers[(index + delta + buffers.length) % buffers.length];
      if (next) {
        setBufferState((s) => ({ ...s, activePath: next.path }));
        focusTab(next.path);
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (buffers[0]) {
        setBufferState((s) => ({ ...s, activePath: buffers[0].path }));
        focusTab(buffers[0].path);
      }
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = buffers[buffers.length - 1];
      if (last) {
        setBufferState((s) => ({ ...s, activePath: last.path }));
        focusTab(last.path);
      }
    }
  }

  const focusForActive =
    active && focusRequest && focusRequest.path === active.path
      ? { line: focusRequest.line, nonce: focusRequest.nonce }
      : null;
  const applyForActive =
    active && applyContent && applyContent.path === active.path
      ? { text: applyContent.text, nonce: applyContent.nonce }
      : null;

  return (
    <div className="code-panel-root">
      <div className="panel-toolbar">
        <select
          className="select"
          value=""
          onChange={(e) => {
            if (e.target.value) activateOrOpen(e.target.value);
          }}
          title="Open a script to edit"
        >
          <option value="" disabled>
            {scripts.length === 0 ? 'No scripts in this project' : 'Open a script…'}
          </option>
          {scripts.map((path) => (
            <option key={path} value={path}>
              {scriptLabel(path)}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={searchOpen ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
          aria-pressed={searchOpen}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          title={`Search scripts (${comboDisplay('shift+mod+f')})`}
        >
          Search
        </button>
        <label className="input-checkbox-label" title="Format scripts with the project's code style whenever they're saved">
          <input
            type="checkbox"
            checked={formatOnSave}
            onChange={(e) => void exec('updateSettings', { codeStyle: { formatOnSave: e.target.checked } }, { quiet: true })}
          />
          Format on save
        </label>
        {active && (
          <>
            <button
              className="btn btn-sm"
              onClick={() => void formatAndSave()}
              disabled={saving}
              title={`Format & save (${comboDisplay('shift+alt+f')})`}
            >
              {saving ? 'Saving…' : 'Format & save'}
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void save()}
              disabled={!activeDirty || saving}
              title={`Save (${comboDisplay('mod+s')})`}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>

      {buffers.length > 0 && (
        <div className="code-tabs" role="tablist" aria-label="Open scripts">
          {buffers.map((buf, i) => {
            const selected = buf.path === activePath;
            const dirty = isDirty(buf);
            return (
              <button
                key={buf.path}
                ref={(el) => {
                  if (el) tabRefs.current.set(buf.path, el);
                  else tabRefs.current.delete(buf.path);
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={`code-tab${selected ? ' code-tab-active' : ''}`}
                onClick={() => setBufferState((s) => ({ ...s, activePath: buf.path }))}
                onKeyDown={(e) => onTabKeyDown(e, i)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    requestClose(buf.path);
                  }
                }}
                title={buf.path}
              >
                <span className="code-tab-name">{scriptLabel(buf.path)}</span>
                {buf.conflict && (
                  <span
                    className="code-tab-conflict"
                    aria-label="changed outside the editor"
                    title={dirty ? 'Changed outside the editor while you have unsaved edits' : 'Changed outside the editor'}
                  />
                )}
                {dirty ? (
                  <span className="code-tab-dot" aria-label="unsaved changes" title="Unsaved changes">
                    •
                  </span>
                ) : null}
                <span
                  role="button"
                  tabIndex={selected ? 0 : -1}
                  className="code-tab-close"
                  aria-label={`Close ${scriptLabel(buf.path)}`}
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation();
                    requestClose(buf.path);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      requestClose(buf.path);
                    }
                  }}
                >
                  <Icon name="cross" size={11} />
                </span>
              </button>
            );
          })}
        </div>
      )}

      {searchOpen && (
        <SearchAcross focusNonce={codeSearchRequest} onClose={closeSearch} onReplaceApplied={onReplaceApplied} />
      )}

      {active?.conflict && (
        <div className="code-conflict-banner">
          <Icon name="entity" size={13} />
          <span>This script changed outside the editor — from an agent or another process — while you had unsaved edits here.</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={reloadFromConflict}>
            Reload
          </button>
          <button className="btn btn-sm btn-primary" onClick={keepMine}>
            Keep mine (overwrite on save)
          </button>
        </div>
      )}

      {active?.scriptMissing && (
        <div className="code-conflict-banner">
          <Icon name="cross" size={13} />
          <span>
            {scriptLabel(active.path)} no longer exists in the project — it may have been undone or reverted. Your
            edits are still here if you want to save them under a new name.
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm btn-primary" onClick={() => void saveAsNewScript()} disabled={savingAsNew}>
            {savingAsNew ? 'Saving…' : 'Save as new script'}
          </button>
        </div>
      )}

      {active?.saveError && !active.scriptMissing && (
        <div className="code-conflict-banner">
          <Icon name="cross" size={13} />
          <span>
            Couldn't save {scriptLabel(active.path)} — {active.saveError}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => void save()}>
            Retry
          </button>
        </div>
      )}

      <div className="code-editor-container" ref={editorContainerRef}>
        {!active ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="script" size={16} />
            </span>
            <span>{scripts.length === 0 ? 'No scripts in this project yet' : 'No script open'}</span>
            <span className="hint">
              {scripts.length === 0
                ? 'Create one with an agent, or from a Script component in the Inspector.'
                : 'Pick a script above to start editing.'}
            </span>
          </div>
        ) : active.loading ? (
          <div className="empty-state">
            <span>Loading {scriptLabel(active.path)}…</span>
          </div>
        ) : active.loadError ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="cross" size={16} />
            </span>
            <span>Couldn't load {scriptLabel(active.path)}</span>
            <span className="hint">{active.loadError}</span>
            <button className="btn btn-sm" onClick={() => void loadInto(active.path)}>
              Retry
            </button>
          </div>
        ) : (
          <Suspense fallback={<div className="empty-state">Loading editor…</div>}>
            <CodeEditor
              path={active.path}
              value={active.source}
              revision={active.revision}
              stateCache={stateCacheRef.current}
              shouldCacheState={shouldCacheState}
              onChange={(v) => patch(active.path, { source: v })}
              onSave={() => void save()}
              onFormatSave={() => void formatAndSave()}
              checkScript={checkScript}
              focusRequest={focusForActive}
              applyContent={applyForActive}
            />
          </Suspense>
        )}
      </div>

      <ConfirmDialog
        open={pendingClose !== null}
        title="Unsaved changes"
        body={`Close ${pendingClose ? scriptLabel(pendingClose) : 'this script'} without saving? Your edits will be lost.`}
        confirmLabel="Discard changes"
        danger
        onCancel={() => setPendingClose(null)}
        onConfirm={confirmPendingClose}
      />
    </div>
  );
}
