/**
 * The one settings surface: which agent answers.
 *
 * Two providers, asked for in the terms each one actually uses — Anthropic is
 * a key you paste, OpenAI is a CLI you install and sign into — but presented
 * in one vocabulary, so neither reads as the afterthought. Nothing here is a
 * raw field into a config file: every control is typed and named.
 *
 * A secret written here goes to `.hearth/app.json` in the open folder and
 * never comes back. The dialog only ever learns whether one is configured and
 * where it came from.
 */
import React, { useEffect, useState } from 'react';
import { useApp } from '../../store';
import { apiSaveProviderSettings, type ProviderSettingsPatch } from '../../api';
import type { ChatProvider, ChatProviderStatus } from '../../types';
import { Modal } from '../ui';
import { Button } from '../ui/Button';

/** How the current Anthropic credential source reads in one line. */
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

/**
 * Where the Codex side stands, as one line. Ordered by what blocks the user
 * first: a missing binary is a different problem from a missing sign-in, and
 * saying "not signed in" to someone who hasn't installed it wastes their time.
 */
export function openAiStatusLabel(openai: ChatProviderStatus['openai'] | undefined): string {
  if (!openai || !openai.installed) return 'Not installed.';
  if (openai.loggedIn) {
    if (openai.authMode === 'apikey') return 'Signed in with an API key.';
    const who = openai.email ?? 'ChatGPT';
    return openai.planType ? `Signed in as ${who} (${openai.planType}).` : `Signed in as ${who}.`;
  }
  return openai.hasKey ? 'Installed. Using the API key saved for this folder.' : 'Installed, not signed in.';
}

/** Can this provider answer a turn right now? */
export function anthropicUsable(status: ChatProviderStatus | null): boolean {
  return status?.anthropic.hasKey === true;
}

export function openAiUsable(status: ChatProviderStatus | null): boolean {
  return status?.openai.installed === true && (status.openai.loggedIn || status.openai.hasKey);
}

export function SettingsDialog() {
  const project = useApp((s) => s.projectPath);
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const startOpenAiLogin = useApp((s) => s.startOpenAiLogin);
  const [open, setOpen] = useState(false);
  // Drafts are `null` until touched, which is what tells a save "leave this
  // one alone": an empty string is a real instruction here (remove the key),
  // so "untouched" and "cleared" cannot be the same value.
  const [anthropicDraft, setAnthropicDraft] = useState<string | null>(null);
  const [openAiDraft, setOpenAiDraft] = useState<string | null>(null);
  const [provider, setProvider] = useState<ChatProvider | null>(null);
  const [saving, setSaving] = useState(false);

  // Opened from the top bar and from the native menu, both of which are
  // outside this tree — one window event is cheaper than threading a callback
  // through the shell.
  useEffect(() => {
    const onOpen = (): void => {
      setAnthropicDraft(null);
      setOpenAiDraft(null);
      setProvider(null);
      setOpen(true);
      // Codex's state lives outside this app (a binary on PATH, a session on
      // disk) and can have changed since the last read.
      void refreshProviders();
    };
    window.addEventListener('hearth:open-settings', onOpen);
    return () => window.removeEventListener('hearth:open-settings', onOpen);
  }, [refreshProviders]);

  const bothUsable = anthropicUsable(providers) && openAiUsable(providers);
  const selected = provider ?? providers?.active ?? null;

  async function save(): Promise<void> {
    if (!project) return;
    const patch: ProviderSettingsPatch = {};
    if (anthropicDraft !== null) patch.apiKey = anthropicDraft.trim();
    if (openAiDraft !== null) patch.openaiApiKey = openAiDraft.trim();
    if (provider !== null) patch.provider = provider;
    setSaving(true);
    try {
      if (Object.keys(patch).length > 0) await apiSaveProviderSettings(project, patch);
      await Promise.all([refreshSettings(), refreshProviders()]);
      setAnthropicDraft(null);
      setOpenAiDraft(null);
      setProvider(null);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="Settings" onClose={() => setOpen(false)}>
      <div className="modal-body settings-body">
        <section className="settings-provider">
          <div className="settings-provider-head">
            <span className="settings-provider-name">Claude</span>
          </div>
          <label className="field-label" htmlFor="settings-key">
            Anthropic API key
          </label>
          <input
            id="settings-key"
            className="input mono"
            type="password"
            value={anthropicDraft ?? ''}
            placeholder={settings?.hasKey ? 'Saved — type to replace' : 'sk-ant-…'}
            autoComplete="off"
            onChange={(e) => setAnthropicDraft(e.target.value)}
          />
          <p className="settings-note">{keySourceLabel(settings?.source ?? null)}</p>
        </section>

        <section className="settings-provider">
          <div className="settings-provider-head">
            <span className="settings-provider-name">ChatGPT</span>
            {providers?.openai.version && (
              <span className="settings-provider-version">{providers.openai.version}</span>
            )}
          </div>
          <p className="settings-note">{openAiStatusLabel(providers?.openai)}</p>
          {providers && !providers.openai.installed ? (
            <p className="settings-note">
              Install the Codex CLI first: <span className="mono">npm i -g @openai/codex</span>
            </p>
          ) : (
            <div className="settings-provider-actions">
              <Button onClick={() => void startOpenAiLogin()}>
                {providers?.openai.loggedIn ? 'Sign in again' : 'Sign in with ChatGPT'}
              </Button>
              <span className="settings-note">Opens in your browser; this dialog updates when it finishes.</span>
            </div>
          )}
          <label className="field-label" htmlFor="settings-openai-key">
            OpenAI API key (optional)
          </label>
          <input
            id="settings-openai-key"
            className="input mono"
            type="password"
            value={openAiDraft ?? ''}
            placeholder={providers?.openai.hasKey ? 'Saved — type to replace' : 'sk-…'}
            autoComplete="off"
            onChange={(e) => setOpenAiDraft(e.target.value)}
          />
        </section>

        {/* Only a real choice when both could answer. With one usable provider
            the question has one answer, and asking it would be chrome. */}
        {bothUsable && (
          <section className="settings-provider">
            <label className="field-label" htmlFor="settings-provider">
              Answer with
            </label>
            <select
              id="settings-provider"
              className="select"
              value={selected ?? 'anthropic'}
              onChange={(e) => setProvider(e.target.value as ChatProvider)}
            >
              <option value="anthropic">Claude</option>
              <option value="openai">ChatGPT</option>
            </select>
          </section>
        )}

        <p className="settings-note">
          Stored in this folder, in <span className="mono">.hearth/app.json</span>. Clear a key field and save to
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
