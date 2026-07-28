/**
 * The project's context: files the agent should have read before it starts.
 *
 * A design doc, a spec, a level format, the notes you wrote in a text file at
 * 2am. They live in the project's own `.hearth/context/` folder rather than
 * inside the app, so they can be committed, edited in whatever editor you
 * like, and read by an agent that never opens Hearth at all.
 *
 * Cards rather than a list because these are objects, not commands: a name,
 * how big it is, and the kind of file it is are all you need to recognise one,
 * and a grid of them is scannable in a way twelve filenames in a column is
 * not.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiContextFiles, apiDeleteContextFile, apiSaveContextFiles } from '../../api';
import { base64FromDataUrl } from '../../chat/attachments';
import type { ContextFile } from '../../types';
import { Icon } from '../ui';

/** `.md` → `MD`. The badge on a card, so the kind reads before the name does. */
export function extLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'FILE';
  return name.slice(dot + 1).toUpperCase().slice(0, 4);
}

/** What a card says under its name: lines for text, size for anything else. */
export function sizeLabel(file: ContextFile): string {
  if (file.lines !== null) return file.lines === 1 ? '1 line' : `${file.lines} lines`;
  if (file.bytes < 1024) return `${file.bytes} B`;
  if (file.bytes < 1024 * 1024) return `${Math.round(file.bytes / 1024)} KB`;
  return `${(file.bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read the file'));
    reader.onload = () => resolve(base64FromDataUrl(String(reader.result ?? '')));
    reader.readAsDataURL(file);
  });
}

export function ProjectContext({ projectPath }: { projectPath: string }) {
  const [files, setFiles] = useState<ContextFile[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [dropping, setDropping] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setFiles(await apiContextFiles(projectPath));
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(
    async (picked: readonly File[]): Promise<void> => {
      if (picked.length === 0) return;
      const payload = await Promise.all(
        picked.map(async (file) => ({ name: file.name, data: await readBase64(file) })),
      );
      setFiles(await apiSaveContextFiles(projectPath, payload));
    },
    [projectPath],
  );

  const shown = files.filter((file) => file.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <section
      className={dropping ? 'proj-card is-dropping' : 'proj-card'}
      aria-label="Context"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        const picked = Array.from(e.dataTransfer.files ?? []);
        if (picked.length === 0) return;
        e.preventDefault();
        void add(picked);
      }}
    >
      <header className="proj-card-head">
        <h2 className="proj-card-title">Context</h2>
        {/* Search appears only once there is enough here to lose something in;
            a filter over four cards is furniture. */}
        {files.length > 6 && (
          <button
            type="button"
            className="proj-card-add"
            aria-label={searching ? 'Hide search' : 'Search context'}
            onClick={() => {
              setSearching((open) => !open);
              if (searching) setQuery('');
            }}
          >
            <Icon name="search" size={12} />
          </button>
        )}
        <button
          type="button"
          className="proj-card-add"
          aria-label="Add context files"
          onClick={() => pickerRef.current?.click()}
        >
          <Icon name="plus" size={12} />
        </button>
      </header>

      <input
        ref={pickerRef}
        type="file"
        multiple
        className="composer-file-input"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = '';
          void add(picked);
        }}
      />

      {searching && (
        <input
          className="input proj-context-search"
          value={query}
          placeholder="Search context"
          aria-label="Search context"
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {files.length === 0 ? (
        <p className="proj-card-hint">
          Drop in anything the agent should have read: a design doc, a spec, notes. They live in the project,
          under <span className="mono">.hearth/context</span>.
        </p>
      ) : shown.length === 0 ? (
        <p className="proj-card-hint">Nothing matches that.</p>
      ) : (
        <div className="proj-context-grid">
          {shown.map((file) => (
            <article key={file.name} className="proj-context-card">
              <span className="proj-context-name">{file.name}</span>
              <span className="proj-context-size">{sizeLabel(file)}</span>
              <span className="proj-context-foot">
                <span className="proj-context-ext">{extLabel(file.name)}</span>
                <button
                  type="button"
                  className="proj-context-remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => void apiDeleteContextFile(projectPath, file.name).then(setFiles)}
                >
                  <Icon name="cross" size={10} />
                </button>
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
