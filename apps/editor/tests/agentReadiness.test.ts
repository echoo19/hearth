/**
 * "Can anything answer?" has three answers, not two.
 *
 * The bug this pins: `openWorkspace` and `closeWorkspace` reset `chatDriver`,
 * `providers` and `settings` to null, so for the first moment of every new chat
 * every signal reads false. Folding that into a boolean made the empty state
 * announce "No agent is connected yet" to people whose setup was fine, then
 * take it back a moment later, which reads as the app randomly malfunctioning.
 */
import { describe, it, expect } from 'vitest';
import { agentReadiness } from '../src/components/chat/MessageList';

const NOTHING = { chatDriver: null, providers: null, settings: null };

describe('agentReadiness', () => {
  it('says nothing is known before anything has come back', () => {
    expect(agentReadiness(NOTHING)).toBe('unknown');
  });

  it('trusts a bound driver', () => {
    expect(agentReadiness({ ...NOTHING, chatDriver: 'agent-sdk' })).toBe('connected');
    expect(agentReadiness({ ...NOTHING, chatDriver: 'codex' })).toBe('connected');
  });

  it('trusts an active provider or a stored key on their own', () => {
    expect(agentReadiness({ ...NOTHING, providers: { active: 'openai' } })).toBe('connected');
    expect(agentReadiness({ ...NOTHING, settings: { hasKey: true } })).toBe('connected');
  });

  it('reports missing once the driver has bound and it was the stub', () => {
    // The stub is a real answer: the server looked and found nothing to talk
    // to. This is the only state that earns the message.
    expect(agentReadiness({ chatDriver: 'stub', providers: null, settings: null })).toBe('missing');
    expect(
      agentReadiness({ chatDriver: 'stub', providers: { active: null }, settings: { hasKey: false } }),
    ).toBe('missing');
  });

  it('will not call it missing on settings alone, before the driver has bound', () => {
    // Settings has returned and reports no key, but the socket has not said
    // which driver bound yet, and a CLI agent needs no key at all. Answering
    // here would be guessing during exactly the race this function exists to
    // avoid.
    expect(agentReadiness({ chatDriver: null, providers: null, settings: { hasKey: false } })).toBe('unknown');
    expect(
      agentReadiness({ chatDriver: null, providers: { active: null }, settings: { hasKey: false } }),
    ).toBe('unknown');
  });
});
