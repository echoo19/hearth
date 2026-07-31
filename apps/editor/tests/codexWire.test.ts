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
  classifyCodexServerRequest,
  codexApprovalChoiceReply,
  codexApprovalChoiceResolution,
  codexApprovalReply,
  codexChangeKind,
  codexCurrentTimeReply,
  codexElicitationReply,
  codexUserInputReply,
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
  mapCodexApprovalRequest,
  mapCodexQuestionRequest,
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
    // An item type from a codex we have never seen still gets a row: silence
    // would mean the app shows less than the terminal it replaced.
    expect(codexItemKind('somethingNewInV3')).toBe('other');
    // The ones handled elsewhere (streamed prose, the plan card, images) are
    // the only ones that are deliberately not tool rows.
    expect(codexItemKind('agentMessage')).toBeNull();
    expect(codexItemKind('plan')).toBeNull();
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

  it('closes an agent message without re-rendering the text it already streamed', () => {
    // agentMessage arrives as deltas AND as a completed item carrying the full
    // text. Emitting the text again would print every answer twice, so it is
    // dropped. The BOUNDARY is kept, because a turn writes several messages
    // and nothing in the delta stream says where one stops: without it the
    // next message is appended onto this one's last character, which is how
    // "a visual game/UI task.Some of what we're working on" reached the
    // transcript with the sentence break eaten.
    expect(mapCodexNotification('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Hello' } })).toEqual(
      [{ type: 'message-end' }],
    );
  });

  it('ignores a method it has never heard of', () => {
    expect(mapCodexNotification('thread/somethingFromTheFuture', { anything: true })).toEqual([]);
    expect(mapCodexNotification('item/agentMessage/delta', null)).toEqual([]);
  });

  it('opens a row for an image the agent is generating, rather than nothing', () => {
    expect(mapCodexNotification('item/started', { item: { type: 'imageGeneration', id: 'z' } })).toEqual([
      { type: 'tool-begin', toolId: 'z', kind: 'other', title: 'Generating an image' },
    ]);
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

  it('offers exactly the decisions the server supplied without exposing amendments as browser-authored values', () => {
    const execpolicy = ['npm', 'test'];
    const network = { host: 'registry.npmjs.org', action: 'allow' };
    const mapped = mapCodexApprovalRequest('item/commandExecution/requestApproval', {
      command: 'npm test',
      availableDecisions: [
        'accept',
        'acceptForSession',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: execpolicy } },
        { applyNetworkPolicyAmendment: { network_policy_amendment: network } },
        'decline',
        'cancel',
      ],
    });
    const approval = mapped?.approval;
    const decisions = approval?.decisions ?? [];

    expect(decisions).toEqual([
      { id: 'decision-0', label: 'Allow once', tone: 'allow' },
      { id: 'decision-1', label: 'Allow for session', tone: 'allow' },
      { id: 'decision-2', label: 'Allow and remember this command', tone: 'allow' },
      { id: 'decision-3', label: 'Allow and remember this network access', tone: 'allow' },
      { id: 'decision-4', label: 'Deny', tone: 'deny' },
      { id: 'decision-5', label: 'Cancel', tone: 'neutral' },
    ]);
    expect(codexApprovalChoiceReply(mapped!.decisionsById, 'decision-2')).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: execpolicy } },
    });
    expect(codexApprovalChoiceReply(mapped!.decisionsById, 'decision-3')).toEqual({
      decision: { applyNetworkPolicyAmendment: { network_policy_amendment: network } },
    });
    expect(codexApprovalChoiceResolution(mapped!.decisionsById, 'decision-4')).toBe('deny');
    expect(codexApprovalChoiceResolution(mapped!.decisionsById, 'decision-5')).toBe('deny');
    expect(JSON.parse(JSON.stringify(approval))).not.toHaveProperty('wireDecision');
    expect(JSON.stringify(approval)).not.toContain('execpolicy_amendment');
    expect(JSON.stringify(approval)).not.toContain('network_policy_amendment');
  });

  it('drops malformed server decisions instead of creating a choice Hearth cannot safely answer', () => {
    const approval = mapCodexApproval('item/commandExecution/requestApproval', {
      availableDecisions: [
        'accept',
        'approveForever',
        { acceptWithExecpolicyAmendment: {} },
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: { command: ['wrong'] } } },
        null,
      ],
    });
    expect((approval?.decisions ?? []).map((entry) => entry.label)).toEqual(['Allow once']);
  });
});

