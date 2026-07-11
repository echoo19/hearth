/**
 * Code panel: a single-document script editor. Host responsibilities live
 * here (script picker, dirty tracking, load/save, unsaved-changes guard,
 * external-change follow); the CodeMirror instance itself is lazy-loaded
 * from ./code/CodeEditor so the CM6 chunk never lands in the main bundle
 * until a user actually opens this panel.
 */
import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { fileUrl } from '../api';
import { comboDisplay } from '../keybinds';
import { ConfirmDialog, Icon } from './ui';
import { decideExternalChange, type ExternalChangeEntry } from './code/externalChange';
import type { CommandResult, JournalEntry, ScriptDiagnostic } from '../types';
import { languageForPath } from './code/scriptLanguage';

const CodeEditor = lazy(() => import('./code/CodeEditor'));

/** A script's file name, without the scripts/ prefix, for the picker label. */
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

/** Maps a raw journal entry to the shape decideExternalChange reasons over.
 * `path` comes from the command's journaled detail (session.ts's
 * extractJournalDetail records it for editScript/createScript); when it's
 * missing decideExternalChange treats the entry conservatively. */
function toExternalChangeEntry(entry: JournalEntry): ExternalChangeEntry {
  const kind = entry.command === 'editScript' || entry.command === 'createScript' ? 'script' : entry.command;
  const detailPath = entry.detail?.path;
  const path = typeof detailPath === 'string' ? detailPath : undefined;
  return { kind, source: entry.source, path };
}

