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
import { ConfirmDialog, Icon } from './ui';
import { decideExternalChange, type ExternalChangeEntry } from './code/externalChange';
import type { JournalEntry } from '../types';

const CodeEditor = lazy(() => import('./code/CodeEditor'));

/** A script's file name, without the scripts/ prefix, for the picker label. */
function scriptLabel(path: string): string {
  return path.replace(/^scripts\//, '');
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

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [savedSource, setSavedSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  /** null = no confirmation pending; 'close' or a script path = the switch waiting on the user's choice. */
  const [pendingPath, setPendingPath] = useState<string | 'close' | null>(null);
  const [conflict, setConflict] = useState(false);

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

  async function openScript(path: string) {
    setSelectedPath(path);
    setLoading(true);
    setLoadError(null);
    setConflict(false);
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
  }

  function confirmPendingSwitch() {
    const target = pendingPath;
    setPendingPath(null);
    if (target === 'close') closeScript();
    else if (target !== null) void openScript(target);
  }

  async function save() {
    if (!selectedPath || saving) return;
    setSaving(true);
    const result = await exec('editScript', { path: selectedPath, source });
    setSaving(false);
    if (result.success) {
      setSavedSource(source);
      setConflict(false);
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
              title="Save (Ctrl/Cmd+S)"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>

      {conflict && (
        <div className="code-conflict-banner">
          <Icon name="entity" size={13} />
          <span>This script changed outside the editor while you had unsaved edits.</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={reloadFromConflict}>
            Reload
          </button>
          <button className="btn btn-sm btn-primary" onClick={keepMine}>
            Keep mine
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