describe('interactive server requests', () => {
  it('maps requestUserInput into provider-neutral fields and keeps secret status explicit', () => {
    expect(
      mapCodexQuestionRequest('item/tool/requestUserInput', 'input-1', {
        threadId: 't',
        turnId: 'u',
        itemId: 'i',
        autoResolutionMs: 60_000,
        questions: [
          {
            id: 'style',
            header: 'Art',
            question: 'Pixel art or vector?',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'Pixel', description: 'Crisp sprites' },
              { label: 'Vector', description: 'Resolution independent' },
            ],
          },
          {
            id: 'token',
            header: 'Token',
            question: 'Paste the token',
            isOther: false,
            isSecret: true,
            options: null,
          },
        ],
      }),
    ).toEqual({
      inputId: 'input-1',
      title: 'Art',
      timeoutMs: 60_000,
      questions: [
        {
          id: 'style',
          label: 'Pixel art or vector?',
          type: 'choice',
          required: true,
          secret: false,
          allowOther: true,
          options: [
            { value: 'Pixel', label: 'Pixel', description: 'Crisp sprites' },
            { value: 'Vector', label: 'Vector', description: 'Resolution independent' },
          ],
        },
        {
          id: 'token',
          label: 'Paste the token',
          type: 'text',
          required: true,
          secret: true,
          allowOther: false,
        },
      ],
      allowCancel: true,
    });
    expect(
      mapCodexQuestionRequest('mcpServer/elicitation/request', 'input-unsafe', {
        serverName: 'malicious',
        mode: 'url',
        message: 'Open this',
        url: 'file:///etc/passwd',
        elicitationId: 'e2',
      }),
    ).toBeNull();
  });

  it('builds the exact requestUserInput response shape from question ids', () => {
    expect(codexUserInputReply({ style: ['Pixel'], notes: ['Use warm colours', 'Large tiles'] })).toEqual({
      answers: {
        style: { answers: ['Pixel'] },
        notes: { answers: ['Use warm colours', 'Large tiles'] },
      },
    });
  });

  it('maps MCP form schemas into the same field vocabulary', () => {
    expect(
      mapCodexQuestionRequest('mcpServer/elicitation/request', 'input-2', {
        threadId: 't',
        turnId: 'u',
        serverName: 'deploy',
        mode: 'form',
        message: 'Configure deployment',
        _meta: null,
        requestedSchema: {
          type: 'object',
          required: ['region'],
          properties: {
            region: {
              type: 'string',
              title: 'Region',
              description: 'Where to deploy',
              enum: ['us-west', 'eu-west'],
              enumNames: ['US West', 'EU West'],
            },
            replicas: { type: 'integer', title: 'Replicas', minimum: 1, maximum: 5, default: 2 },
            public: { type: 'boolean', title: 'Public', default: false },
          },
        },
      }),
    ).toEqual({
      inputId: 'input-2',
      title: 'deploy',
      description: 'Configure deployment',
      questions: [
        {
          id: 'region',
          label: 'Region',
          type: 'choice',
          required: true,
          secret: false,
          options: [
            { value: 'us-west', label: 'US West', description: 'Where to deploy' },
            { value: 'eu-west', label: 'EU West', description: 'Where to deploy' },
          ],
        },
        {
          id: 'replicas',
          label: 'Replicas',
          type: 'number',
          required: false,
          secret: false,
          min: 1,
          max: 5,
        },
        {
          id: 'public',
          label: 'Public',
          type: 'boolean',
          required: false,
          secret: false,
        },
      ],
      allowCancel: true,
    });
  });

  it('maps OpenAI extended forms and URL elicitations without making the server URL an editable answer', () => {
    expect(
      mapCodexQuestionRequest('mcpServer/elicitation/request', 'input-3', {
        serverName: 'design',
        mode: 'openai/form',
        message: 'Choose a colour',
        requestedSchema: {
          type: 'object',
          properties: { site: { type: 'string', format: 'uri', title: 'Website' } },
        },
        _meta: null,
      }),
    ).toEqual({
      inputId: 'input-3',
      title: 'design',
      description: 'Choose a colour',
      questions: [{ id: 'site', label: 'Website', type: 'url', required: false, secret: false }],
      allowCancel: true,
    });
    expect(
      mapCodexQuestionRequest('mcpServer/elicitation/request', 'input-4', {
        serverName: 'github',
        mode: 'url',
        message: 'Authorize GitHub',
        url: 'https://example.test/auth',
        elicitationId: 'e1',
        _meta: null,
      }),
    ).toEqual({
      inputId: 'input-4',
      title: 'github',
      description: 'Authorize GitHub',
      questions: [],
      externalAction: {
        type: 'open-url',
        url: 'https://example.test/auth',
        elicitationId: 'e1',
      },
      allowCancel: true,
    });
  });

  it('rejects an entire MCP form when any property cannot be represented safely', () => {
    expect(
      mapCodexQuestionRequest('mcpServer/elicitation/request', 'input-5', {
        serverName: 'design',
        mode: 'openai/form',
        message: 'Configure',
        requestedSchema: {
          type: 'object',
          properties: {
            supported: { type: 'string' },
            unsupported: { type: 'color' },
          },
        },
      }),
    ).toBeNull();
    expect(
      mapCodexQuestionRequest('mcpServer/elicitation/request', 'input-6', {
        serverName: 'design',
        mode: 'form',
        message: 'Configure',
        requestedSchema: { type: 'object', properties: {} },
      }),
    ).toBeNull();
  });

  it('builds exact MCP accept, decline, and cancel response shapes', () => {
    expect(codexElicitationReply('accept', { region: 'us-west' })).toEqual({
      action: 'accept',
      content: { region: 'us-west' },
      _meta: null,
    });
    expect(codexElicitationReply('decline')).toEqual({ action: 'decline', content: null, _meta: null });
    expect(codexElicitationReply('cancel')).toEqual({ action: 'cancel', content: null, _meta: null });
  });

  it('classifies every server request before the driver decides how to answer it', () => {
    expect(classifyCodexServerRequest('item/commandExecution/requestApproval')).toBe('approval');
    expect(classifyCodexServerRequest('item/tool/requestUserInput')).toBe('question');
    expect(classifyCodexServerRequest('mcpServer/elicitation/request')).toBe('question');
    expect(classifyCodexServerRequest('currentTime/read')).toBe('current-time');
    expect(classifyCodexServerRequest('attestation/generate')).toBe('unsupported');
  });

  it('answers currentTime/read in whole Unix seconds', () => {
    expect(codexCurrentTimeReply(1_753_987_654_321)).toEqual({ currentTimeAt: 1_753_987_654 });
  });

  it('returns null for malformed or unrelated interactive requests', () => {
    expect(mapCodexQuestionRequest('turn/completed', 'i', {})).toBeNull();
    expect(mapCodexQuestionRequest('item/tool/requestUserInput', 'i', { questions: [] })).toBeNull();
    expect(mapCodexQuestionRequest('mcpServer/elicitation/request', 'i', { mode: 'form' })).toBeNull();
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
    // `isDefault` rather than a `note: 'Default'` string: the UI has to tell
    // the account's default model apart from the "let the provider decide"
    // row, and both were reading as the word "Default".
    expect(mapCodexModels(response)).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', isDefault: true },
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
