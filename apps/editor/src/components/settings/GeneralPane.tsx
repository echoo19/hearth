/**
 * General: which Hearth this is, and where it puts things.
 *
 * Deliberately short. There is no appearance control here because Hearth is
 * dark by intent — the game in the pane has to be the brightest thing on
 * screen — and a theme switch that only ever has one answer is a control that
 * lies about what the app can do. The same rule keeps out a language picker, a
 * font size and every other setting a panel this shape usually collects: this
 * pane holds the things that are true, and it is allowed to be small.
 *
 * The paths are the useful part. People want to know where a new game lands
 * before they make one, and where the app keeps the things that are not in a
 * game, so both are stated rather than left to be discovered in Finder.
 */
import React, { useState } from 'react';
import { hearthNative } from '../../native';
import { useApp } from '../../store';
import { Button } from '../ui/Button';
import { SettingsGroup, SettingsRow } from './SettingsRow';

export function GeneralPane() {
  const meta = useApp((s) => s.meta);
  const updateReady = useApp((s) => s.updateReady);
  const relaunchToUpdate = useApp((s) => s.relaunchToUpdate);
  const projectPath = useApp((s) => s.projectPath);
  const native = hearthNative();
  const [checking, setChecking] = useState(false);

  // Optional on the preload: a renderer that has updated ahead of its preload
  // — which is exactly the boot right after an update — must not offer a
  // button that throws.
  const canCheck = typeof native?.checkForUpdates === 'function';

  async function check(): Promise<void> {
    if (!native?.checkForUpdates) return;
    setChecking(true);
    try {
      // The main process owns the whole flow including its result dialogs, so
      // there is nothing to report back here.
      await native.checkForUpdates();
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <h2 className="set-pane-title">General</h2>
      <p className="set-pane-lead">Which Hearth this is, and where it keeps what it makes.</p>

      <SettingsGroup title="Version">
        <SettingsRow
          label="Hearth"
          hint={meta ? undefined : 'Still asking the app server.'}
          control={
            <>
              <span className="set-value mono">{meta?.hearthVersion ?? 'Not known yet'}</span>
              {canCheck && (
                <Button disabled={checking} onClick={() => void check()}>
                  {checking ? 'Checking…' : 'Check for updates'}
                </Button>
              )}
            </>
          }
        />
        {updateReady && (
          <SettingsRow
            label="Update ready"
            hint={`Version ${updateReady.version} is downloaded. It installs when Hearth restarts.`}
            control={
              <Button variant="primary" icon="restart" onClick={() => void relaunchToUpdate()}>
                Restart now
              </Button>
            }
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="Folders">
        <SettingsRow
          label="New games"
          hint="Hearth makes a folder in here for each game you start, named after what you asked for."
          control={<span className="set-value mono">~/Hearth</span>}
        />
        <SettingsRow
          label="Skills and personalization"
          hint="Kept outside your games, so what you teach an agent once is still there in the next thing you make."
          control={<span className="set-value mono">~/.hearth</span>}
        />
        <SettingsRow
          label="Open folder"
          hint={
            projectPath !== null ? (
              <span className="mono">{projectPath}</span>
            ) : (
              'Nothing open right now.'
            )
          }
          control={
            projectPath !== null && native ? (
              <Button icon="folder" onClick={() => void native.revealInFolder(projectPath)}>
                Reveal in Finder
              </Button>
            ) : undefined
          }
        />
      </SettingsGroup>
    </>
  );
}
