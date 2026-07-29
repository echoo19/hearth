/**
 * `mapClaudeModels` — turning the Agent SDK's `supportedModels()` answer into
 * the rows the model selector renders.
 *
 * This is the mapper only, never the real SDK: reading the live catalogue opens
 * the Claude Code CLI, so a test that used it would answer one way on a laptop
 * with claude installed and signed in, another way on the next laptop, and
 * nothing at all on CI. `readClaudeModels` (the half that spawns) is the seam
 * callers inject around; this file exists so every shape the CLI might hand
 * back is pinned without a process in sight.
 *
 * The payloads below are the real ones, copied from a live `supportedModels()`
 * against the installed SDK rather than invented.
 */
import { describe, expect, it } from 'vitest';
import { effectiveModel, effortOptions, modelRowCovers } from '../src/chat/modelChoice';
import type { AgentChoice, ChatProviderStatus } from '../src/types';
import { mapClaudeModels } from '../server/claudeModels';
import { CLAUDE_EFFORT_LEVELS } from '../server/chat';

const SONNET = {
  value: 'sonnet',
  resolvedModel: 'claude-sonnet-5',
  displayName: 'Sonnet',
  description: 'Sonnet 5 · Efficient for routine tasks',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsAdaptiveThinking: true,
  supportsAutoMode: true,
};

/** The row that shipped with no effort dial at all, in the same answer. */
const HAIKU = {
  value: 'haiku',
  resolvedModel: 'claude-haiku-4-5-20251001',
  displayName: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
};

describe('a real catalogue', () => {
  it('reads the fields the selector shows, and only those', () => {
    expect(mapClaudeModels([SONNET])).toEqual([
      {
        id: 'sonnet',
        label: 'Sonnet',
        // Carried for MATCHING, never for sending. Claude's catalogue is
        // aliases, so a choice stored by an older build as `claude-sonnet-5`
        // matched no row at all: nothing ticked in the menu and no effort
        // dial, because the efforts live on the row that was never found. The
        // id sent with a turn is still the alias the person picked.
        resolvedModel: 'claude-sonnet-5',
        description: 'Sonnet 5 · Efficient for routine tasks',
        efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }],
      },
    ]);
  });

  it('offers every effort the SDK names, in the order it named them', () => {
    // The five words are the SDK's, not ours: the driver checks the same list
    // on the way out, so a catalogue that offered a sixth would be a menu row
    // that does nothing.
    expect(mapClaudeModels([SONNET])[0].efforts?.map((e) => e.id)).toEqual([...CLAUDE_EFFORT_LEVELS]);
  });

  it('keeps the id the catalogue said to send, not the model it resolves to', () => {
    // `resolvedModel` is what the alias points at TODAY. Sending it would pin
    // the conversation to a snapshot of a row the user picked by name.
    expect(mapClaudeModels([SONNET])[0].id).toBe('sonnet');
  });

  it('never invents a default model or a default effort', () => {
    // `ModelInfo` carries neither. The catalogue says which models exist, not
    // which one the CLI would pick, and a ticked row nobody chose is a guess
    // shown as fact.
    const row = mapClaudeModels([SONNET])[0];
    expect(row).not.toHaveProperty('isDefault');
    expect(row).not.toHaveProperty('defaultEffort');
  });
});

describe('the effort dial follows the capability flag', () => {
  it('leaves the key off entirely for a model that declares no effort support', () => {
    // Absent rather than empty: the picker renders the control when there is
    // an `efforts` array at all, so an empty one would be a dial with nothing
    // in it. Haiku really does come back like this.
    const [row] = mapClaudeModels([HAIKU]);
    expect(row).toEqual({
      id: 'haiku',
      label: 'Haiku',
      resolvedModel: 'claude-haiku-4-5-20251001',
      description: 'Haiku 4.5 · Fastest for quick answers',
    });
    expect(row).not.toHaveProperty('efforts');
  });

  it('trusts supportsEffort over the level list when the two disagree', () => {
    // A row that lists levels without claiming the capability gets no dial.
    // The flag is the model's answer to "do I have one"; the list is only what
    // the dial would contain, and offering an effort the model rejects is a
    // turn that fails for a reason the user could not have predicted.
    const levels = ['low', 'high'];
    expect(mapClaudeModels([{ ...HAIKU, supportedEffortLevels: levels }])[0]).not.toHaveProperty('efforts');
    expect(
      mapClaudeModels([{ ...HAIKU, supportsEffort: false, supportedEffortLevels: levels }])[0],
    ).not.toHaveProperty('efforts');
    // And the mirror: the capability claimed with no list is still no dial.
    expect(mapClaudeModels([{ ...HAIKU, supportsEffort: true }])[0]).not.toHaveProperty('efforts');
  });

  it('drops a word the SDK would not accept rather than offering it', () => {
    // `ultra` is a REAL effort — codex's. A catalogue that offered it here
    // would produce a turn the driver then has to drop on the way out, so the
    // two ends check the same five words.
    const row = mapClaudeModels([
      { ...SONNET, supportedEffortLevels: ['low', 'ultra', 'high', 'low', 42, null] },
    ])[0];
    expect(row.efforts).toEqual([{ id: 'low' }, { id: 'high' }]);
  });

  it('leaves the key off when none of the words are usable', () => {
    expect(
      mapClaudeModels([{ ...SONNET, supportedEffortLevels: ['ultra', 'extreme'] }])[0],
    ).not.toHaveProperty('efforts');
  });
});

