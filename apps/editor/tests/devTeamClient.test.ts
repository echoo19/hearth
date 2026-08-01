// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replayTranscript, useApp } from '../src/store';
import type { ChatMessage, DevTeamSnapshot } from '../src/types';
import type { WsFrame } from '../server/ws';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiCloseWorkspace: vi.fn(async () => {}),
  apiChatProviders: vi.fn(async () => null),
  apiDeleteChat: vi.fn(async () => ({ ok: true, chats: [] })),
}));

const SNAPSHOT: DevTeamSnapshot = {
  version: 1,
  runId: 'run-1',
  phase: 'building',
  plan: null,
  tasks: [{ taskId: 'task-1', engineerId: 'engineer-1', status: 'running' }],
  approvals: [],
  history: [],
  currentMilestone: 0,
  spec: '# Make a game',
  specVersion: 1,
  summary: null,
  wrap: null,
  error: null,
};

function stripMessageIds(messages: readonly ChatMessage[]): Omit<ChatMessage, 'id'>[] {
  return messages.map(({ id: _id, ...message }) => message);
}

function receive(frame: WsFrame): void {
  useApp.getState().receiveFrame(frame);
}

beforeEach(() => {
  useApp.setState({
    projectPath: '/work/game',
    activeChatId: 'team-chat',
    devTeam: null,
    devTeamLanes: {},
    devTeamByChat: {},
    messages: [],
    sendFrame: vi.fn(() => true),
    composing: false,
  } as never);
  receive({
    type: 'chat-opened',
    chat: {
      id: 'team-chat',
      title: 'Dev team',
      kind: 'devteam',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
    },
    records: [],
  });
});

describe('dev team frame folding', () => {
  it('replaces the authoritative snapshot without discarding engineer lanes', () => {
    receive({ type: 'devteam-state', chatId: 'team-chat', state: SNAPSHOT });
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'text-delta', text: 'Working' } });
    const next = { ...SNAPSHOT, phase: 'reviewing' as const, summary: 'Milestone ready' };
    receive({ type: 'devteam-state', chatId: 'team-chat', state: next });

    expect(useApp.getState().devTeam).toEqual(next);
    expect(useApp.getState().devTeamLanes['engineer-1']).toHaveLength(1);
  });

  it('starts fresh engineer lanes when the authoritative run changes', () => {
    receive({ type: 'devteam-state', chatId: 'team-chat', state: SNAPSHOT });
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'message-delta', text: 'Old run' } });
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'turn-complete' } });

    receive({
      type: 'devteam-state',
      chatId: 'team-chat',
      state: { ...SNAPSHOT, runId: 'run-2', phase: 'building' },
    });
    expect(useApp.getState().devTeamLanes).toEqual({});

    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'message-delta', text: 'New run' } });
    expect(useApp.getState().devTeamLanes['engineer-1'][0]).toMatchObject({
      streaming: true,
      parts: [{ kind: 'text', text: 'New run' }],
    });
  });

  it('seeds each engineer lane and folds normalized chat events into it', () => {
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'text-delta', text: 'Working' } });
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-2', event: { type: 'message-delta', text: 'Reviewing' } });

    expect(useApp.getState().devTeamLanes['engineer-1'][0]).toMatchObject({
      role: 'agent',
      streaming: true,
      parts: [{ kind: 'text', text: 'Working' }],
    });
    expect(useApp.getState().devTeamLanes['engineer-2'][0]).toMatchObject({
      role: 'agent',
      streaming: true,
      parts: [{ kind: 'text', text: 'Reviewing' }],
    });
  });

  it('keeps a lane live until a terminal event settles it', () => {
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'message-delta', text: 'Done soon' } });
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'message-end' } });
    expect(useApp.getState().devTeamLanes['engineer-1'][0].streaming).toBe(true);

    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'turn-complete' } });
    expect(useApp.getState().devTeamLanes['engineer-1'][0].streaming).toBe(false);
  });

  it('keeps inactive conversation status without leaking its stream into the open pane', () => {
    receive({ type: 'devteam-state', chatId: 'old-chat', state: SNAPSHOT });
    receive({ type: 'devteam-event', chatId: 'old-chat', engineerId: 'engineer-1', event: { type: 'message-delta', text: 'Late' } });
    expect(useApp.getState().devTeam).toBeNull();
    expect(useApp.getState().devTeamLanes).toEqual({});
    expect(useApp.getState().devTeamByChat['old-chat']).toEqual(SNAPSHOT);
  });

  it('reconstructs a finished engineer lane exactly like the live stream', () => {
    const frames: WsFrame[] = [
      { type: 'devteam-state', chatId: 'team-chat', state: SNAPSHOT },
      { type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'message-delta', text: 'Changed ' } },
      { type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'message-delta', text: 'three files.' } },
      { type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'turn-complete' } },
    ];
    frames.forEach(receive);
    const live = stripMessageIds(useApp.getState().devTeamLanes['engineer-1']);

    useApp.setState({ devTeam: null, devTeamLanes: {} });
    frames.forEach(receive);
    expect(stripMessageIds(useApp.getState().devTeamLanes['engineer-1'])).toEqual(live);
  });

  it('keeps orchestration records marked during lead transcript replay', () => {
    const messages = replayTranscript([
      { role: 'user', ts: 't1', text: 'Prepare the milestone review.', orchestration: true },
    ]);
    expect(messages[0]).toMatchObject({ role: 'user', orchestration: true });
  });

  it('drops a stale team cache entry when that id opens as a terminal', () => {
    useApp.setState({ devTeamByChat: { 'team-chat': SNAPSHOT } });

    receive({
      type: 'chat-opened',
      chat: {
        id: 'team-chat',
        title: 'Terminal',
        kind: 'terminal',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      },
      records: [],
    });

    expect(useApp.getState().devTeamByChat).toEqual({});
  });
});

