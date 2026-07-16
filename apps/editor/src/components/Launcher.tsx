import React, { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { apiRecentProjects, apiExampleProjects } from '../api';
import type { ExampleProject, RecentProject } from '../types';
import { Icon } from './ui';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { TemplatePicker } from './TemplatePicker';
import { hearthNative } from '../native';

/** Which of Launcher's two primary actions (if any) is currently in flight. */
export type LauncherBusyAction = 'create' | 'open' | null;

/**
 * Label for the Create-project / Open buttons while busy (LAUNCHER-2 /
 * L-102) — previously they only went `disabled` (opacity 0.45) with a static
 * label, so a slow filesystem gave no feedback that anything was happening.
 * Pure, so it's unit-tested without a DOM (this repo has no jsdom/RTL).
 */
export function launcherButtonLabel(action: LauncherBusyAction, kind: 'create' | 'open', idleLabel: string): string {
  if (action !== kind) return idleLabel;
  return kind === 'create' ? 'Creating…' : 'Opening…';
}

/**
 * Run one busy action with a guaranteed reset: `setBusy(kind)` before, and
 * `setBusy(null)` in a `finally` — a thrown/rejected `fn` (network drop
 * inside openProject/createProject) must never leave the whole launcher
 * stuck disabled on a stale "Creating…"/"Opening…". Exported for the same
 * DOM-free unit-test treatment as launcherButtonLabel.
 */
export async function withBusyAction<T>(
  kind: Exclude<LauncherBusyAction, null>,
  setBusy: (action: LauncherBusyAction) => void,
  fn: () => Promise<T>,
): Promise<T> {
  setBusy(kind);
  try {
    return await fn();
  } finally {
    setBusy(null);
  }
}

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
  const [busyAction, setBusyAction] = useState<LauncherBusyAction>(null);
  const busy = busyAction !== null;

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
    setCreateError('');
    const res = await withBusyAction('create', setBusyAction, () =>
      createProject(dir.trim() || defaultDir, name.trim(), description.trim() || undefined, template || undefined),
    );
    if (!res.ok) setCreateError(res.error ?? 'Failed to create project.');
  }

  async function handleOpen(path: string, setError: (msg: string) => void) {
    if (!path.trim()) {
      setError('Enter the path of a folder containing hearth.json.');
      return;
    }
    setError('');
    const res = await withBusyAction('open', setBusyAction, () => openProject(path.trim()));
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
                {launcherButtonLabel(busyAction, 'create', 'Create project')}
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
              {launcherButtonLabel(busyAction, 'open', 'Open')}
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
            {/* Styled tooltip (L-103 / LAUNCHER-3): the CSS-truncated path's
                full form — often the only disambiguator between same-named
                projects — shows on hover AND keyboard focus, instead of the
                slow native title. */}
            {recents.map((r) => (
              <Tooltip key={r.path} content={r.exists ? r.path : `${r.path} (moved or deleted)`}>
                <button
                  className="launcher-item"
                  disabled={busy || !r.exists}
                  onClick={() => void handleOpen(r.path, setOpenError)}
                >
                  <span className="item-text">
                    <span className="item-name">{r.name}</span>
                    <span className="item-path">{r.exists ? r.path : 'moved or deleted'}</span>
                  </span>
                  <span className="item-go" aria-hidden="true">
                    <Icon name="chevron" />
                  </span>
                </button>
              </Tooltip>
            ))}
          </div>

          <h3 className="launcher-section">Examples</h3>
          <div className="launcher-list">
            {examples.length === 0 && (
              <div className="launcher-empty">No example projects yet.</div>
            )}
            {examples.map((ex) => (
              <Tooltip key={ex.path} content={ex.path}>
                <button
                  className="launcher-item"
                  disabled={busy}
                  onClick={() => void handleOpen(ex.path, setOpenError)}
                >
                  <span className="item-text">
                    <span className="item-name">{ex.name}</span>
                    <span className="item-desc">{ex.description}</span>
                  </span>
                  <span className="item-go" aria-hidden="true">
                    <Icon name="chevron" />
                  </span>
                </button>
              </Tooltip>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
