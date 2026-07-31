/**
 * Everything the agent does has to reach the transcript.
 *
 * The app replaces a terminal, so anything the terminal would have shown and
 * the app doesn't is a regression in what the user can see — not a cosmetic
 * gap. These tests pin the two halves of that: each backend's actions map onto
 * the shared vocabulary, and an action neither backend had when this was
 * written still shows up as something rather than nothing.
 *
 * The codex item types are the full `ThreadItem` union from codex-cli's own
 * generated schema (CODEX_TESTED_VERSION), so "did we cover all of them" is a
 * question this file can actually answer.
 */
import { describe, expect, it } from 'vitest';
import { mapCodexNotification, codexItemKind, mapCodexQuestionRequest, isQuestionRequest } from '../server/chatDrivers/codexWire';
import { mapSdkMessage, sdkTodoText, type ChatEvent } from '../server/chat';
import { applyChatEvent, makeAgentMessage } from '../src/store';
import { planLineState, imageSrcFor } from '../src/components/chat/PlanCard';

/**
 * Every ThreadItem variant codex 0.144.5 can send, each with the fields its
 * schema says it carries — an item stripped of its payload legitimately has
 * nothing to show, so a coverage check has to hand over the real shape.
 */
const CODEX_ITEMS: Record<string, Record<string, unknown>> = {
  userMessage: {},
  hookPrompt: { fragments: [] },
  agentMessage: { text: 'hello' },
  plan: { text: '[ ] one' },
  reasoning: { text: 'thinking' },
  commandExecution: { command: 'npm test', status: 'completed' },
  fileChange: { changes: [{ path: 'a.ts', kind: { type: 'update' } }], status: 'completed' },
  mcpToolCall: { server: 's', tool: 't', status: 'completed' },
  dynamicToolCall: { tool: 't', status: 'completed' },
  collabAgentToolCall: { tool: 'spawn', prompt: 'do it', status: 'completed' },
  subAgentActivity: { kind: 'started', agentPath: 'artist' },
  webSearch: { query: 'q' },
  imageView: { path: '/p/a.png' },
  sleep: { durationMs: 1500 },
  imageGeneration: { savedPath: '/p/a.png', status: 'completed' },
  enteredReviewMode: {},
  exitedReviewMode: {},
  contextCompaction: {},
};

const started = (item: Record<string, unknown>): ChatEvent[] => mapCodexNotification('item/started', { item });
const completed = (item: Record<string, unknown>): ChatEvent[] => mapCodexNotification('item/completed', { item });

describe('codex: every item type lands somewhere', () => {
  it('leaves no item type producing nothing at both ends', () => {
    const silent: string[] = [];
    for (const [type, fields] of Object.entries(CODEX_ITEMS)) {
      const id = 'i1';
      const events = [
        ...started({ id, type, ...fields }),
        ...completed({ id, type, ...fields, kind: 'completed' }),
      ];
      // agentMessage/reasoning/userMessage are streamed through their own delta
      // notifications, so their items are silent ON PURPOSE.
      if (events.length === 0 && !['agentMessage', 'reasoning', 'userMessage'].includes(type)) silent.push(type);
    }
    expect(silent).toEqual([]);
  });

  it('shows an item type it has never heard of rather than dropping it', () => {
    expect(codexItemKind('quantumEntanglement')).toBe('other');
    const events = started({ id: 'i9', type: 'quantumEntanglement' });
    expect(events[0]).toMatchObject({ type: 'tool-begin', toolId: 'i9', title: 'quantumEntanglement' });
  });
});

