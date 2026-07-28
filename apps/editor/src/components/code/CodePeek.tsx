/**
 * Code peek: a read-only look at what the agent wrote.
 *
 * Deliberately not an editor. Code is accessible, never featured — you open
 * it to check something, then close it and go back to talking. A file list on
 * the left, the file on the right, monospace, no tooling.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../../store';
import { apiListFiles, apiReadFile } from '../../api';
import type { ProjectFile } from '../../types';
import { IconButton } from '../ui/Button';

/** Extensions worth opening as text. Everything else is listed but not read. */
const TEXT_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'html', 'htm', 'css', 'md', 'txt',
  'lua', 'glsl', 'frag', 'vert', 'yml', 'yaml', 'toml', 'svg', 'xml',
]);

export function isTextFile(relPath: string): boolean {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.has(ext);
}

/** Human file size, one decimal past a kilobyte. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CodePeek() {
  const open = useApp((s) => s.codePeek.open);
  const path = useApp((s) => s.codePeek.path);
  const close = useApp((s) => s.closeCodePeek);
  const openCodePeek = useApp((s) => s.openCodePeek);
  const project = useApp((s) => s.projectPath);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  // Refresh the listing on each open: the agent has almost certainly written
  // something since last time.
  useEffect(() => {
    if (!open || !project) return;
    void apiListFiles(project).then(setFiles);
    // Focus the filter, not the close button: it is what the reader wants
    // next, and it keeps focus inside the drawer for Escape / tabbing.
    filterRef.current?.focus();
  }, [open, project]);

  useEffect(() => {
    if (!open || !project || !path) {
      setContent(null);
      return;
    }
    let cancelled = false;
    void apiReadFile(project, path).then((text) => {
      if (!cancelled) setContent(text);
    });
    return () => {
      cancelled = true;
    };
  }, [open, project, path]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const needle = filter.trim().toLowerCase();
  const visible = needle === '' ? files : files.filter((f) => f.path.toLowerCase().includes(needle));

  return (
    <>
      <div className="peek-scrim" onClick={close} aria-hidden="true" />
      <aside className="code-peek" aria-label="Files">
        <header className="peek-head">
          <span className="peek-title">{path ?? 'Files'}</span>
          <IconButton icon="cross" label="Close" variant="ghost" size="sm" onClick={close} />
        </header>
        <div className="peek-body">
          <div className="peek-list">
            <input
              ref={filterRef}
              className="input peek-filter"
              value={filter}
              placeholder="Filter"
              aria-label="Filter files"
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="peek-files">
              {visible.length === 0 ? (
                <p className="peek-empty">{files.length === 0 ? 'This project has no files yet.' : 'Nothing matches.'}</p>
              ) : (
                visible.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className="peek-file"
                    aria-current={file.path === path}
                    onClick={() => openCodePeek(file.path)}
                  >
                    <span className="peek-file-name">{file.path}</span>
                    <span className="peek-file-size">{formatSize(file.size)}</span>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="peek-view">
            {!path ? (
              <p className="peek-empty">Pick a file.</p>
            ) : !isTextFile(path) ? (
              <p className="peek-empty">Not a text file.</p>
            ) : content === null ? (
              <p className="peek-empty">Reading…</p>
            ) : (
              <pre className="peek-code">{content}</pre>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
