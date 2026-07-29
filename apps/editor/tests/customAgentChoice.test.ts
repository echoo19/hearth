// @vitest-environment jsdom
/**
 * Picking one of your own agents, from the client's side.
 *
 * The rule every one of these pins is the same one the server enforces: the app
 * must never show one agent's name while another one answers. So:
 *
 *   - a choice that names an agent OUTRANKS the model half it still carries,
 *     everywhere the app says who is answering;
 *   - nothing else in the menu reads as selected while it does;
 *   - an agent that was removed, or whose command was edited and not confirmed
 *     again, stops being the choice rather than quietly falling back under its
 *     own name;
 *   - the command line is what a row shows, because a row that spawns a program
 *     and prints only a friendly name is hiding the only fact that matters.
 */
import { describe, expect, it } from 'vitest';
import {
  choiceForCustomAgent,
  choiceWithoutCustomAgent,
  chosenCustomAgent,
  effortLabel,
  isCustomChosen,
  modelChoiceLabel,
  parseStoredChoice,
  reconcileAgentChoice,
} from '../src/chat/modelChoice';
import { customAgentBlocked, customAgentNote, isChosen } from '../src/components/chat/ModelSelector';
import { providerLabel } from '../src/components/chat/ConversationHead';
import { agentConfirmBody, agentDraftProblem, agentSavePatch } from '../src/components/settings/AgentsPane';
import type { AgentChoice, CustomAgentInfo } from '../src/types';

const agent = (over: Partial<CustomAgentInfo> = {}): CustomAgentInfo => ({
  id: 'my-agent',
  label: 'My agent',
  command: 'my-agent',
  args: ['--serve'],
  commandLine: 'my-agent --serve',
  confirmed: true,
  ...over,
});

const choice = (over: Partial<AgentChoice> = {}): AgentChoice => ({
  provider: 'anthropic',
  model: 'claude-opus-5',
  effort: null,
  agentId: null,
  ...over,
});

describe('choosing one', () => {
  it('keeps the model half, so coming back lands where you left it', () => {
    const next = choiceForCustomAgent(choice(), 'my-agent');
    expect(next).toEqual({ provider: 'anthropic', model: 'claude-opus-5', effort: null, agentId: 'my-agent' });
    expect(choiceWithoutCustomAgent(next)).toEqual(choice());
  });

  it('works from no choice at all', () => {
    expect(choiceForCustomAgent(null, 'my-agent')).toMatchObject({ agentId: 'my-agent', model: null });
  });

  it('reads and writes through storage, and refuses an id that could not exist', () => {
    expect(parseStoredChoice(JSON.stringify(choiceForCustomAgent(null, 'my-agent')))?.agentId).toBe('my-agent');
    expect(parseStoredChoice(JSON.stringify({ ...choice(), agentId: '../../etc' }))?.agentId).toBeUndefined();
    // A choice saved before any of this existed has no field at all, and comes
    // back with none: the shape older builds wrote is exactly the shape they
    // still get, which is what keeps this additive on the wire too.
    expect(parseStoredChoice('{"provider":"openai","model":null,"effort":"high"}')).toEqual({
      provider: 'openai',
      model: null,
      effort: 'high',
    });
  });
});

