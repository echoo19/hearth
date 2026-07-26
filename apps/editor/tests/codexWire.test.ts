/**
 * The codex app-server wire adapter.
 *
 * These are the tests that pin Hearth to a protocol it does not own. The
 * shapes below were taken from `codex app-server generate-ts` on codex-cli
 * 0.144.5 — the binary's own generated bindings — rather than transcribed from
 * prose, so a mapping that passes here matches what the real server emits.
 *
 * The other half of what is being asserted is the DEGRADATION contract: the
 * protocol is explicitly still moving, so an unknown method, a missing field
 * or an unfamiliar item kind must yield nothing rather than throw. A
 * conversation must never die because codex learned a new trick.
 */
import { describe, expect, it } from 'vitest';
import {
  CODEX_TESTED_VERSION,
  codexApprovalReply,
  codexChangeKind,
  codexTurnOverrides,
  codexFileChanges,
  codexItemKind,
  codexItemTitle,
  codexStatus,
  decodeRpcChunk,
  encodeRpc,
  isApprovalRequest,
  mapCodexAccount,
  mapCodexApproval,
  mapCodexLoginStart,
  mapCodexModels,
  mapCodexNotification,
} from '../server/chatDrivers/codexWire';

describe('JSON-RPC framing', () => {
  it('encodes one message per line with the protocol version', () => {
    expect(encodeRpc({ id: 1, method: 'initialize', params: {} })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    );
  });

  it('decodes whole lines and keeps a partial one for the next chunk', () => {
    const first = decodeRpcChunk('{"method":"a"}\n{"method":"b"}\n{"meth');
    expect(first.messages.map((m) => m.method)).toEqual(['a', 'b']);
    expect(first.rest).toBe('{"meth');
    const second = decodeRpcChunk(first.rest + 'od":"c"}\n');
    expect(second.messages.map((m) => m.method)).toEqual(['c']);
    expect(second.rest).toBe('');
  });

  it('skips non-JSON noise rather than treating it as a protocol error', () => {
    const { messages } = decodeRpcChunk('starting up...\n{"method":"a"}\n\n');
    expect(messages.map((m) => m.method)).toEqual(['a']);
  });
});

describe('item mapping', () => {
  it('maps codex item types onto the provider-agnostic kinds', () => {
    expect(codexItemKind('commandExecution')).toBe('command');
    expect(codexItemKind('fileChange')).toBe('file-change');
    expect(codexItemKind('mcpToolCall')).toBe('mcp');
    expect(codexItemKind('webSearch')).toBe('web-search');
    expect(codexItemKind('somethingNewInV3')).toBeNull();
  });

  it('maps per-item status, treating an unknown status as success', () => {
    expect(codexStatus('failed')).toBe('error');
    expect(codexStatus('declined')).toBe('declined');
    expect(codexStatus('completed')).toBe('ok');
    expect(codexStatus(undefined)).toBe('ok');
  });

  it("reads codex's tagged PatchChangeKind", () => {
    expect(codexChangeKind({ type: 'add' })).toBe('create');
    expect(codexChangeKind({ type: 'delete' })).toBe('delete');
    expect(codexChangeKind({ type: 'update', move_path: null })).toBe('edit');
  });

  it('titles an item as the thing a person would recognise', () => {
    expect(codexItemTitle({ type: 'commandExecution', command: 'npm test' })).toBe('npm test');
    expect(codexItemTitle({ type: 'mcpToolCall', server: 'hearth', tool: 'scene.list' })).toBe('hearth · scene.list');
    expect(
      codexItemTitle({ type: 'fileChange', changes: [{ path: 'a.js', kind: { type: 'add' }, diff: '' }] }),
    ).toBe('a.js');
  });

  it('drops change entries with no path instead of rendering a blank row', () => {
    expect(codexFileChanges({ changes: [{ kind: { type: 'add' } }, { path: 'b.js', kind: { type: 'add' }, diff: '+1' }] })).toEqual(
      [{ path: 'b.js', kind: 'create', diff: '+1' }],
    );
  });
});