describe('payloads that are not a usable catalogue', () => {
  it('drops a row with no model id rather than rendering it', () => {
    // A menu entry that names no model is worse than a shorter menu.
    const models = mapClaudeModels([
      { displayName: 'Nameless' },
      { value: '   ', displayName: 'Blank' },
      { value: 42, displayName: 'Numeric' },
      null,
      'sonnet',
      ['sonnet'],
      SONNET,
    ]);
    expect(models.map((m) => m.id)).toEqual(['sonnet']);
  });

  it('falls back to the id when the row has no display name', () => {
    expect(mapClaudeModels([{ value: 'opus[1m]' }])).toEqual([{ id: 'opus[1m]', label: 'opus[1m]' }]);
  });

  it('reads an empty catalogue as an empty list, which is the fallback signal', () => {
    expect(mapClaudeModels([])).toEqual([]);
  });

  it('never throws on something that is not a catalogue at all', () => {
    // This crosses a process boundary to a CLI the user can upgrade underneath
    // us. Empty is how every one of these says "use the curated list".
    for (const raw of [null, undefined, {}, 'sonnet', 7, { data: [SONNET] }]) {
      expect(() => mapClaudeModels(raw)).not.toThrow();
      expect(mapClaudeModels(raw)).toEqual([]);
    }
  });
});

/**
 * The bug this whole field exists to stop, pinned end to end.
 *
 * Claude's catalogue is aliases. Hearth used to ship a curated list of
 * explicit ids, so a real person's stored choice says `claude-sonnet-5` while
 * every row now says `sonnet`. Matching on id alone found nothing: the menu
 * ticked no row, the pill fell back to a hardcoded label table, and the effort
 * dial never appeared at all, because the efforts live on the row that was
 * never found. Caught in a browser, not by a test, which is why there is one
 * now.
 */
describe('a choice stored before the catalogue became aliases', () => {
  const models = mapClaudeModels([SONNET, HAIKU]);

  it('finds the alias row that covers an explicit wire id', () => {
    const sonnet = models.find((m) => m.id === 'sonnet');
    expect(sonnet).toBeTruthy();
    expect(modelRowCovers(sonnet!, 'claude-sonnet-5')).toBe(true);
    // ...and does not spill onto a neighbour.
    expect(modelRowCovers(sonnet!, 'claude-haiku-4-5-20251001')).toBe(false);
  });

  it('still matches a choice that names the alias itself', () => {
    const sonnet = models.find((m) => m.id === 'sonnet')!;
    expect(modelRowCovers(sonnet, 'sonnet')).toBe(true);
  });

  it('resolves the effort dial through that same match', () => {
    // The real symptom. `effectiveModel` is what the effort control reads, and
    // an old stored id used to resolve to null here, so the control rendered
    // nothing and looked like a feature that had never been built.
    const providers = {
      anthropic: { hasKey: false, source: null, cli: true, loggedIn: true, email: null, planType: null, models },
      openai: {
        installed: false,
        version: null,
        loggedIn: false,
        authMode: null,
        email: null,
        planType: null,
        hasKey: false,
      },
      active: 'anthropic',
    } as unknown as ChatProviderStatus;
    const choice = { provider: 'anthropic', model: 'claude-sonnet-5', effort: null } as AgentChoice;
    expect(effectiveModel(choice, providers)?.id).toBe('sonnet');
    expect(effortOptions(choice, providers).map((e) => e.id)).toContain('xhigh');
  });

  it('offers no dial for a covered row that has no efforts', () => {
    const providers = {
      anthropic: { hasKey: false, source: null, cli: true, loggedIn: true, email: null, planType: null, models },
      openai: {
        installed: false,
        version: null,
        loggedIn: false,
        authMode: null,
        email: null,
        planType: null,
        hasKey: false,
      },
      active: 'anthropic',
    } as unknown as ChatProviderStatus;
    const choice = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', effort: null } as AgentChoice;
    expect(effectiveModel(choice, providers)?.id).toBe('haiku');
    expect(effortOptions(choice, providers)).toEqual([]);
  });
});