export function CodePanel() {
  const projectPath = useEditor((s) => s.projectPath);
  const scripts = useEditor((s) => s.info?.scripts ?? []);
  const journalFeed = useEditor((s) => s.journalFeed);
  const exec = useEditor((s) => s.exec);
  const log = useEditor((s) => s.log);
  const query = useEditor((s) => s.query);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [savedSource, setSavedSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingAsNew, setSavingAsNew] = useState(false);
  const [revision, setRevision] = useState(0);
  /** null = no confirmation pending; 'close' or a script path = the switch waiting on the user's choice. */
  const [pendingPath, setPendingPath] = useState<string | 'close' | null>(null);
  const [conflict, setConflict] = useState(false);
  /** Set when the last Save failed for a reason other than "the file is gone" (see scriptMissing below). */
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Set when the last Save failed because the open script no longer exists on disk
   * (undone/reverted out from under the buffer) — a different message and recovery
   * path than a generic save error. */
  const [scriptMissing, setScriptMissing] = useState(false);

  const dirty = selectedPath !== null && source !== savedSource;

  // Refs so the journal-feed effect (which must not re-subscribe on every
  // keystroke) always sees the latest values without becoming its dependency.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const lastSeqRef = useRef(0);

  async function readScript(path: string): Promise<string> {
    const project = projectPathRef.current;
    if (!project) throw new Error('No project open');
    const res = await fetch(fileUrl(project, path));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  }

  /**
   * Injected into the lazy CodeEditor as its `checkScript` prop — wraps the
   * store's silent `query('checkScript', ...)` (no Console noise, `null` on
   * a failed/offline command) and unwraps to just the diagnostics array, so
   * the lint extension never has to special-case a missing result itself.
   */
  async function checkScript(source: string): Promise<ScriptDiagnostic[]> {
    const path = selectedPathRef.current;
    if (!path) return [];
    const result = await query<{ valid: boolean; language: 'lua' | 'js'; diagnostics: ScriptDiagnostic[] }>(
      'checkScript',
      { source, language: languageForPath(path) },
    );
    return result?.diagnostics ?? [];
  }

  async function openScript(path: string) {
    setSelectedPath(path);
    setLoading(true);
    setLoadError(null);
    setConflict(false);
    setSaveError(null);
    setScriptMissing(false);
    // Entries already in the feed predate this open; only react to ones that
    // arrive from here on.
    lastSeqRef.current = journalFeed.length ? journalFeed[journalFeed.length - 1].seq : 0;
    try {
      const text = await readScript(path);
      setSource(text);
      setSavedSource(text);
      setRevision((r) => r + 1);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function requestSwitch(target: string | 'close') {
    if (dirty) {
      setPendingPath(target);
    } else if (target === 'close') {
      closeScript();
    } else {
      void openScript(target);
    }
  }

  function closeScript() {
    setSelectedPath(null);
    setSource('');
    setSavedSource('');
    setLoadError(null);
    setConflict(false);
    setSaveError(null);
    setScriptMissing(false);
  }

  function confirmPendingSwitch() {
    const target = pendingPath;
    setPendingPath(null);
    if (target === 'close') closeScript();
    else if (target !== null) void openScript(target);
  }

  async function save() {
    if (!shouldSave({ selectedPath, saving, dirty })) return;
    setSaving(true);
    setSaveError(null);
    setScriptMissing(false);
    const result = await exec('editScript', { path: selectedPath as string, source });
    setSaving(false);
    if (result.success) {
      setSavedSource(source);
      setConflict(false);
    } else {
      const outcome = classifySaveFailure(result.errors);
      if (outcome.kind === 'missing') setScriptMissing(true);
      else setSaveError(outcome.message);
    }
  }

  /**
   * Recovery path for a save onto a script that no longer exists on disk
   * (scriptMissing): the engine has no "recreate at this exact path" command
   * (createScript derives its filename from `name`, not an explicit path),
   * so this is a genuine save-as — the buffer's content survives, possibly
   * under a slightly different filename.
   */
  async function saveAsNewScript() {
    if (!selectedPath || savingAsNew) return;
    setSavingAsNew(true);
    setSaveError(null);
    const language = languageForPath(selectedPath);
    const name = scriptLabel(selectedPath).replace(/\.(lua|js)$/, '');
    const result = await exec<{ path: string }>('createScript', { name, language, source });
    setSavingAsNew(false);
    if (result.success && result.data) {
      setScriptMissing(false);
      setSavedSource(source);
      setSelectedPath(result.data.path);
    } else {
      setSaveError(result.errors[0]?.message ?? 'Save failed.');
    }
  }

  // External follow: react to newly-pushed journal entries for the open
  // script. Never silently reloads over unsaved local edits — a dirty buffer
  // always surfaces the conflict banner instead (Reload / Keep mine), so a
  // later Save can never clobber an external edit without the user knowing.
  useEffect(() => {
    if (journalFeed.length === 0) return;
    const path = selectedPathRef.current;
    if (!path) {
      lastSeqRef.current = journalFeed[journalFeed.length - 1].seq;
      return;
    }
    const fresh = journalFeed.filter((e) => e.seq > lastSeqRef.current);
    if (fresh.length === 0) return;
    lastSeqRef.current = journalFeed[journalFeed.length - 1].seq;

    let shouldReload = false;
    for (const entry of fresh) {
      if (!entry.ok) continue;
      const action = decideExternalChange({
        openPath: path,
        dirty: dirtyRef.current,
        entry: toExternalChangeEntry(entry),
      });
      if (action === 'reload') shouldReload = true;
      else if (action === 'banner') setConflict(true);
    }
    if (shouldReload) {
      void readScript(path).then(
        (text) => {
          setSource(text);
          setSavedSource(text);
          setRevision((r) => r + 1);
          log('info', 'editor', `${scriptLabel(path)} was updated outside the editor — reloaded.`);
        },
        () => {
          /* the file may have been removed by the same external change; leave the buffer as-is */
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalFeed]);

  function reloadFromConflict() {
    if (!selectedPath) return;
    setConflict(false);
    void readScript(selectedPath).then((text) => {
      setSource(text);
      setSavedSource(text);
      setRevision((r) => r + 1);
    });
  }

  function keepMine() {
    // The buffer already holds the edits the user wants to keep; dismissing
    // the banner is enough — the next Save overwrites the external change,
    // and that's the whole point of "keep mine" (an explicit, informed choice).
    setConflict(false);
  }

  return (
    <div className="code-panel-root">
      <div className="panel-toolbar">
        <select
          className="select"
          value={selectedPath ?? ''}
          onChange={(e) => {
            if (e.target.value) requestSwitch(e.target.value);
          }}
          title="Choose a script to edit"
        >
          <option value="" disabled>
            {scripts.length === 0 ? 'No scripts in this project' : 'Select a script…'}
          </option>
          {scripts.map((path) => (
            <option key={path} value={path}>
              {scriptLabel(path)}
            </option>
          ))}
        </select>
        {selectedPath && (
          <span
            className={`code-dirty-dot${dirty ? ' code-dirty-dot-active' : ''}`}
            title={dirty ? 'Unsaved changes' : 'No unsaved changes'}
            aria-label={dirty ? 'Unsaved changes' : 'No unsaved changes'}
          />
        )}
        <span style={{ flex: 1 }} />
        {selectedPath && (
          <>
            <button className="btn btn-sm" onClick={() => requestSwitch('close')} title="Close the open script">
              Close
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void save()}
              disabled={!dirty || saving}
              title={`Save (${comboDisplay('mod+s')})`}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>

      {conflict && (
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

      {scriptMissing && (
        <div className="code-conflict-banner">
          <Icon name="cross" size={13} />
          <span>
            {selectedPath ? scriptLabel(selectedPath) : 'This script'} no longer exists in the project — it may
            have been undone or reverted. Your edits are still here if you want to save them under a new name.
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm btn-primary" onClick={() => void saveAsNewScript()} disabled={savingAsNew}>
            {savingAsNew ? 'Saving…' : 'Save as new script'}
          </button>
        </div>
      )}

      {saveError && !scriptMissing && (
        <div className="code-conflict-banner">
          <Icon name="cross" size={13} />
          <span>
            Couldn't save {selectedPath ? scriptLabel(selectedPath) : 'this script'} — {saveError}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => void save()}>
            Retry
          </button>
        </div>
      )}

      <div className="code-editor-container">
        {!selectedPath ? (
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
        ) : loading ? (
          <div className="empty-state">
            <span>Loading {scriptLabel(selectedPath)}…</span>
          </div>
        ) : loadError ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="cross" size={16} />
            </span>
            <span>Couldn't load {scriptLabel(selectedPath)}</span>
            <span className="hint">{loadError}</span>
            <button className="btn btn-sm" onClick={() => void openScript(selectedPath)}>
              Retry
            </button>
          </div>
        ) : (
          <Suspense fallback={<div className="empty-state">Loading editor…</div>}>
            <CodeEditor
              key={`${selectedPath}:${revision}`}
              path={selectedPath}
              value={source}
              onChange={setSource}
              onSave={() => void save()}
              checkScript={checkScript}
            />
          </Suspense>
        )}
      </div>

      <ConfirmDialog
        open={pendingPath !== null}
        title="Unsaved changes"
        body={
          pendingPath === 'close'
            ? `Close ${selectedPath ? scriptLabel(selectedPath) : 'this script'} without saving? Your edits will be lost.`
            : `Switch scripts without saving? Your edits to ${selectedPath ? scriptLabel(selectedPath) : 'this script'} will be lost.`
        }
        confirmLabel="Discard changes"
        danger
        onCancel={() => setPendingPath(null)}
        onConfirm={confirmPendingSwitch}
      />
    </div>
  );
}
