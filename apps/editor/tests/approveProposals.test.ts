// @vitest-environment jsdom
/**
 * What approval sends, and where it sends it.
 *
 * Two halves, and they fail in different ways. The seed is pure and decides
 * what reaches an agent, so the thing it must never do is carry something
 * nobody ticked: a proposal sitting in the context is a proposal the agent may
 * act on, and that would make the checkboxes decoration. The action is
 * plumbing, and its failure is quieter. Approved work dropped into the open
 * conversation lands on top of whatever was already being discussed there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { approvalSeed, frameFile } from '../server/tester/report';
import type { TesterNote } from '../server/tester/types';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiTesterApprove: vi.fn(),
}));

import { apiTesterApprove } from '../src/api';
import { useApp } from '../src/store';
import type { WsFrame } from '../server/ws';

const FRAMES = '.hearth/tester/sessions/0003/frames';

function note(over: Partial<TesterNote> = {}): TesterNote {
  return {
    session: 3,
    startedAt: '2026-07-27T10:00:00.000Z',
    finishedAt: '2026-07-27T10:12:00.000Z',
    onTheChange: { seen: 'you rewrote the intake rules', verdict: 'better', why: 'the queue cleared' },
    regression: 'nothing',
    observations: [
      { frame: 4, text: 'the audit total came out negative', reached: 'played' },
      { frame: 6, text: 'the queue took nine turns to clear', reached: 'placed' },
      { frame: 9, text: 'the ledger disagreed with the summary', reached: 'played' },
    ],
    proposals: [
      { kind: 'bug', text: 'the audit total goes negative once a refund is filed', evidence: [4] },
      { kind: 'suggestion', text: 'the intake queue could clear faster', evidence: [6] },
      { kind: 'bug', text: 'the ledger and the summary disagree', evidence: [9] },
    ],
    openQuestions: [],
    steps: 12,
    stopped: 'done',
    ...over,
  };
}

describe('the seed approval sends', () => {
  it('carries what was ticked and leaves everything else out', () => {
    const seed = approvalSeed(note(), ['s3-p0', 's3-p2'], FRAMES);
    expect(seed?.text).toContain('the audit total goes negative');
    expect(seed?.text).toContain('the ledger and the summary disagree');
    expect(seed?.text).not.toContain('intake queue could clear faster');
  });

  it('has nothing to send when nothing was ticked', () => {
    expect(approvalSeed(note(), [], FRAMES)).toBeNull();
    expect(approvalSeed(note(), ['s3-p99'], FRAMES)).toBeNull();
  });

  it('keeps a bug and a preference apart in the words it sends', () => {
    const seed = approvalSeed(note(), ['s3-p0', 's3-p1'], FRAMES);
    expect(seed?.text).toMatch(/it watched these go wrong/i);
    expect(seed?.text).toMatch(/these are preferences, and it cannot judge fun/i);
  });

  it('carries the placed caveat with the claim it belongs to', () => {
    const seed = approvalSeed(note(), ['s3-p1'], FRAMES);
    expect(seed?.text).toMatch(/game put it there/i);
    // And says nothing of the sort when the tester played its way there.
    expect(approvalSeed(note(), ['s3-p0'], FRAMES)?.text).not.toMatch(/game put it there/i);
  });

  it('gathers the pictures behind what was ticked, and only those', () => {
    expect(approvalSeed(note(), ['s3-p0', 's3-p2'], FRAMES)?.frames).toEqual([4, 9]);
  });

  it('says where the pictures are, so the agent can open them', () => {
    const seed = approvalSeed(note(), ['s3-p0'], FRAMES);
    expect(seed?.text).toContain(FRAMES);
    expect(seed?.text).toContain(frameFile(4));
  });

  it('names the pictures as files the way the tester wrote them', () => {
    expect(frameFile(4)).toBe('0004.png');
    expect(frameFile(12)).toBe('0012.png');
  });
});

const approve = vi.mocked(apiTesterApprove);

/** A socket that answers `chat-new` the way the server does: with a new chat. */
function socketThatOpens(id: string): ReturnType<typeof vi.fn> {
  return vi.fn((frame: WsFrame) => {
    if (frame.type === 'chat-new') {
      useApp.getState().receiveFrame({
        type: 'chat-opened',
        chat: {
          id,
          title: 'Untitled',
          kind: 'chat',
          createdAt: '2026-07-27T10:20:00.000Z',
          updatedAt: '2026-07-27T10:20:00.000Z',
        },
        records: [],
      });
    }
    return true;
  });
}