describe('codex: the actions that were invisible', () => {
  it('turns a plan item into the plan card', () => {
    expect(completed({ id: 'p1', type: 'plan', text: '[x] sketch\n[ ] build' })).toEqual([
      { type: 'plan-update', planId: 'p1', text: '[x] sketch\n[ ] build' },
    ]);
  });

  it('takes a plan update from the turn-level notification too', () => {
    expect(mapCodexNotification('turn/plan/updated', { itemId: 'p2', text: '[ ] one' })).toEqual([
      { type: 'plan-update', planId: 'p2', text: '[ ] one' },
    ]);
  });

  it('shows a generated image, with the prompt that made it', () => {
    const events = completed({
      id: 'g1',
      type: 'imageGeneration',
      status: 'completed',
      savedPath: '/p/game/sprite.png',
      revisedPrompt: 'a red knight',
    });
    expect(events[0]).toEqual({ type: 'image', toolId: 'g1', path: '/p/game/sprite.png', caption: 'a red knight' });
    expect(events[1]).toMatchObject({ type: 'tool-end', status: 'ok' });
  });

  it('shows an image the agent looked at', () => {
    expect(started({ id: 'v1', type: 'imageView', path: '/p/game/level.png' })[0]).toMatchObject({
      type: 'image',
      path: '/p/game/level.png',
    });
  });

  it('says when the conversation was compacted, so a forgetful agent makes sense', () => {
    expect(completed({ id: 'c1', type: 'contextCompaction' })[0]).toMatchObject({ type: 'notice' });
    expect(mapCodexNotification('thread/compacted', {})[0]).toMatchObject({ type: 'notice' });
  });

  it('renders a collab agent as the subagent it is', () => {
    const open = started({ id: 'a1', type: 'collabAgentToolCall', tool: 'spawn', prompt: 'draw the tiles' });
    expect(open[0]).toMatchObject({ type: 'subagent-start', agentId: 'a1', title: 'draw the tiles' });
    const close = completed({ id: 'a1', type: 'collabAgentToolCall', status: 'completed' });
    expect(close[0]).toMatchObject({ type: 'subagent-end', agentId: 'a1', status: 'ok' });
  });

  it('still opens and closes a subagent the ordinary way', () => {
    expect(started({ id: 's1', type: 'subAgentActivity', kind: 'started', agentPath: 'artist' })[0]).toMatchObject({
      type: 'subagent-start',
      agentId: 's1',
      role: 'artist',
    });
    expect(completed({ id: 's1', type: 'subAgentActivity', kind: 'completed' })[0]).toMatchObject({
      type: 'subagent-end',
      status: 'ok',
    });
  });

  it('keeps the ordinary tool rows exactly as they were', () => {
    expect(started({ id: 'x', type: 'commandExecution', command: 'npm test' })[0]).toMatchObject({
      kind: 'command',
      title: 'npm test',
    });
    expect(started({ id: 'x', type: 'webSearch', query: 'godot input' })[0]).toMatchObject({ kind: 'web-search' });
    expect(started({ id: 'x', type: 'mcpToolCall', server: 'hearth', tool: 'sweep' })[0]).toMatchObject({
      kind: 'mcp',
      title: 'hearth · sweep',
    });
  });
});

describe('codex: when the agent asks the user something', () => {
  it('recognises the ask, so it is not answered as if it were an action', () => {
    expect(isQuestionRequest('item/tool/requestUserInput')).toBe(true);
    expect(isQuestionRequest('mcpServer/elicitation/request')).toBe(true);
    expect(isQuestionRequest('item/commandExecution/requestApproval')).toBe(false);
  });

  it('says what was asked, and what the choices were', () => {
    const request = mapCodexQuestionRequest('item/tool/requestUserInput', 'input-1', {
      questions: [
        {
          id: 'art',
          header: 'Art',
          question: 'Pixel art or vector?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Pixel', description: '' },
            { label: 'Vector', description: '' },
          ],
        },
      ],
      autoResolutionMs: null,
    });
    expect(request).toMatchObject({
      inputId: 'input-1',
      questions: [
        {
          id: 'art',
          label: 'Pixel art or vector?',
          options: [{ label: 'Pixel' }, { label: 'Vector' }],
        },
      ],
    });
  });

  it('falls back to an elicitation’s plain message', () => {
    expect(
      mapCodexQuestionRequest('mcpServer/elicitation/request', 'input-2', {
        mode: 'url',
        serverName: 'local',
        message: 'Which port should I use?',
        url: 'https://example.test',
        elicitationId: 'e1',
      }),
    ).toMatchObject({ description: 'Which port should I use?' });
  });

  it('says nothing when there is nothing to say', () => {
    expect(mapCodexQuestionRequest('item/tool/requestUserInput', 'i', { questions: [] })).toBeNull();
    expect(mapCodexQuestionRequest('item/tool/requestUserInput', 'i', null)).toBeNull();
  });
});

