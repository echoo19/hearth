/**
 * Which models the user wants offered, on disk and in the picker.
 *
 * Two halves, and the interesting one is the storage. `~/.hearth/models.json`
 * holds the models that are OFF, and the whole design rests on three
 * properties that are easy to lose and expensive to lose:
 *
 *   1. a model nobody has seen defaults to ON, so the file stores the
 *      complement and a missing file means "nothing is switched off";
 *   2. an id the reader does not recognise SURVIVES a round trip. A model can
 *      vanish from a provider's catalogue for a week and come back, and it has
 *      to come back still switched off. The equivalent bug has already
 *      happened once in this app: an unrecognised effort value failed
 *      validation and nulled the whole stored choice, taking the model with
 *      it. So validation here checks shape and only shape;
 *   3. a write is a PATCH of one model. A client can only see the models its
 *      backends currently report, so a client that sent the whole list would
 *      prune every entry from (2) the moment anyone toggled anything.
 *
 * The second half is the point of the feature: a switched-off model is not in
 * the composer's menu.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_DISABLED_MODELS,
  cleanDisabled,
  getModelPrefs,
  isModelKey,
  modelKey,
  modelPrefsPath,
  postModelPrefs,
  readModelPrefs,
  setModelDisabled,
} from '../server/modelPrefs';
import {
  canSetModelEnabled,
  enabledModels,
  isModelEnabled,
  modelKey as clientModelKey,
  reconcileChoice,
} from '../src/chat/modelChoice';
import { NOTHING_DISABLED, modelGroups } from '../src/components/chat/ModelSelector';
import type { AgentChoice, ChatProviderStatus, ProviderModelInfo } from '../src/types';

let home = '';
let previous: string | undefined;

beforeEach(async () => {
  previous = process.env.HEARTH_HOME;
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-models-'));
  process.env.HEARTH_HOME = home;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.HEARTH_HOME;
  else process.env.HEARTH_HOME = previous;
  await fsp.rm(home, { recursive: true, force: true });
});

const read = async (): Promise<string> => fsp.readFile(modelPrefsPath(), 'utf8');

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

describe('modelKey', () => {
  it('scopes a model by the provider that drives it', () => {
    expect(modelKey('anthropic', 'claude-opus-5')).toBe('anthropic:claude-opus-5');
    // The client builds the same string, because the two halves of this
    // feature agree about nothing else.
    expect(clientModelKey('openai', 'gpt-5.6-sol')).toBe('openai:gpt-5.6-sol');
  });

  it('accepts an id no version of Hearth has ever heard of', () => {
    // The vocabulary is the backend's, not ours. A shape check that guessed at
    // it would reject models that have not shipped yet.
    expect(isModelKey('openai:gpt-9.9-something-new')).toBe(true);
    expect(isModelKey('anthropic:claude-opus-99-20991231')).toBe(true);
  });

  it('refuses a key that is not one', () => {
    expect(isModelKey('claude-opus-5')).toBe(false); // no provider
    expect(isModelKey('mistral:large')).toBe(false); // not a provider Hearth drives
    expect(isModelKey('anthropic:')).toBe(false); // no model
    expect(isModelKey('anthropic:../../etc/passwd')).toBe(false);
    expect(isModelKey(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

describe('readModelPrefs', () => {
  it('reads a missing file as "nothing is switched off"', async () => {
    // The normal state, not an error state: nobody has been here yet.
    expect(await readModelPrefs()).toEqual({ disabled: [] });
  });

  it('reads a corrupt file as "nothing is switched off" rather than throwing', async () => {
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(modelPrefsPath(), '{ this is not json');
    expect(await readModelPrefs()).toEqual({ disabled: [] });
  });

  it('survives a file whose shape is wrong in every way', async () => {
    await fsp.mkdir(home, { recursive: true });
    for (const junk of ['[]', 'null', '"a string"', '{"disabled":"nope"}', '{}']) {
      await fsp.writeFile(modelPrefsPath(), junk);
      expect(await readModelPrefs()).toEqual({ disabled: [] });
    }
  });

  it('keeps the good entries in a file with one bad one', async () => {
    // Failing the whole read on one junk line would silently switch every
    // other model back on, which is the loud kind of wrong.
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(
      modelPrefsPath(),
      JSON.stringify({ disabled: ['anthropic:claude-opus-5', 17, 'nonsense', 'openai:gpt-5.4-mini'] }),
    );
    expect((await readModelPrefs()).disabled).toEqual(['anthropic:claude-opus-5', 'openai:gpt-5.4-mini']);
  });
});

describe('cleanDisabled', () => {
  it('de-duplicates and sorts, so the file is stable across saves', () => {
    expect(cleanDisabled(['openai:b', 'anthropic:a', 'openai:b'])).toEqual(['anthropic:a', 'openai:b']);
  });

  it('caps a file that has grown beyond anything a real catalogue could be', () => {
    const many = Array.from({ length: MAX_DISABLED_MODELS + 50 }, (_, i) => `openai:m${i}`);
    expect(cleanDisabled(many)).toHaveLength(MAX_DISABLED_MODELS);
  });
});

describe('setModelDisabled', () => {
  it('round-trips one model off and back on', async () => {
    expect(await setModelDisabled('anthropic:claude-opus-5', true)).toEqual({
      disabled: ['anthropic:claude-opus-5'],
    });
    expect(await readModelPrefs()).toEqual({ disabled: ['anthropic:claude-opus-5'] });

    expect(await setModelDisabled('anthropic:claude-opus-5', false)).toEqual({ disabled: [] });
    expect(await readModelPrefs()).toEqual({ disabled: [] });
  });

  it('deletes the file rather than leaving an empty list behind', async () => {
    await setModelDisabled('openai:gpt-5.4-mini', true);
    await expect(read()).resolves.toContain('gpt-5.4-mini');
    await setModelDisabled('openai:gpt-5.4-mini', false);
    // "Nothing switched off" and "no file" are the same state.
    await expect(read()).rejects.toThrow();
  });

  it('MERGES: an id this client cannot see is not pruned by a write', async () => {
    // The bug this exists to prevent. A model vanishes from the catalogue, the
    // user toggles something else, and their choice about the vanished one
    // must still be there when it comes back.
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(
      modelPrefsPath(),
      JSON.stringify({ disabled: ['openai:gpt-retired-for-now', 'anthropic:claude-opus-5'] }),
    );

    const after = await setModelDisabled('anthropic:claude-opus-5', false);
    expect(after.disabled).toEqual(['openai:gpt-retired-for-now']);

    // And it comes back off, because it was never turned on.
    expect(isModelEnabled('openai', 'gpt-retired-for-now', new Set(after.disabled))).toBe(false);
  });

  it('is idempotent, so a double click cannot double an entry', async () => {
    await setModelDisabled('openai:gpt-5.4-mini', true);
    expect(await setModelDisabled('openai:gpt-5.4-mini', true)).toEqual({ disabled: ['openai:gpt-5.4-mini'] });
  });

  it('writes a file a person can read and edit', async () => {
    await setModelDisabled('anthropic:claude-opus-5', true);
    const text = await read();
    expect(JSON.parse(text)).toEqual({ disabled: ['anthropic:claude-opus-5'] });
    expect(text.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe('the route', () => {
  it('answers a read with the list and where it lives', async () => {
    const result = await getModelPrefs();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, disabled: [], file: modelPrefsPath() });
  });

  it('takes one model and a boolean, and nothing else', async () => {
    const off = await postModelPrefs({ model: 'openai:gpt-5.4-mini', enabled: false });
    expect(off.status).toBe(200);
    expect((off.body as { disabled: string[] }).disabled).toEqual(['openai:gpt-5.4-mini']);
  });

  it('refuses a request that is not one', async () => {
    for (const bad of [{}, { model: 'openai:x' }, { enabled: false }, { model: 12, enabled: true }]) {
      expect((await postModelPrefs(bad)).status).toBe(400);
    }
  });

  it('refuses a model id it could not store, rather than storing junk', async () => {
    const result = await postModelPrefs({ model: 'not-a-key', enabled: false });
    expect(result.status).toBe(400);
    expect(await readModelPrefs()).toEqual({ disabled: [] });
  });

  it('does not accept a whole list, because a whole list would prune', async () => {
    // `.strict()` on the patch schema is what enforces (3) at the wire.
    expect((await postModelPrefs({ disabled: ['openai:gpt-5.4-mini'] })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// What the picker does with it
// ---------------------------------------------------------------------------

const CODEX_MODELS: ProviderModelInfo[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', isDefault: true },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
];

function providers(): ChatProviderStatus {
  return {
    anthropic: {
      hasKey: true,
      source: 'project',
      models: [
        { id: 'claude-opus-5', label: 'Opus 5' },
        { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      ],
    },
    openai: {
      installed: true,
      version: '1.0.0',
      loggedIn: true,
      authMode: 'chatgpt',
      email: null,
      planType: null,
      hasKey: false,
      models: CODEX_MODELS,
    },
    active: 'anthropic',
  };
}

describe('a switched-off model leaves the picker', () => {
  it('is gone from its group, and only from its group', () => {
    const off = new Set(['anthropic:claude-sonnet-5']);
    const groups = modelGroups(providers(), off);
    expect(groups[0].models.map((m) => m.id)).toEqual(['claude-opus-5']);
    // The other harness is untouched: the key is scoped by provider.
    expect(groups[1].models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.4-mini']);
  });

  it('can be switched off down to an empty group, which is why the guard exists', () => {
    // There is no automatic row to fall back on any more, so switching every
    // named model off really does leave a harness with nothing to drive. That
    // makes `canSetModelEnabled` the only thing standing between the user and
    // a dead menu rather than a courtesy, and the menu says "No models
    // reported" rather than showing a header over nothing.
    const off = new Set(['openai:gpt-5.6-sol', 'openai:gpt-5.4-mini']);
    expect(modelGroups(providers(), off)[1].models).toEqual([]);
  });

  it('shows everything again when Settings asks for the unfiltered catalogue', () => {
    const off = new Set(['anthropic:claude-sonnet-5']);
    expect(modelGroups(providers(), NOTHING_DISABLED)[0].models.map((m) => m.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
    // The switch has to be visible on the one screen that can flip it back.
    expect(isModelEnabled('anthropic', 'claude-sonnet-5', off)).toBe(false);
  });

  it('keeps an unknown switched-off id out without disturbing the rest', () => {
    const off = new Set(['anthropic:claude-opus-4-that-does-not-exist']);
    expect(modelGroups(providers(), off)[0].models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });
});

describe('enabledModels', () => {
  it('filters a catalogue by provider-scoped key', () => {
    const off = new Set(['openai:gpt-5.4-mini']);
    expect(enabledModels('openai', CODEX_MODELS, off).map((m) => m.id)).toEqual(['gpt-5.6-sol']);
    // Same bare id under a different provider is a different model.
    expect(enabledModels('anthropic', CODEX_MODELS, off).map((m) => m.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.4-mini',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The two edges
// ---------------------------------------------------------------------------

describe('switching off the model that is currently selected', () => {
  const chosen: AgentChoice = { provider: 'openai', model: 'gpt-5.4-mini', effort: 'high' };

  it('falls back to the harness default rather than sending a model that is gone', () => {
    const off = new Set(['openai:gpt-5.4-mini']);
    expect(reconcileChoice(chosen, off)).toEqual({ provider: 'openai', model: null, effort: 'high' });
  });

  it('keeps the harness, because that half is not what changed', () => {
    expect(reconcileChoice(chosen, new Set(['openai:gpt-5.4-mini']))?.provider).toBe('openai');
  });

  it('leaves a choice alone when the model it names is still offered', () => {
    const off = new Set(['openai:gpt-5.6-sol']);
    // Same object back: nothing to reconcile, so nothing is rewritten.
    expect(reconcileChoice(chosen, off)).toBe(chosen);
    expect(reconcileChoice(null, off)).toBeNull();
  });

  it('leaves the effort to agentForTurn rather than deciding it twice', () => {
    // Two copies of "which efforts does this model take" would eventually
    // disagree. This one only ever clears the model.
    expect(reconcileChoice(chosen, new Set(['openai:gpt-5.4-mini']))?.effort).toBe('high');
  });
});

describe('you cannot switch everything off', () => {
  const off = new Set(['openai:gpt-5.4-mini']);

  it('refuses the last one standing, and says so on the row', () => {
    expect(canSetModelEnabled('openai', CODEX_MODELS, off, 'gpt-5.6-sol', false)).toBe(false);
  });

  it('allows it while there is another one on', () => {
    expect(canSetModelEnabled('openai', CODEX_MODELS, new Set(), 'gpt-5.6-sol', false)).toBe(true);
  });

  it('never refuses switching one back ON', () => {
    const allOff = new Set(['openai:gpt-5.6-sol', 'openai:gpt-5.4-mini']);
    expect(canSetModelEnabled('openai', CODEX_MODELS, allOff, 'gpt-5.6-sol', true)).toBe(true);
  });

  it('does not count Automatic, which is not a model and has no switch', () => {
    const withAuto: ProviderModelInfo[] = [{ id: '', label: 'Automatic' }, ...CODEX_MODELS];
    expect(canSetModelEnabled('openai', withAuto, off, 'gpt-5.6-sol', false)).toBe(false);
  });
});
