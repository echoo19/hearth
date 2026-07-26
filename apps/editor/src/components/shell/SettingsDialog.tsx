/**
 * The one settings surface: which agent answers.
 *
 * The key is written to `.hearth/app.json` in the open folder and never comes
 * back to the client — the dialog only ever learns whether one is configured
 * and where it came from.
 */
import React, { useEffect, useState } from 'react';
import { useApp } from '../../store';
import { apiSaveApiKey } from '../../api';
import { Modal } from '../ui';
import { Button } from '../ui/Button';

/** How the current credential source reads in one line. */
export function keySourceLabel(source: 'project' | 'environment' | null): string {
  switch (source) {
    case 'project':
      return 'A key is saved for this folder.';
    case 'environment':
      return 'Using ANTHROPIC_API_KEY from the environment.';
    default:
      return 'No key yet. Without one, the conversation can only point you at the Terminal.';
  }
}

export function SettingsDialog() {
  const project = useApp((s) => s.projectPath);
  const settings = useApp((s) => s.settings);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // Opened from the top bar and from the native menu, both of which are
  // outside this tree — one window event is cheaper than threading a callback
  // through the shell.
  useEffect(() => {
    const onOpen = (): void => {
      setDraft('');
      setOpen(true);
    };
    window.addEventListener('hearth:open-settings', onOpen);
    return () => window.removeEventListener('hearth:open-settings', onOpen);
  }, []);

  async function save(): Promise<void> {
    if (!project) return;
    setSaving(true);
    try {
      await apiSaveApiKey(project, draft.trim());
      await refreshSettings();
      setDraft('');
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="Settings" onClose={() => setOpen(false)}>
      <div className="modal-body settings-body">
        <label className="field-label" htmlFor="settings-key">
          Anthropic API key
        </label>
        <input
          id="settings-key"
          className="input mono"
          type="password"
          value={draft}
          placeholder={settings?.hasKey ? 'Saved — type to replace' : 'sk-ant-…'}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
        />
        <p className="settings-note">{keySourceLabel(settings?.source ?? null)}</p>
        <p className="settings-note">
          Stored in this folder, in <span className="mono">.hearth/app.json</span>. Leave the field empty and save to
          remove it.
        </p>
      </div>
      <div className="modal-actions">
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Modal>
  );
}