describe('approving a plan of action', () => {
  beforeEach(() => {
    approve.mockReset();
    approve.mockResolvedValue({ ok: true, text: 'work on these two', frames: [] });
    useApp.setState({
      projectPath: '/work/game',
      projectName: 'game',
      activeChatId: 'older',
      wsStatus: 'connected',
      messages: [],
      chatBusy: false,
      chatError: null,
      screen: 'tester',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the server for exactly the ticked ids', async () => {
    useApp.setState({ sendFrame: socketThatOpens('fresh') });
    await useApp.getState().approveProposals(3, ['s3-p0', 's3-p2']);
    expect(approve).toHaveBeenCalledWith('/work/game', 3, ['s3-p0', 's3-p2']);
  });

  it('starts a new conversation before it sends anything', async () => {
    const sendFrame = socketThatOpens('fresh');
    useApp.setState({ sendFrame });
    await useApp.getState().approveProposals(3, ['s3-p0']);
    const kinds = sendFrame.mock.calls.map((call) => (call[0] as WsFrame).type);
    expect(kinds).toEqual(['chat-new', 'chat-send']);
    expect(useApp.getState().activeChatId).toBe('fresh');
  });

  it('works on the game the report belongs to, not on whichever one is open', async () => {
    // The Tester screen lists every game's sessions, so the report being read
    // there is usually NOT the open project's. Approving used to ask the
    // server about the open folder with the other folder's session number:
    // at best nothing could be put into words, at worst it turned a different
    // game's session 3 into a message and sent it into that game's chat.
    const openWorkspace = vi.fn(async (path: string) => {
      useApp.setState({ projectPath: path, projectName: 'other' });
      return { ok: true };
    });
    useApp.setState({ sendFrame: socketThatOpens('fresh'), openWorkspace });
    const result = await useApp.getState().approveProposals(3, ['s3-p0'], { project: '/work/other' });
    expect(result.ok).toBe(true);
    expect(openWorkspace).toHaveBeenCalledWith('/work/other');
    expect(approve).toHaveBeenCalledWith('/work/other', 3, ['s3-p0']);
  });

  it('does not open a project it is already standing in', async () => {
    const openWorkspace = vi.fn(async () => ({ ok: true }));
    useApp.setState({ sendFrame: socketThatOpens('fresh'), openWorkspace });
    await useApp.getState().approveProposals(3, ['s3-p0'], { project: '/work/game' });
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it('holds the words when the send itself could not go out', async () => {
    // The conversation opened, so this reported success and closed the report
    // over a message that was never sent: the socket dropped between the two
    // frames and `sendChat` gave up with a toast the closing dialog took with
    // it. Approved work that goes nowhere must say so and keep the words.
    const sendFrame = vi.fn((frame: WsFrame) => {
      if (frame.type === 'chat-new') {
        useApp.getState().receiveFrame({
          type: 'chat-opened',
          chat: {
            id: 'fresh',
            title: 'Untitled',
            kind: 'chat',
            createdAt: '2026-07-27T10:20:00.000Z',
            updatedAt: '2026-07-27T10:20:00.000Z',
          },
          records: [],
        });
        return true;
      }
      return false;
    });
    useApp.setState({ sendFrame });
    const result = await useApp.getState().approveProposals(3, ['s3-p0']);
    expect(result.ok).toBe(false);
    expect(useApp.getState().pendingPrompt).toBe('work on these two');
  });

  it('keeps the words rather than dropping them into the old conversation', async () => {
    // A socket that never answers. The approved work must not land in whatever
    // was open a moment ago, so nothing is sent and the words are kept.
    const sendFrame = vi.fn((_frame: WsFrame) => true);
    useApp.setState({ sendFrame });
    const result = await useApp.getState().approveProposals(3, ['s3-p0'], { waitMs: 20 });
    expect(result.ok).toBe(false);
    expect(sendFrame.mock.calls.map((call) => call[0].type)).toEqual(['chat-new']);
    expect(useApp.getState().pendingPrompt).toBe('work on these two');
  });

  it('sends nothing at all when nothing was ticked', async () => {
    const sendFrame = vi.fn((_frame: WsFrame) => true);
    useApp.setState({ sendFrame });
    const result = await useApp.getState().approveProposals(3, []);
    expect(result.ok).toBe(false);
    expect(approve).not.toHaveBeenCalled();
    expect(sendFrame).not.toHaveBeenCalled();
  });
});
