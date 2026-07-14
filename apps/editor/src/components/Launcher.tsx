import React, { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { apiRecentProjects, apiExampleProjects } from '../api';
import type { ExampleProject, RecentProject } from '../types';
import { Icon } from './ui';
import { Button } from './ui/Button';
import { TemplatePicker } from './TemplatePicker';
import { hearthNative } from '../native';

export function Launcher() {
  const meta = useEditor((s) => s.meta);
  const openProject = useEditor((s) => s.openProject);
  const createProject = useEditor((s) => s.createProject);

  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [examples, setExamples] = useState<ExampleProject[]>([]);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState(''); // '' = Blank
  const [openPath, setOpenPath] = useState('');
  const [createError, setCreateError] = useState('');
  const [openError, setOpenError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiRecentProjects().then(setRecents);
    void apiExampleProjects().then(setExamples);
  }, []);

  const defaultDir = meta ? `${meta.home}/HearthProjects` : '';
  const native = hearthNative();

  async function browseCreateDir() {
    const picked = await native?.pickDirectory();
    if (picked) setDir(picked);
  }

  async function browseOpenProject() {
    const picked = await native?.pickProjectFolder();
    if (picked) {
      setOpenPath(picked);
      await handleOpen(picked, setOpenError);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setCreateError('Give the project a name.');
      return;
    }
    setBusy(true);
    setCreateError('');
    const res = await createProject(
      dir.trim() || defaultDir,
      name.trim(),
      description.trim() || undefined,
      template || undefined,
    );
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
          <span className="flame">
            <Icon name="flame" size={30} />
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
                Location (the project is created in a subfolder here)
              </label>
              <div className="row">
                <input
                  id="np-dir"
                  className="input mono"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder={defaultDir || '/path/to/projects'}
                />
                {native && (
                  <Button disabled={busy} onClick={() => void browseCreateDir()}>
                    Browse…
                  </Button>
                )}
              </div>
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
            <div className="form-field">
              {/* Group caption for the radiogroup; the picker carries its own aria-label. */}
              <label className="field-label">Start from</label>
              <TemplatePicker value={template} onChange={setTemplate} disabled={busy} />
            </div>
            {createError && <div className="launcher-error">{createError}</div>}
            <div>
              <Button variant="primary" type="submit" disabled={busy}>
                Create project
              </Button>
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
            <Button disabled={busy} onClick={() => void handleOpen(openPath, setOpenError)}>
              Open
            </Button>
            {native && (
              <Button variant="primary" disabled={busy} onClick={() => void browseOpenProject()}>
                Open Folder…
              </Button>
            )}
          </div>
          {openError && <div className="launcher-error">{openError}</div>}

          <h3 className="launcher-section">Recent</h3>
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
              >
                <span className="item-text">
                  <span className="item-name">{r.name}</span>
                  <span className="item-path" title={r.exists ? r.path : `${r.path} (moved or deleted)`}>
                    {r.exists ? r.path : 'moved or deleted'}
                  </span>
                </span>
                <span className="item-go" aria-hidden="true">
                  <Icon name="chevron" />
                </span>
              </button>
            ))}
          </div>

          <h3 className="launcher-section">Examples</h3>
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
              >
                <span className="item-text">
                  <span className="item-name" title={ex.path}>
                    {ex.name}
                  </span>
                  <span className="item-desc">{ex.description}</span>
                </span>
                <span className="item-go" aria-hidden="true">
                  <Icon name="chevron" />
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
