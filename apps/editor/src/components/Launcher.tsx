/**
 * Two doors.
 *
 * Start from a prompt: pick an empty folder, and the thing you typed is
 * waiting in the composer when the app opens. Or open a folder you already
 * have. That's the whole launcher — there is nothing to configure before the
 * first sentence.
 */
import React, { useEffect, useState } from 'react';
import { useApp } from '../store';
import { apiRecentWorkspaces } from '../api';
import type { RecentWorkspace } from '../types';
import { Icon } from './ui';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { hearthNative } from '../native';

/** Which door is currently in flight, if any. */
export type LauncherBusy = 'start' | 'open' | null;

/**
 * Label for a door's button while it works. Pure, so the busy contract is
 * unit-tested without a DOM: a slow filesystem must never look like nothing
 * happened.
 */
export function launcherButtonLabel(busy: LauncherBusy, kind: 'start' | 'open', idle: string): string {
  if (busy !== kind) return idle;
  return kind === 'start' ? 'Opening…' : 'Opening…';
}

/**
 * Run one door with a guaranteed reset, so a rejected picker or a failed open
 * can't strand the launcher disabled.
 */
export async function withBusy<T>(
  kind: Exclude<LauncherBusy, null>,
  setBusy: (busy: LauncherBusy) => void,
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
  const openWorkspace = useApp((s) => s.openWorkspace);
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [prompt, setPrompt] = useState('');
  const [openPath, setOpenPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<LauncherBusy>(null);
  const native = hearthNative();

  useEffect(() => {
    void apiRecentWorkspaces().then(setRecents);
  }, []);

  async function open(path: string, carriedPrompt?: string): Promise<void> {
    if (!path.trim()) {
      setError('Choose a folder to work in.');
      return;
    }
    setError('');
    const res = await withBusy('open', setBusy, () => openWorkspace(path.trim(), carriedPrompt));
    if (!res.ok) setError(res.error ?? 'Could not open that folder.');
  }

  async function startFromPrompt(): Promise<void> {
    if (!native) {
      setError('Type a folder path below to open one in the browser.');
      return;
    }
    setError('');
    const picked = await withBusy('start', setBusy, () => native.pickDirectory());
    if (!picked) return;
    await open(picked, prompt);
  }

  async function browseOpen(): Promise<void> {
    if (!native) return;
    const picked = await native.pickDirectory();
    if (picked) {
      setOpenPath(picked);
      await open(picked);
    }
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
        <p className="tagline">Say what you want to play. It gets built here.</p>
      </header>

      <div className="launcher-doors">
        <section className="launcher-door">
          <h2>Start from a prompt</h2>
          <textarea
            className="textarea launcher-prompt"
            rows={3}
            value={prompt}
            placeholder="a top-down space shooter with asteroids"
            aria-label="What do you want to make?"
            onChange={(e) => setPrompt(e.target.value)}
          />
          <p className="launcher-hint">Pick an empty folder. Your words are waiting in the composer when it opens.</p>
          <Button variant="primary" disabled={busy !== null} onClick={() => void startFromPrompt()}>
            {launcherButtonLabel(busy, 'start', 'Choose a folder…')}
          </Button>
        </section>

        <section className="launcher-door">
          <h2>Open a folder</h2>
          <div className="row">
            <input
              className="input mono"
              value={openPath}
              placeholder="/absolute/path/to/folder"
              aria-label="Folder path"
              onChange={(e) => setOpenPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void open(openPath);
              }}
            />
            <Button disabled={busy !== null} onClick={() => void open(openPath)}>
              {launcherButtonLabel(busy, 'open', 'Open')}
            </Button>
            {native && (
              <Button disabled={busy !== null} onClick={() => void browseOpen()}>
                Browse…
              </Button>
            )}
          </div>

          <h3 className="launcher-section">Recent</h3>
          <div className="launcher-list">
            {recents.length === 0 && <div className="launcher-empty">Folders you open show up here.</div>}
            {recents.map((recent) => (
              <Tooltip key={recent.path} content={recent.exists ? recent.path : `${recent.path} (moved or deleted)`}>
                <button
                  className="launcher-item"
                  disabled={busy !== null || !recent.exists}
                  onClick={() => void open(recent.path)}
                >
                  <span className="item-text">
                    <span className="item-name">{recent.name}</span>
                    <span className="item-path">{recent.exists ? recent.path : 'moved or deleted'}</span>
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

      {error && <div className="launcher-error">{error}</div>}
    </div>
  );
}
