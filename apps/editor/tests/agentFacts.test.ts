/**
 * Tests for the house-facts block: what an agent is told, once, about the
 * room it is working in (game pane, evidence dir, context dir) and how that
 * block composes with a person's own personalization.
 *
 * The block has to stay facts, not direction — it never gets to pick a genre
 * or a library, only say where things live — and it has to stay deterministic,
 * because a transcript diff between two conversations is read as "the
 * environment differed", not "the phrasing did".
 */
import { describe, it, expect } from 'vitest';
import { composeAgentInstructions, GAME_ENTRY_CANDIDATES, hearthFactsPrompt } from '../server/agentFacts';

describe('hearthFactsPrompt without the probe', () => {
  const text = hearthFactsPrompt({ probeCli: false });

  it('describes the game pane serving the project folder', () => {
    expect(text).toContain('game pane');
    expect(text).toContain('serves');
  });

  it('lists every game-entry candidate the pane looks for', () => {
    for (const entry of GAME_ENTRY_CANDIDATES) {
      expect(text).toContain(entry);
    }
  });

  it('points at where playtest evidence lands', () => {
    expect(text).toContain('.hearth/evidence/');
    expect(text).toContain('sweeps/<n>/report.json');
  });

  it('points at the context dir', () => {
    expect(text).toContain('.hearth/context/');
  });

  // Playtesting is passive now. An agent that tells the person to press a
  // button they cannot find is worse than one that never mentions playtesting.
  it('never sends the person to a playtest control', () => {
    expect(text).not.toContain('press Playtest');
    expect(text).not.toContain('Playtest button');
  });

  it('says nothing about hearth-probe when the CLI is not on PATH', () => {
    expect(text).not.toContain('hearth-probe');
  });
});

describe('hearthFactsPrompt with the probe', () => {
  const text = hearthFactsPrompt({ probeCli: true });

  it('adds the probe commands only spoken when they would actually run', () => {
    expect(text).toContain('hearth-probe sweep');
    expect(text).toContain('hearth-probe shim');
  });
});

describe('facts vs. direction', () => {
  it('never tells the agent what to build', () => {
    const text = hearthFactsPrompt({ probeCli: true });
    expect(text).not.toContain('should build');
    expect(text).not.toContain('must build');
  });

  it('is deterministic: same options, same string', () => {
    expect(hearthFactsPrompt({ probeCli: false })).toBe(hearthFactsPrompt({ probeCli: false }));
  });
});

describe('composeAgentInstructions', () => {
  it('puts the facts first, ahead of the person’s own preferences', () => {
    const facts = 'the room';
    const personal = 'the person’s standing preferences';
    const composed = composeAgentInstructions(facts, personal) ?? '';
    expect(composed.indexOf(facts)).toBeLessThan(composed.indexOf(personal));
  });

  it('is null when both parts are null, empty, or whitespace', () => {
    expect(composeAgentInstructions(null, null)).toBeNull();
    expect(composeAgentInstructions('', '')).toBeNull();
    expect(composeAgentInstructions('   ', '\n\n')).toBeNull();
    expect(composeAgentInstructions(null, '  ')).toBeNull();
  });

  it('passes a single part through without a joiner', () => {
    expect(composeAgentInstructions('facts only', null)).toBe('facts only');
    expect(composeAgentInstructions(null, 'personal only')).toBe('personal only');
    expect(composeAgentInstructions('facts only', '')).toBe('facts only');
  });
});
