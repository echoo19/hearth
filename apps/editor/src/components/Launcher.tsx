import React, { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { apiRecentProjects, apiExampleProjects } from '../api';
import type { ExampleProject, RecentProject } from '../types';
import { Icon } from './ui';

export function Launcher() {
  const meta = useEditor((s) => s.meta);
  const openProject = useEditor((s) => s.openProject);
  const createProject = useEditor((s) => s.createProject);

  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [examples, setExamples] = useState<ExampleProject[]>([]);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [description, setDescription] = useState('');
  const [openPath, setOpenPath] = useState('');
  const [createError, setCreateError] = useState('');
  const [openError, setOpenError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiRecentProjects().then(setRecents);
    void apiExampleProjects().then(setExamples);
  }, []);

  const defaultDir = meta ? `${meta.home}/HearthProjects` : '';

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setCreateError('Give the project a name.');
      return;
    }
    setBusy(true);
    setCreateError('');
    const res = await createProject(dir.trim() || defaultDir, name.trim(), description.trim() || undefined);
    setBusy(false);
    if (!res.ok) setCreateError(res.error ?? 'Failed to create project.');
  }

  async function handleOpen(path: string, setError: (msg: string) => void) {
    if (!path.trim()) {
      setError('Enter the path of a folder containing hearth.json.');
      return;
    }
    setBusy(true);
    setError('');
    const res = await openProject(path.trim());
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'Failed to open project.');
  }

  return (
    <div className="launcher">
      <header className="launcher-brand">
        <h1>
          <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
            <Icon name="flame" size={28} />
          </span>
          Hearth
        </h1>
        <p className="tagline">The 2D engine built for humans + coding agents</p>
      </header>

      <div className="launcher-columns">
        <section className="launcher-card">
          <h2>New project</h2>
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="form-field">
              <label className="field-label" htmlFor="np-name">
                Name
              </label>
              <input
                id="np-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Platformer"
                autoFocus
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="np-dir">
                Location — the project is created in a subfolder here
              </label>
              <input
                id="np-dir"
                className="input mono"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder={defaultDir || '/path/to/projects'}
              />
            </div>
            <div className="form-field">
              <label className="field-label" htmlFor="np-desc">
                Description (optional)
              </label>
              <input
                id="np-desc"
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A tiny game to build with an agent"
              />
            </div>
            {createError && <div className="launcher-error">{createError}</div>}
            <div>
              <button className="btn btn-primary" type="submit" disabled={busy}>
                Create project
              </button>
            </div>
          </form>
        </section>

        <section className="launcher-card">
          <h2>Open a project</h2>
          <div className="row">
            <input
              className="input mono"
              value={openPath}
              onChange={(e) => setOpenPath(e.target.value)}
              placeholder="/absolute/path/to/project"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleOpen(openPath, setOpenError);
              }}
            />
            <button className="btn" disabled={busy} onClick={() => void handleOpen(openPath, setOpenError)}>
              Open
            </button>
          </div>
          {openError && <div className="launcher-error">{openError}</div>}

          <h2 style={{ marginTop: 8 }}>Recent</h2>
          <div className="launcher-list">
            {recents.length === 0 && (
              <div className="launcher-empty">Projects you open will show up here.</div>
            )}
            {recents.map((r) => (
              <button
                key={r.path}
                className="launcher-item"
                disabled={busy || !r.exists}
                onClick={() => void handleOpen(r.path, setOpenError)}
                title={r.exists ? r.path : `${r.path} (moved or deleted)`}
              >
                <span className="item-name">{r.name}</span>
                <span className="item-path">{r.exists ? r.path : 'moved or deleted'}</span>
              </button>
            ))}
          </div>

          <h2 style={{ marginTop: 8 }}>Examples</h2>
          <div className="launcher-list">
            {examples.length === 0 && (
              <div className="launcher-empty">
                No example projects found (packages/examples is on its way).
              </div>
            )}
            {examples.map((ex) => (
              <button
                key={ex.path}
                className="launcher-item"
                disabled={busy}
                onClick={() => void handleOpen(ex.path, setOpenError)}
                title={ex.path}
              >
                <span className="item-name">{ex.name}</span>
                <span className="item-desc">{ex.description}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