describe('dev team actions', () => {
  it('sends run controls on the current conversation socket', () => {
    const sendFrame = useApp.getState().sendFrame as ReturnType<typeof vi.fn>;
    useApp.getState().approveDevTeamSpec();
    useApp.getState().pauseDevTeam();
    useApp.getState().resumeDevTeam();
    useApp.getState().stopDevTeam();
    expect(sendFrame.mock.calls.map(([frame]) => frame.type)).toEqual([
      'devteam-approve-spec',
      'devteam-pause',
      'devteam-resume',
      'devteam-stop',
    ]);
  });

  it('creates a new dev team without changing the kind of the conversation being left', () => {
    const sendFrame = useApp.getState().sendFrame as ReturnType<typeof vi.fn>;
    useApp.setState({
      chats: [{
        id: 'team-chat',
        title: 'Existing chat',
        kind: 'chat',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      }],
      devTeam: SNAPSHOT,
      devTeamLanes: { 'engineer-1': [] },
      messages: [{
        id: 'old-message',
        role: 'user',
        parts: [{ kind: 'text', text: 'Old transcript' }],
        streaming: false,
        attachments: [{ name: 'old.png', mimeType: 'image/png', url: 'data:image/png;base64,old' }],
      }],
      chatBusy: true,
      chatDriver: 'codex',
      slashCommands: [{ name: 'old', description: 'Old command', source: 'skill' }],
      chatError: 'Old error',
      queued: [{ id: 'queued', text: 'Old follow-up', attachments: [] }],
      narrowTab: 'pane',
    });

    useApp.getState().newDevTeam();

    expect(sendFrame).toHaveBeenCalledWith({ type: 'chat-new', kind: 'devteam' });
    expect(useApp.getState().conversationMode).toBe('devteam');
    expect(useApp.getState().chats[0].kind).toBe('chat');
    expect(useApp.getState().devTeam).toBeNull();
    expect(useApp.getState().devTeamLanes).toEqual({});
    expect(useApp.getState()).toMatchObject({
      messages: [],
      chatBusy: false,
      chatDriver: null,
      slashCommands: [],
      chatError: null,
      queued: [],
      narrowTab: 'chat',
    });
  });

  it('routes and optimistically settles an engineer approval in its own lane', () => {
    receive({
      type: 'devteam-event',
      chatId: 'team-chat',
      engineerId: 'engineer-1',
      event: { type: 'approval-request', approvalId: 'approval-1', kind: 'command', title: 'Run tests', detail: 'npm test' },
    });
    useApp.getState().approveEngineer('engineer-1', 'approval-1', 'allow', 'once');

    const approval = useApp.getState().devTeamLanes['engineer-1'][0].parts.find((part) => part.kind === 'approval');
    expect(approval).toMatchObject({ id: 'approval-1', decision: 'allow' });
    expect(useApp.getState().sendFrame).toHaveBeenCalledWith({
      type: 'devteam-engineer-approval',
      engineerId: 'engineer-1',
      approvalId: 'approval-1',
      decision: 'allow',
      choiceId: 'once',
    });
  });

  it('leaves an engineer approval pending when its socket send fails', () => {
    receive({
      type: 'devteam-event',
      chatId: 'team-chat',
      engineerId: 'engineer-1',
      event: { type: 'approval-request', approvalId: 'approval-1', kind: 'command', title: 'Run tests', detail: 'npm test' },
    });
    useApp.setState({ sendFrame: vi.fn(() => false) });

    useApp.getState().approveEngineer('engineer-1', 'approval-1', 'allow', 'once');

    const approval = useApp.getState().devTeamLanes['engineer-1'][0].parts.find((part) => part.kind === 'approval');
    expect(approval).toMatchObject({ id: 'approval-1', decision: null });
  });

  it('routes and optimistically settles an engineer input in its own lane', () => {
    receive({
      type: 'devteam-event',
      chatId: 'team-chat',
      engineerId: 'engineer-1',
      event: {
        type: 'input-request',
        inputId: 'input-1',
        questions: [{ id: 'name', label: 'Name', type: 'text' }],
        allowCancel: true,
      },
    });
    expect(useApp.getState().answerEngineerInput('engineer-1', 'input-1', 'submit', { name: 'Hearth' })).toBe(true);

    const input = useApp.getState().devTeamLanes['engineer-1'][0].parts.find((part) => part.kind === 'input');
    expect(input).toMatchObject({ id: 'input-1', resolution: 'submit' });
    expect(useApp.getState().sendFrame).toHaveBeenCalledWith({
      type: 'devteam-engineer-input',
      engineerId: 'engineer-1',
      inputId: 'input-1',
      action: 'submit',
      answers: { name: 'Hearth' },
    });
  });

  it('clears run state as soon as another chat or workspace is chosen', () => {
    useApp.setState({ devTeam: SNAPSHOT, devTeamLanes: { 'engineer-1': [] } });
    useApp.getState().openChat('ordinary-chat');
    expect(useApp.getState().devTeam).toBeNull();
    expect(useApp.getState().devTeamLanes).toEqual({});

    useApp.setState({ devTeam: SNAPSHOT, devTeamLanes: { 'engineer-1': [] } });
    useApp.getState().closeWorkspace();
    expect(useApp.getState().devTeam).toBeNull();
    expect(useApp.getState().devTeamLanes).toEqual({});
    expect(useApp.getState().devTeamByChat).toEqual({});
  });

  it('keeps the run state when the already-open conversation is selected again', () => {
    useApp.setState({ devTeam: SNAPSHOT, devTeamLanes: { 'engineer-1': [] } });
    useApp.getState().openChat('team-chat');
    expect(useApp.getState().devTeam).toEqual(SNAPSHOT);
    expect(useApp.getState().devTeamLanes).toEqual({ 'engineer-1': [] });
  });

  it('removes cached team status when an inactive conversation is deleted', async () => {
    useApp.setState({
      activeChatId: 'ordinary-chat',
      devTeamByChat: { 'team-chat': SNAPSHOT },
    });

    await useApp.getState().deleteChat('team-chat');

    expect(useApp.getState().devTeamByChat).toEqual({});
  });

  it('does not let late frames refill the blank New chat surface', () => {
    useApp.setState({ devTeam: SNAPSHOT, devTeamLanes: { 'engineer-1': [] } });
    useApp.getState().newChat();
    receive({ type: 'devteam-state', chatId: 'team-chat', state: SNAPSHOT });
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'message-delta', text: 'Late' } });
    expect(useApp.getState().devTeam).toBeNull();
    expect(useApp.getState().devTeamLanes).toEqual({});
  });
});