describe('mapCodexNotification', () => {
  it('streams agent prose', () => {
    expect(mapCodexNotification('item/agentMessage/delta', { itemId: 'i1', delta: 'Hello' })).toEqual([
      { type: 'message-delta', text: 'Hello' },
    ]);
  });

  it('streams reasoning from both of the shapes codex uses', () => {
    expect(mapCodexNotification('item/reasoning/summaryTextDelta', { delta: 'Think' })).toEqual([
      { type: 'reasoning-delta', text: 'Think' },
    ]);
    expect(mapCodexNotification('item/reasoning/textDelta', { delta: 'ing' })).toEqual([
      { type: 'reasoning-delta', text: 'ing' },
    ]);
  });

  it('opens a command row on item/started and streams its output', () => {
    expect(
      mapCodexNotification('item/started', {
        item: { type: 'commandExecution', id: 'i1', command: 'npm test', cwd: '/w' },
      }),
    ).toEqual([{ type: 'tool-begin', toolId: 'i1', kind: 'command', title: 'npm test', detail: '/w' }]);
    expect(mapCodexNotification('item/commandExecution/outputDelta', { itemId: 'i1', delta: 'PASS\n' })).toEqual([
      { type: 'tool-output-delta', toolId: 'i1', chunk: 'PASS\n' },
    ]);
  });

  it('settles a command with its exit code', () => {
    expect(
      mapCodexNotification('item/completed', {
        item: { type: 'commandExecution', id: 'i1', status: 'failed', exitCode: 1, aggregatedOutput: 'boom' },
      }),
    ).toEqual([{ type: 'tool-end', toolId: 'i1', status: 'error', exitCode: 1, summary: 'boom' }]);
  });

  it('announces a file change with its patch, then settles it', () => {
    const item = {
      type: 'fileChange',
      id: 'i2',
      status: 'completed',
      changes: [{ path: 'src/game.js', kind: { type: 'update', move_path: null }, diff: '@@\n-a\n+b' }],
    };
    expect(mapCodexNotification('item/started', { item })).toEqual([
      { type: 'tool-begin', toolId: 'i2', kind: 'file-change', title: 'src/game.js', detail: undefined },
      { type: 'file-change', toolId: 'i2', files: [{ path: 'src/game.js', kind: 'edit', diff: '@@\n-a\n+b' }] },
    ]);
    const completed = mapCodexNotification('item/completed', { item });
    expect(completed[0]).toEqual({
      type: 'file-change',
      toolId: 'i2',
      files: [{ path: 'src/game.js', kind: 'edit', diff: '@@\n-a\n+b' }],
    });
    expect(completed[1]).toMatchObject({ type: 'tool-end', toolId: 'i2', status: 'ok' });
  });

  it('maps a subagent activity onto subagent events', () => {
    expect(
      mapCodexNotification('item/started', {
        item: { type: 'subAgentActivity', id: 's1', kind: 'started', agentThreadId: 't', agentPath: 'reviewer' },
      }),
    ).toEqual([{ type: 'subagent-start', agentId: 's1', role: 'reviewer', title: 'reviewer' }]);
    expect(
      mapCodexNotification('item/completed', {
        item: { type: 'subAgentActivity', id: 's1', kind: 'started', agentThreadId: 't', agentPath: 'reviewer' },
      }),
    ).toEqual([{ type: 'subagent-end', agentId: 's1', status: 'ok' }]);
  });

  it('ends the turn on turn/completed', () => {
    expect(mapCodexNotification('turn/completed', { threadId: 't', turn: { id: 'x' } })).toEqual([
      { type: 'turn-complete' },
    ]);
  });

  it('surfaces an error, but stays quiet while codex is retrying by itself', () => {
    expect(
      mapCodexNotification('error', { error: { message: 'rate limited' }, willRetry: false, threadId: 't', turnId: 'u' }),
    ).toEqual([{ type: 'error', message: 'rate limited' }]);
    expect(
      mapCodexNotification('error', { error: { message: 'blip' }, willRetry: true, threadId: 't', turnId: 'u' }),
    ).toEqual([]);
  });

  it('does not double-render an agent message that was already streamed', () => {
    // agentMessage arrives as deltas AND as a completed item carrying the full
    // text; emitting both would print every answer twice.
    expect(mapCodexNotification('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Hello' } })).toEqual(
      [],
    );
  });

  it('ignores a method it has never heard of', () => {
    expect(mapCodexNotification('thread/somethingFromTheFuture', { anything: true })).toEqual([]);
    expect(mapCodexNotification('item/agentMessage/delta', null)).toEqual([]);
    expect(mapCodexNotification('item/started', { item: { type: 'imageGeneration', id: 'z' } })).toEqual([]);
  });
});

describe('approvals', () => {
  it('recognises both the v2 and the legacy approval methods', () => {
    expect(isApprovalRequest('item/commandExecution/requestApproval')).toBe(true);
    expect(isApprovalRequest('item/fileChange/requestApproval')).toBe(true);
    expect(isApprovalRequest('execCommandApproval')).toBe(true);
    expect(isApprovalRequest('applyPatchApproval')).toBe(true);
    expect(isApprovalRequest('turn/completed')).toBe(false);
  });

  it('describes a command approval, preferring the reason codex gave', () => {
    expect(
      mapCodexApproval('item/commandExecution/requestApproval', {
        threadId: 't',
        turnId: 'u',
        itemId: 'i1',
        startedAtMs: 0,
        reason: 'Needs network access',
      }),
    ).toEqual({ kind: 'command', title: 'Needs network access', detail: 'i1' });
  });

  it('joins a legacy argv command into something readable', () => {
    expect(mapCodexApproval('execCommandApproval', { command: ['npm', 'test'], cwd: '/w' })).toEqual({
      kind: 'command',
      title: 'Run this command?',
      detail: 'npm test',
    });
  });

  it('lists the paths a patch approval covers', () => {
    expect(
      mapCodexApproval('applyPatchApproval', { fileChanges: { 'a.js': {}, 'b.js': {} } }),
    ).toEqual({ kind: 'file-change', title: 'Apply these changes?', detail: 'a.js\nb.js' });
  });

  it('answers each method in ITS OWN decision vocabulary', () => {
    // Getting this wrong leaves the turn wedged: v2 wants accept/decline,
    // the pre-v2 methods want a ReviewDecision.
    expect(codexApprovalReply('item/commandExecution/requestApproval', 'allow')).toEqual({ decision: 'accept' });
    expect(codexApprovalReply('item/fileChange/requestApproval', 'deny')).toEqual({ decision: 'decline' });
    expect(codexApprovalReply('execCommandApproval', 'allow')).toEqual({ decision: 'approved' });
    expect(codexApprovalReply('applyPatchApproval', 'deny')).toEqual({ decision: 'denied' });
  });

  it('returns null for a method that is not an approval', () => {
    expect(mapCodexApproval('turn/completed', {})).toBeNull();
  });
});