describe('the Agent SDK', () => {
  const assistant = (block: unknown): ChatEvent[] =>
    mapSdkMessage({ type: 'assistant', message: { content: [block] } });

  it('turns the todo list into the same plan card codex gets', () => {
    const events = assistant({
      type: 'tool_use',
      id: 't1',
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'sketch the level', status: 'completed' },
          { content: 'add the enemy', status: 'in_progress' },
          { content: 'playtest', status: 'pending' },
        ],
      },
    });
    expect(events).toEqual([
      { type: 'plan-update', planId: 'todo', text: '[x] sketch the level\n[~] add the enemy\n[ ] playtest' },
    ]);
  });

  it('ignores an empty todo list rather than showing an empty plan', () => {
    expect(sdkTodoText({ todos: [] })).toBeNull();
    expect(sdkTodoText(null)).toBeNull();
  });

  it('still opens a subagent for a Task call', () => {
    const events = assistant({
      type: 'tool_use',
      id: 't2',
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'find the collision code' },
    });
    expect(events[0]).toMatchObject({ type: 'subagent-start', role: 'Explore', title: 'find the collision code' });
  });

  it('still names a web search and an MCP call for what they are', () => {
    expect(assistant({ type: 'tool_use', id: 't3', name: 'WebSearch', input: {} })[0]).toMatchObject({
      kind: 'web-search',
    });
    expect(assistant({ type: 'tool_use', id: 't4', name: 'mcp__hearth__sweep', input: {} })[0]).toMatchObject({
      kind: 'mcp',
    });
  });
});

describe('the transcript', () => {
  const turn = () => [makeAgentMessage()];

  it('replaces a plan in place instead of stacking every draft of it', () => {
    let messages = turn();
    messages = applyChatEvent(messages, { type: 'plan-update', planId: 'p', text: '[ ] one' });
    messages = applyChatEvent(messages, { type: 'plan-update', planId: 'p', text: '[x] one\n[ ] two' });
    const plans = messages[0].parts.filter((part) => part.kind === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ text: '[x] one\n[ ] two' });
  });

  it('keeps two different plans apart', () => {
    let messages = turn();
    messages = applyChatEvent(messages, { type: 'plan-update', planId: 'a', text: 'x' });
    messages = applyChatEvent(messages, { type: 'plan-update', planId: 'b', text: 'y' });
    expect(messages[0].parts.filter((part) => part.kind === 'plan')).toHaveLength(2);
  });

  it('keeps an image and a notice in the order they happened', () => {
    let messages = turn();
    messages = applyChatEvent(messages, { type: 'message-delta', text: 'making a sprite' });
    messages = applyChatEvent(messages, { type: 'image', toolId: 'g', path: '/p/a.png', caption: 'knight' });
    messages = applyChatEvent(messages, { type: 'notice', text: 'Earlier turns were summarised.' });
    expect(messages[0].parts.map((part) => part.kind)).toEqual(['text', 'image', 'notice']);
  });
});

describe('rendering a plan line', () => {
  it('reads the three states', () => {
    expect(planLineState('[x] done it')).toEqual({ state: 'done', text: 'done it' });
    expect(planLineState('[~] doing it')).toEqual({ state: 'active', text: 'doing it' });
    expect(planLineState('[ ] later')).toEqual({ state: 'todo', text: 'later' });
  });

  it('takes a plain bullet as something still to do', () => {
    expect(planLineState('- write the level')).toEqual({ state: 'todo', text: 'write the level' });
  });
});

describe('showing an image the agent named', () => {
  it('reads one inside the open folder', () => {
    expect(imageSrcFor('/Users/me/game/art/hero.png', '/Users/me/game')).toContain(
      encodeURIComponent('art/hero.png'),
    );
    expect(imageSrcFor('art/hero.png', '/Users/me/game')).toContain(encodeURIComponent('art/hero.png'));
  });

  it('refuses to guess at one outside it', () => {
    expect(imageSrcFor('/etc/passwd.png', '/Users/me/game')).toBeNull();
    expect(imageSrcFor('art/hero.png', null)).toBeNull();
  });
});