describe('what the app says is answering', () => {
  it('names the agent on the composer pill, over the model it still carries', () => {
    expect(modelChoiceLabel(choice({ agentId: 'my-agent' }), null, [agent()])).toBe('My agent');
    // ...and falls back to the id rather than to a model name, because saying
    // "Opus 5" while a registered program answers is the lie this prevents.
    expect(modelChoiceLabel(choice({ agentId: 'my-agent' }), null, [])).toBe('my-agent');
  });

  it('names it in the conversation header, over the active provider', () => {
    const providers = { active: 'anthropic' } as never;
    expect(providerLabel(providers, 'custom', 'My agent')).toBe('My agent');
    expect(providerLabel(providers, 'custom', null)).toBe('Your agent');
    // Nothing changes for the two vendors.
    expect(providerLabel(providers, 'agent-sdk')).toBe('Claude');
  });

  it('shows no effort dial for an agent whose vocabulary Hearth does not know', () => {
    expect(effortLabel(choice({ provider: 'openai', effort: 'high' }))).toBe('High');
    expect(effortLabel(choice({ provider: 'openai', effort: 'high', agentId: 'my-agent' }))).toBeNull();
  });

  it('leaves nothing else in the menu ticked', () => {
    expect(isChosen(choice(), 'anthropic', 'claude-opus-5')).toBe(true);
    expect(isChosen(choice({ agentId: 'my-agent' }), 'anthropic', 'claude-opus-5')).toBe(false);
    expect(isCustomChosen(choice({ agentId: 'my-agent' }), 'my-agent')).toBe(true);
    expect(isCustomChosen(choice(), 'my-agent')).toBe(false);
  });

  it('prints the command line on the row, and says so when it cannot run', () => {
    expect(customAgentNote(agent())).toBe('my-agent --serve');
    expect(customAgentBlocked(agent())).toBeUndefined();
    expect(customAgentNote(agent({ confirmed: false }))).toBe('Not confirmed yet');
    expect(customAgentBlocked(agent({ confirmed: false }))).toContain('my-agent --serve');
  });
});

describe('when the agent stops being usable', () => {
  it('drops a choice naming an agent that is gone', () => {
    expect(reconcileAgentChoice(choice({ agentId: 'my-agent' }), [])).toEqual(choice({ agentId: null }));
  });

  it('drops one whose command was edited and not confirmed again', () => {
    expect(reconcileAgentChoice(choice({ agentId: 'my-agent' }), [agent({ confirmed: false })])).toMatchObject({
      agentId: null,
    });
  });

  it('leaves a live one, and anything that names no agent, alone', () => {
    const chosen = choice({ agentId: 'my-agent' });
    expect(reconcileAgentChoice(chosen, [agent()])).toBe(chosen);
    const plain = choice();
    expect(reconcileAgentChoice(plain, [])).toBe(plain);
    expect(chosenCustomAgent(chosen, [agent()])?.label).toBe('My agent');
    expect(chosenCustomAgent(plain, [agent()])).toBeNull();
  });
});

describe('the fields in Settings', () => {
  it('asks for a name and a program before it will save', () => {
    expect(agentDraftProblem({ id: null, label: '', command: 'x', args: [] })).toContain('name');
    expect(agentDraftProblem({ id: null, label: 'Mine', command: '  ', args: [] })).toContain('program');
    expect(agentDraftProblem({ id: null, label: 'Mine', command: 'my-agent', args: [] })).toBeNull();
  });

  it('refuses a whole command line pasted into the command field', () => {
    // Splitting it here would mean implementing quoting rules, and a wrong
    // split spawns a command nobody typed. The fields exist to be used.
    expect(agentDraftProblem({ id: null, label: 'Mine', command: 'node agent.js', args: [] })).toContain('argument');
    // ...but a real path with a space in it is a normal thing to own.
    expect(agentDraftProblem({ id: null, label: 'Mine', command: '/Apps/My Agent/bin/run', args: [] })).toBeNull();
  });

  it('sends a new agent without an id, and an edit with one, blank fields dropped', () => {
    expect(agentSavePatch({ id: null, label: ' Mine ', command: ' my-agent ', args: ['--serve', '  '] })).toEqual({
      label: 'Mine',
      command: 'my-agent',
      args: ['--serve'],
    });
    expect(agentSavePatch({ id: 'my-agent', label: 'Mine', command: 'my-agent', args: [] })).toMatchObject({
      id: 'my-agent',
    });
  });

  it('says what confirming means without pretending Hearth can contain it', () => {
    const body = agentConfirmBody(agent());
    expect(body).toContain('my-agent --serve');
    expect(body).toContain('cannot stop it');
  });
});