describe('account', () => {
  it('reads a ChatGPT sign-in', () => {
    expect(mapCodexAccount({ account: { type: 'chatgpt', email: 'a@b.com', planType: 'plus' } })).toEqual({
      loggedIn: true,
      authMode: 'chatgpt',
      email: 'a@b.com',
      planType: 'plus',
    });
  });

  it('reads an API-key sign-in without inventing an identity', () => {
    expect(mapCodexAccount({ account: { type: 'apiKey' } })).toEqual({
      loggedIn: true,
      authMode: 'apikey',
      email: null,
      planType: null,
    });
  });

  it('treats no account as signed out', () => {
    expect(mapCodexAccount({ account: null, requiresOpenaiAuth: true }).loggedIn).toBe(false);
    expect(mapCodexAccount(null).loggedIn).toBe(false);
  });

  it('treats a credential source it has no name for as still signed in', () => {
    const account = mapCodexAccount({ account: { type: 'amazonBedrock', credentialSource: 'env' } });
    expect(account.loggedIn).toBe(true);
    expect(account.authMode).toBeNull();
  });

  it('reads the browser URL out of a login start', () => {
    expect(mapCodexLoginStart({ type: 'chatgpt', loginId: 'l1', authUrl: 'https://auth.openai.com/x' })).toEqual({
      authUrl: 'https://auth.openai.com/x',
      loginId: 'l1',
    });
    expect(mapCodexLoginStart({ type: 'apiKey' })).toEqual({ authUrl: null, loginId: null });
  });
});

describe('per-turn overrides', () => {
  it('omits both keys when the user expressed no choice', () => {
    // An explicit null would be a deliberate reset of codex's own config,
    // which is not the same thing as "the user didn't pick".
    expect(codexTurnOverrides(null)).toEqual({});
    expect(codexTurnOverrides(undefined)).toEqual({});
    expect(codexTurnOverrides({ provider: 'openai' })).toEqual({});
  });

  it('carries the model and effort that were chosen', () => {
    expect(codexTurnOverrides({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' })).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(codexTurnOverrides({ effort: 'low' })).toEqual({ effort: 'low' });
  });

  it('never forwards a model meant for the other vendor', () => {
    expect(codexTurnOverrides({ provider: 'anthropic', model: 'claude-opus-5', effort: 'high' })).toEqual({});
  });
});

describe('mapCodexModels', () => {
  // Shape taken from a real `model/list` response on CODEX_TESTED_VERSION.
  const response = {
    data: [
      { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false, isDefault: true },
      { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', hidden: false, isDefault: false },
      { id: 'internal-preview', model: 'internal-preview', displayName: 'Hidden', hidden: true, isDefault: false },
    ],
    nextCursor: null,
  };

  it('keeps the visible models, in order, and marks the account default', () => {
    expect(mapCodexModels(response)).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', note: 'Default' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    ]);
  });

  it('falls back to the id when a row has no display name', () => {
    expect(mapCodexModels({ data: [{ id: 'gpt-x' }] })).toEqual([{ id: 'gpt-x', label: 'gpt-x' }]);
  });

  it('yields nothing rather than throwing on a shape it does not know', () => {
    expect(mapCodexModels(undefined)).toEqual([]);
    expect(mapCodexModels({})).toEqual([]);
    expect(mapCodexModels({ data: 'nope' })).toEqual([]);
    expect(mapCodexModels({ data: [null, 7, {}, { displayName: 'no id' }] })).toEqual([]);
  });
});

describe('version pin', () => {
  it('records the codex build this adapter was verified against', () => {
    // Bump deliberately, after re-checking the mappings above against the new
    // build's `codex app-server generate-ts` output. As of 0.144.5 that output
    // also pins the two turn fields the model selector depends on —
    // `TurnStartParams.model` and `TurnStartParams.effort` — and the
    // `model/list` request behind the OpenAI model list.
    expect(CODEX_TESTED_VERSION).toBe('0.144.5');
  });
});
