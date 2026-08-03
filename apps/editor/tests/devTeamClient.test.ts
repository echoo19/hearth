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
  phaseSince: null,
  steering: [],
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

  it('goes on reporting after one of an engineer’s turns has ended', () => {
    // A task that is retried reports into the lane it already used, whose last
    // turn is over. The fold drops anything it cannot append to a streaming
    // message, so without a fresh bubble the retry was invisible: the card sat
    // there saying Working with an empty log under it.
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'message-delta', text: 'First attempt' } });
    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'turn-complete' } });

    receive({ type: 'devteam-event', chatId: 'team-chat', engineerId: 'engineer-1', event: { type: 'message-delta', text: 'Second attempt' } });

    const lane = useApp.getState().devTeamLanes['engineer-1'];
    expect(lane).toHaveLength(2);
    expect(lane[1]).toMatchObject({ streaming: true, parts: [{ kind: 'text', text: 'Second attempt' }] });
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

  it('ends the optimistic turn a steering note never started, and says the note was taken', () => {
    const sendFrame = useApp.getState().sendFrame as ReturnType<typeof vi.fn>;
    useApp.setState({ wsStatus: 'connected' });
    receive({ type: 'devteam-state', chatId: 'team-chat', state: SNAPSHOT });

    expect(useApp.getState().sendChat('Keep the interface quiet.')).toBe(true);
    expect(useApp.getState().chatBusy).toBe(true);
    expect(useApp.getState().messages).toHaveLength(2);

    receive({ type: 'devteam-steering-accepted', chatId: 'team-chat' });

    expect(useApp.getState().chatBusy).toBe(false);
    // The user's own words stay, and the bubble for the turn that never began
    // becomes the receipt. Deleting it left a message to the lead with no reply
    // and no acknowledgement of any kind, which from the chair is exactly what
    // a send that failed looks like.
    expect(stripMessageIds(useApp.getState().messages)).toEqual([
      expect.objectContaining({ role: 'user', parts: [{ kind: 'text', text: 'Keep the interface quiet.' }] }),
      expect.objectContaining({
        role: 'agent',
        streaming: false,
        parts: [{ kind: 'notice', text: expect.stringContaining('next handoff') }],
      }),
    ]);

    expect(useApp.getState().sendChat('And keep it quick.')).toBe(true);
    expect(useApp.getState().queued).toEqual([]);
    expect(sendFrame.mock.calls.filter(([frame]) => frame.type === 'chat-send').map(([frame]) => frame.text)).toEqual([
      'Keep the interface quiet.',
      'And keep it quick.',
    ]);
  });

  it('sends the note queued behind an unacknowledged one as soon as the ack lands', () => {
    const sendFrame = useApp.getState().sendFrame as ReturnType<typeof vi.fn>;
    useApp.setState({ wsStatus: 'connected' });
    receive({ type: 'devteam-state', chatId: 'team-chat', state: SNAPSHOT });

    useApp.getState().sendChat('first note');
    useApp.getState().sendChat('second note');
    expect(useApp.getState().queued.map((message) => message.text)).toEqual(['second note']);

    receive({ type: 'devteam-steering-accepted', chatId: 'team-chat' });

    expect(useApp.getState().queued).toEqual([]);
    expect(sendFrame.mock.calls.filter(([frame]) => frame.type === 'chat-send').map(([frame]) => frame.text)).toEqual([
      'first note',
      'second note',
    ]);
  });

  it('ignores a steering ack addressed to another conversation', () => {
    useApp.setState({ wsStatus: 'connected' });
    useApp.getState().sendChat('mine');

    receive({ type: 'devteam-steering-accepted', chatId: 'other-chat' });

    expect(useApp.getState().chatBusy).toBe(true);
    expect(useApp.getState().messages).toHaveLength(2);
  });

  it('keeps a streaming agent bubble that already has content', () => {
    useApp.setState({ wsStatus: 'connected' });
    useApp.getState().sendChat('a note');
    receive({ type: 'chat-event', chatId: 'team-chat', event: { type: 'message-delta', text: 'the lead is talking' } });

    receive({ type: 'devteam-steering-accepted', chatId: 'team-chat' });

    expect(useApp.getState().chatBusy).toBe(false);
    expect(useApp.getState().messages).toHaveLength(2);
    expect(useApp.getState().messages[1].parts).toEqual([{ kind: 'text', text: 'the lead is talking' }]);
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
  it('rejects a direct CLI handoff while the dev team lead still owns an active run', () => {
    receive({
      type: 'chat-opened',
      chat: {
        id: 'team-chat',
        title: 'Dev team',
        kind: 'devteam',
        codexThreadId: 'thread-1',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      },
      records: [],
    });
    receive({ type: 'devteam-state', chatId: 'team-chat', state: { ...SNAPSHOT, phase: 'wrapping' } });
    const sendFrame = vi.fn(() => true);
    const log = vi.fn();
    useApp.setState({ wsStatus: 'connected', chatBusy: false, sendFrame, log });

    expect(useApp.getState().continueChatInCli()).toBe(false);
    expect(sendFrame).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'error',
      'app',
      'Finish the dev team run before continuing its lead in the CLI.',
    );
  });

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

  it('does not let a delayed snapshot recreate deleted status before authoritative reappearance', async () => {
    useApp.setState({
      activeChatId: 'ordinary-chat',
      devTeamByChat: { 'team-chat': SNAPSHOT },
    });
    await useApp.getState().deleteChat('team-chat');

    receive({ type: 'devteam-state', chatId: 'team-chat', state: SNAPSHOT });
    expect(useApp.getState().devTeamByChat).toEqual({});

    receive({
      type: 'chat-opened',
      chat: {
        id: 'team-chat',
        title: 'Dev team again',
        kind: 'devteam',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      },
      records: [],
    });
    receive({ type: 'devteam-state', chatId: 'team-chat', state: SNAPSHOT });
    expect(useApp.getState().devTeamByChat['team-chat']).toEqual(SNAPSHOT);
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
