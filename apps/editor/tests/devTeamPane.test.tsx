// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevTeamPane } from '../src/components/chat/DevTeamPane';
import { devTeamActivity, devTeamPhaseLabel, devTeamStage, pendingLaneAsk } from '../src/chat/devteam';
import { useApp } from '../src/store';
import type { ChatMessage, DevTeamSnapshot } from '../src/types';

const plan: NonNullable<DevTeamSnapshot['plan']> = {
  version: 1,
  roles: [
    { id: 'build', name: 'Gameplay builder', focus: 'Interaction and feel' },
    { id: 'art', name: 'Visual maker', focus: 'Readable presentation' },
  ],
  milestones: [
    {
      id: 'playable',
      title: 'Playable loop',
      goal: 'A first complete pass',
      tasks: [
        { id: 'controls', title: 'Build controls', roleId: 'build', detail: 'Implement interaction' },
        { id: 'look', title: 'Shape the look', roleId: 'art', detail: 'Implement presentation' },
      ],
    },
  ],
};

const snapshot = (over: Partial<DevTeamSnapshot> = {}): DevTeamSnapshot => ({
  version: 1,
  runId: 'run-1',
  phase: 'building',
  phaseSince: null,
  steering: [],
  plan,
  tasks: [
    { taskId: 'controls', engineerId: 'engineer-controls', status: 'running', files: ['src/input.ts'] },
    { taskId: 'look', engineerId: 'engineer-look', status: 'running' },
  ],
  approvals: [{ specVersion: 1, approvedAt: '2026-07-31T00:00:00.000Z' }],
  history: [],
  currentMilestone: 0,
  spec: '# Tiny world\n\nBuild a small, tactile world.',
  specVersion: 1,
  summary: null,
  wrap: null,
  error: null,
  ...over,
});

const leadMessage: ChatMessage = {
  id: 'lead-1',
  role: 'agent',
  parts: [{ kind: 'text', text: 'I am reviewing the first pass.' }],
  streaming: false,
};

const engineerLane: ChatMessage[] = [{
  id: 'engineer-1',
  role: 'agent',
  parts: [
    { kind: 'text', text: 'Wiring movement now.' },
    {
      kind: 'approval',
      id: 'approval-1',
      approvalKind: 'command',
      title: 'Run the game build',
      detail: 'npm run build',
      decision: null,
    },
  ],
  streaming: true,
}];

const lanes = () => screen.getAllByRole('button', { name: /lane/i });

beforeEach(() => {
  useApp.setState({
    projectPath: '/work/game',
    projectName: 'game',
    conversationMode: 'devteam',
    activeChatId: 'team-chat',
    messages: [leadMessage],
    devTeam: snapshot(),
    devTeamLanes: { 'engineer-controls': engineerLane, 'engineer-look': [] },
    permissionMode: 'ask',
    wsStatus: 'connected',
    chatBusy: false,
    queued: [],
    composerDrafts: {},
    sendFrame: vi.fn(() => true),
    approveDevTeamSpec: vi.fn(),
    pauseDevTeam: vi.fn(),
    resumeDevTeam: vi.fn(),
    stopDevTeam: vi.fn(),
    approveEngineer: vi.fn(),
    answerEngineerInput: vi.fn(() => true),
  } as never);
});

afterEach(cleanup);

describe('dev team presentation helpers', () => {
  it('uses truthful phase and activity language', () => {
    expect(devTeamPhaseLabel('spec-review')).toBe('Spec review');
    expect(devTeamActivity(engineerLane)).toBe('Needs you');
    expect(devTeamActivity([], 'done')).toBe('Finished');
  });

  it('chooses one pending ask in transcript order even when both kinds are waiting', () => {
    const both: ChatMessage[] = [{
      id: 'both',
      role: 'agent',
      streaming: true,
      parts: [
        {
          kind: 'input',
          id: 'input-first',
          questions: [{ id: 'answer', label: 'Answer', type: 'text' }],
          allowCancel: false,
          resolution: null,
        },
        {
          kind: 'approval',
          id: 'approval-second',
          approvalKind: 'command',
          title: 'Run a command',
          detail: 'npm test',
          decision: null,
        },
      ],
    }];

    expect(pendingLaneAsk(both)).toEqual({
      active: { kind: 'input', id: 'input-first' },
      count: 2,
    });
  });

  it('is a conversation until a team exists and again once it has dissolved', () => {
    // The interview and the spec are one person and one agent working something
    // out; the report is written when the engineers have all gone home. Only
    // the stretch in between is a thing being managed.
    const stage = (phase: DevTeamSnapshot['phase'], hasPlan = true) =>
      devTeamStage({ phase, plan: hasPlan ? plan : null });

    expect(stage('idle')).toBe('conversation');
    expect(stage('interviewing')).toBe('conversation');
    expect(stage('spec-review')).toBe('conversation');
    expect(stage('planning', false)).toBe('team');
    expect(stage('building')).toBe('team');
    expect(stage('reviewing')).toBe('team');
    expect(stage('wrapping')).toBe('conversation');
    expect(stage('done')).toBe('conversation');
    // A parked run goes wherever it was parked. Showing an empty board over the
    // interview that explains why is exactly the wrong way round.
    expect(stage('interrupted', false)).toBe('conversation');
    expect(stage('interrupted')).toBe('team');
    expect(devTeamStage(null)).toBe('conversation');
  });
});

describe('DevTeamPane', () => {
  it('offers Stop for the whole life of a run, including the interview', () => {
    // A lead turn can hang with nothing but a climbing counter to show for it,
    // and the interview is exactly where that happened. Deriving Stop from the
    // pausable phases left that run with no control at all.
    for (const phase of ['interviewing', 'drafting-spec', 'spec-review', 'building', 'paused', 'interrupted'] as const) {
      cleanup();
      act(() => useApp.setState({ devTeam: snapshot({ phase }) } as never));
      render(<DevTeamPane />);
      expect(screen.queryByRole('button', { name: 'Stop dev team' }), phase).toBeTruthy();
    }
    for (const phase of ['idle', 'done'] as const) {
      cleanup();
      act(() => useApp.setState({ devTeam: snapshot({ phase }) } as never));
      render(<DevTeamPane />);
      expect(screen.queryByRole('button', { name: 'Stop dev team' }), phase).toBeNull();
    }
  });

  it('shows the interview as an ordinary chat with one line of run status', () => {
    // "For interview and spec it just looks like a normal chat." A four-step
    // progress rail over a two-message conversation was describing a pipeline
    // to someone still typing the first sentence of it.
    cleanup();
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'interviewing', plan: null, tasks: [], approvals: [] }),
    } as never));
    render(<DevTeamPane />);

    expect(screen.getAllByText('I am reviewing the first pass.').length).toBeGreaterThan(0);
    expect(screen.getByRole('status', { name: 'Dev team phase' }).textContent).toBe('Interview');
    expect(screen.queryAllByRole('button', { name: /lane/i })).toHaveLength(0);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message the lead' })).toBeTruthy();
  });

  it('becomes a lead-over-team board once the spec is approved', () => {
    render(<DevTeamPane />);

    // The lead is first and stays first: it is the one you talk to and the one
    // that summons and dismisses the rest.
    expect(lanes()[0].getAttribute('aria-label')).toMatch(/^Lead lane/);
    expect(screen.getByRole('progressbar', { name: 'Tasks finished' }).getAttribute('aria-valuemax')).toBe('2');
    const engineer = screen.getByRole('button', { name: /Build controls lane/i });
    expect(engineer.getAttribute('aria-label')).toBe(
      'Build controls lane, Gameplay builder, Needs you, Wiring movement now., 1 waiting question',
    );
    expect(screen.getByText('Playable loop')).toBeTruthy();
    expect(screen.getByText(/Ask mode pauses engineers/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Tell the team' }).getAttribute('placeholder')).toBe('Tell the team…');
  });

  it('keeps only the members still on the job, and leaves the rest in the plan', () => {
    // A sixteen-task run put sixteen cards on the board, thirteen of them
    // reading QUEUED. A queued task is not a person yet and a finished one is
    // not a person any more; both belong in the plan, which is where a task
    // that is not somebody you can manage lives.
    cleanup();
    act(() => useApp.setState({
      devTeam: snapshot({
        tasks: [
          { taskId: 'controls', engineerId: 'engineer-controls', status: 'done', summary: 'Controls landed.' },
          { taskId: 'look', engineerId: 'engineer-look', status: 'running' },
        ],
      }),
      devTeamLanes: { 'engineer-controls': [], 'engineer-look': [] },
    } as never));
    render(<DevTeamPane />);

    expect(screen.queryByRole('button', { name: /Build controls lane/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Shape the look lane/i })).toBeTruthy();
    // Still accounted for: the plan carries the outcome, and the meter counts it.
    expect(screen.getByRole('progressbar', { name: 'Tasks finished' }).getAttribute('aria-valuenow')).toBe('1');
    const planned = screen.getAllByText('Build controls').map((node) => node.closest('li')).find(Boolean);
    expect(planned?.getAttribute('data-status')).toBe('done');
  });

  it('says why the board is empty rather than showing an empty board', () => {
    const cases: [Partial<DevTeamSnapshot>, RegExp][] = [
      [{ phase: 'planning', plan: null, tasks: [] }, /writing the plan/],
      [{ phase: 'reviewing', tasks: [] }, /reviewing it/],
      [{ phase: 'paused', tasks: [] }, /parked/],
    ];
    for (const [over, text] of cases) {
      cleanup();
      act(() => useApp.setState({ devTeam: snapshot(over) } as never));
      render(<DevTeamPane />);
      expect(screen.getByText(text), String(text)).toBeTruthy();
    }
  });

  it('offers a way out once a single lead turn has run far too long', () => {
    // The pane used to show "The lead is writing the plan" at minute one and at
    // hour two with no way to tell those apart and nothing to press but Stop,
    // which discards whatever the turn had already written.
    const recoverDevTeam = vi.fn();
    cleanup();
    act(() => useApp.setState({
      recoverDevTeam,
      devTeam: snapshot({ phase: 'planning', plan: null, tasks: [], phaseSince: Date.now() - 20 * 60 * 1000 }),
    } as never));
    render(<DevTeamPane />);

    expect(screen.getByText(/has not finished Planning after /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Pick the run back up/ }));
    expect(recoverDevTeam).toHaveBeenCalledTimes(1);
  });

  it('says nothing about stalling while a turn is merely taking its time', () => {
    cleanup();
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'planning', plan: null, tasks: [], phaseSince: Date.now() - 20 * 1000 }),
    } as never));
    render(<DevTeamPane />);

    expect(screen.queryByRole('button', { name: /Pick the run back up/ })).toBeNull();
  });

  it('never calls a long build stalled, because its members are still reporting', () => {
    // `building` is the one long phase that is not a single turn. Nagging about
    // it would fire on every healthy run that takes more than three minutes.
    cleanup();
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'building', phaseSince: Date.now() - 2 * 60 * 60 * 1000 }),
    } as never));
    render(<DevTeamPane />);

    expect(screen.queryByRole('button', { name: /Pick the run back up/ })).toBeNull();
  });

  it('shows one member log at a time and swaps it when another card is picked', () => {
    // The team is headless: the board is the only place they exist, and the log
    // is the only way to see what one of them actually did. Reading one must
    // not bury the others, so exactly one log is open and the board stays put.
    render(<DevTeamPane />);

    const controls = screen.getByRole('button', { name: /Build controls lane/i });
    const look = screen.getByRole('button', { name: /Shape the look lane/i });
    // The blocked one shows itself without being asked.
    expect(controls.getAttribute('aria-expanded')).toBe('true');
    expect(look.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('region', { name: /log$/ })).toHaveLength(1);

    fireEvent.click(look);
    expect(look.getAttribute('aria-expanded')).toBe('true');
    expect(controls.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('region', { name: 'Shape the look log' })).toBeTruthy();
    expect(screen.getAllByRole('region', { name: /log$/ })).toHaveLength(1);
  });

  it('puts the ordinary conversation back in the panel when the lead is picked', () => {
    // "Click into the main agent and chat with it the same." The lead's log is
    // not a summary of the run, it is the run's actual conversation.
    render(<DevTeamPane />);
    fireEvent.click(screen.getByRole('button', { name: /Lead lane/i }));

    expect(screen.getByRole('region', { name: 'Lead log' }).textContent)
      .toContain('I am reviewing the first pass.');
    expect(screen.getByRole('button', { name: /Build controls lane/i }).getAttribute('aria-expanded'))
      .toBe('false');
  });

  it('falls back to the lead when the member being read finishes and leaves', () => {
    // A card can vanish mid-read: the whole point of the board is that members
    // leave when they are done. There must never be a frame with nothing
    // selected and no log at all.
    cleanup();
    act(() => useApp.setState({ devTeamLanes: { 'engineer-controls': [], 'engineer-look': [] } } as never));
    const view = render(<DevTeamPane />);
    fireEvent.click(screen.getByRole('button', { name: /Shape the look lane/i }));
    expect(screen.getByRole('region', { name: 'Shape the look log' })).toBeTruthy();

    act(() => useApp.setState({
      devTeam: snapshot({
        tasks: [
          { taskId: 'controls', engineerId: 'engineer-controls', status: 'running' },
          { taskId: 'look', engineerId: 'engineer-look', status: 'done', summary: 'Sprites done.' },
        ],
      }),
    }));
    view.rerender(<DevTeamPane />);

    expect(screen.queryByRole('button', { name: /Shape the look lane/i })).toBeNull();
    expect(screen.getByRole('region', { name: 'Lead log' })).toBeTruthy();
  });

  it('tells you a headless member has reported nothing rather than showing a blank', () => {
    cleanup();
    act(() => useApp.setState({ devTeamLanes: { 'engineer-controls': [], 'engineer-look': [] } } as never));
    render(<DevTeamPane />);

    fireEvent.click(screen.getByRole('button', { name: /Shape the look lane/i }));
    expect(screen.getByText(/headless, so whatever it does shows up here/)).toBeTruthy();
  });

  it('opens a blocked lane on its own and routes asks to that engineer only', () => {
    render(<DevTeamPane />);
    const engineer = screen.getByRole('button', { name: /Build controls lane/i });
    expect(engineer.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByText('Wiring movement now.').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    expect(useApp.getState().approveEngineer).toHaveBeenCalledWith(
      'engineer-controls',
      'approval-1',
      'allow',
      undefined,
    );
  });

  it('routes structured engineer answers through the engineer input action', () => {
    act(() => useApp.setState({
      devTeamLanes: {
        'engineer-controls': [{
          id: 'engineer-input',
          role: 'agent',
          parts: [{
            kind: 'input',
            id: 'input-1',
            title: 'Choose a direction',
            questions: [{ id: 'direction', label: 'Direction', type: 'text', required: true }],
            allowCancel: false,
            resolution: null,
          }],
          streaming: true,
        }],
        'engineer-look': [],
      },
    }));
    render(<DevTeamPane />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Direction' }), { target: { value: 'north' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(useApp.getState().answerEngineerInput).toHaveBeenCalledWith(
      'engineer-controls',
      'input-1',
      'submit',
      { direction: 'north' },
    );
  });

  it('gives keyboard shortcuts to only one engineer ask at a time', () => {
    const secondAsk: ChatMessage = {
      id: 'engineer-2',
      role: 'agent',
      parts: [{
        kind: 'approval',
        id: 'approval-2',
        approvalKind: 'command',
        title: 'Inspect assets',
        detail: 'ls assets',
        decision: null,
      }],
      streaming: true,
    };
    act(() => useApp.setState({
      devTeamLanes: { 'engineer-controls': engineerLane, 'engineer-look': [secondAsk] },
    }));
    render(<DevTeamPane />);
    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(useApp.getState().approveEngineer).toHaveBeenCalledTimes(1);
    expect(useApp.getState().approveEngineer).toHaveBeenCalledWith(
      'engineer-controls',
      'approval-1',
      'deny',
      undefined,
    );
  });

  it('offers pause and stop while active, then resume when paused', () => {
    const { rerender } = render(<DevTeamPane />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause dev team' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop dev team' }));
    expect(useApp.getState().pauseDevTeam).toHaveBeenCalledOnce();
    expect(useApp.getState().stopDevTeam).toHaveBeenCalledOnce();

    act(() => useApp.setState({ devTeam: snapshot({ phase: 'paused' }) }));
    rerender(<DevTeamPane />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume dev team' }));
    expect(useApp.getState().resumeDevTeam).toHaveBeenCalledOnce();
  });

  it('opens the lead lane when review begins without moving keyboard focus', () => {
    cleanup();
    act(() => useApp.setState({ devTeamLanes: { 'engineer-controls': [], 'engineer-look': [] } } as never));
    render(<DevTeamPane />);
    const composer = screen.getByRole('textbox', { name: 'Tell the team' });
    composer.focus();
    fireEvent.click(screen.getByRole('button', { name: /Build controls lane/i }));
    expect(screen.getByRole('button', { name: /Lead lane/i }).getAttribute('aria-expanded')).toBe('false');

    act(() => useApp.setState({ devTeam: snapshot({ phase: 'reviewing' }) }));

    expect(screen.getByRole('button', { name: /Lead lane/i }).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(composer);
  });

  it('explains that active team steering is text-only, only when a file is offered', () => {
    render(<DevTeamPane />);
    expect(screen.queryByText('Steering is text-only while the team is running.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    expect(screen.getByRole('menuitem', { name: 'Add photos & files…' }).getAttribute('aria-disabled')).toBe('true');

    fireEvent.dragOver(document.querySelector('.composer-card')!, {
      dataTransfer: {
        items: [{ kind: 'file', getAsFile: () => new File(['x'], 'sprite.png', { type: 'image/png' }) }],
        files: [],
      },
    });
    expect(screen.getByText('Steering is text-only while the team is running.')).toBeTruthy();
  });

  it('shows the spec as the one primary decision and keeps revision messaging live', () => {
    act(() => useApp.setState({ devTeam: snapshot({ phase: 'spec-review', plan: null, tasks: [], approvals: [] }) }));
    render(<DevTeamPane />);

    expect(screen.getByRole('region', { name: 'Specification' }).textContent).toContain('Tiny world');
    fireEvent.click(screen.getByRole('button', { name: 'Approve & build' }));
    expect(useApp.getState().approveDevTeamSpec).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Message the lead' }).getAttribute('placeholder')).toBe('Describe a revision…');
  });

  it('settles an approved spec to a one-line record that can still be read', () => {
    act(() => useApp.setState({ devTeam: snapshot({ phase: 'planning' }) }));
    render(<DevTeamPane />);
    const record = screen.getByText('Approved specification v1').closest('details');
    expect(record).not.toBeNull();
    expect(record?.hasAttribute('open')).toBe(false);
    expect(record?.textContent).toContain('Build a small, tactile world.');
    expect(screen.queryByRole('region', { name: 'Specification' })).toBeNull();
  });

  it('keeps a completed run reopenable after a later run starts', () => {
    const completed = {
      version: 1 as const,
      runId: 'run-1',
      plan,
      tasks: snapshot().tasks,
      currentMilestone: 0,
      spec: '# Tiny world',
      specVersion: 1,
      summary: 'Reviewed.',
      wrap: 'Use arrow keys.',
      completedAt: '2026-07-31T00:01:00.000Z',
    };
    act(() => useApp.setState({
      devTeam: {
        ...snapshot({ runId: 'run-2', phase: 'interviewing', plan: null, tasks: [], spec: null }),
        history: [completed],
      },
      devTeamLanes: {},
    }));
    render(<DevTeamPane />);

    const record = screen.getByText(/Run complete/).closest('details');
    expect(record).not.toBeNull();
    expect(record?.hasAttribute('open')).toBe(false);
    // The earlier run's handoff stays behind the fold; only the live one opens.
    expect(screen.getByText('Use arrow keys.').closest('details')?.hasAttribute('open')).toBe(false);
  });

  it('returns to the ordinary transcript with the closing handoff already open when done', () => {
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'done', summary: 'A tactile tiny world.', wrap: 'Open the game and use arrow keys.' }),
    }));
    render(<DevTeamPane />);

    // The team has dissolved: there is no board left, only the conversation and
    // the report, with the plan under it carrying what each task came to.
    expect(screen.queryAllByRole('button', { name: /lane/i })).toHaveLength(0);
    expect(screen.getAllByText('I am reviewing the first pass.').length).toBeGreaterThan(0);
    const record = screen.getByText(/Run complete/).closest('details');
    expect(record?.hasAttribute('open')).toBe(true);
    expect(screen.getByText('Open the game and use arrow keys.')).toBeTruthy();
    expect(record?.querySelector('.devteam-run-chevron')?.textContent).toBe('›');
    expect(screen.queryByText('Steering is text-only while the team is running.')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message the lead' })).toBeTruthy();
  });

  it('names lanes by the task so two people in one role stay apart', () => {
    act(() => useApp.setState({
      devTeam: snapshot({
        plan: {
          ...plan,
          milestones: [{
            ...plan.milestones[0],
            tasks: [
              { id: 'controls', title: 'Build controls', roleId: 'build', detail: 'Implement interaction' },
              { id: 'look', title: 'Tune the camera', roleId: 'build', detail: 'Implement framing' },
            ],
          }],
        },
      }),
      devTeamLanes: {},
    }));
    render(<DevTeamPane />);

    const labels = lanes().map((lane) => lane.getAttribute('aria-label'));
    // "Working, Working" until the lane stopped reporting its own status as if
    // it were an observation. A lane with no prose to show falls back to its
    // status for the tail, and that is the word the activity column is already
    // showing, so the fallback said nothing twice.
    expect(labels).toContain('Build controls lane, Gameplay builder, Working');
    expect(labels).toContain('Tune the camera lane, Gameplay builder, Working');
  });

  it('does not report the person\'s own steering note as the lead\'s activity', () => {
    act(() => useApp.setState({
      messages: [{
        id: 'steer-1',
        role: 'user',
        parts: [{ kind: 'text', text: 'Make the jump feel heavier.' }],
        streaming: false,
      }],
      devTeam: snapshot({ steering: [{ ts: '2026-08-01T00:00:00.000Z', text: 'Make the jump feel heavier.' }] }),
    }));
    render(<DevTeamPane />);

    const lead = screen.getByRole('button', { name: /Lead lane/i });
    expect(lead.getAttribute('aria-label')).toBe('Lead lane, Plan and review, Supervising');
  });

  it('says the lead is supervising the build rather than available', () => {
    act(() => useApp.setState({ messages: [] }));
    render(<DevTeamPane />);
    expect(screen.getByRole('button', { name: /Lead lane/i }).getAttribute('aria-label')).toContain('Supervising');

    act(() => useApp.setState({
      messages: [{ ...leadMessage, streaming: true }],
      devTeam: snapshot({ phase: 'reviewing' }),
    }));
    expect(screen.getByRole('button', { name: /Lead lane/i }).getAttribute('aria-label')).toContain('Working');
  });

  it('tells the person a queued steering note was received', () => {
    act(() => useApp.setState({
      devTeam: snapshot({ steering: [{ ts: '2026-08-01T00:00:00.000Z', text: 'Heavier jump.' }] }),
    }));
    const view = render(<DevTeamPane />);
    expect(screen.getByText('One note is queued for the lead. It is folded in at the next review.')).toBeTruthy();

    act(() => useApp.setState({
      devTeam: snapshot({
        steering: [
          { ts: '2026-08-01T00:00:00.000Z', text: 'Heavier jump.' },
          { ts: '2026-08-01T00:01:00.000Z', text: 'Slower fall.' },
        ],
      }),
    }));
    view.rerender(<DevTeamPane />);
    expect(screen.getByText('2 notes are queued for the lead. They are folded in at the next review.')).toBeTruthy();
  });

  it('keeps the whole plan reachable behind one fold', () => {
    render(<DevTeamPane />);
    const fold = screen.getByText('Plan').closest('details');
    expect(fold?.hasAttribute('open')).toBe(false);
    expect(screen.getByText('A first complete pass')).toBeTruthy();
    // What the task asks for is text in the row, not a native title=. As a
    // tooltip it was hover-only: unreachable from the keyboard, absent on
    // touch, and it is the only place the plan explains a one-line title.
    expect(screen.getByText('Implement interaction')).toBeTruthy();
    const item = screen.getAllByText('Build controls').map((node) => node.closest('li')).find(Boolean);
    expect(item?.hasAttribute('title')).toBe(false);
  });

  it('collapses Hearth-authored orchestration instead of dressing it as the user', () => {
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'interviewing', plan: null, tasks: [], approvals: [] }),
      messages: [{
        id: 'orchestration-1',
        role: 'user',
        orchestration: true,
        parts: [{ kind: 'text', text: 'Write the internal plan file.' }],
        streaming: false,
      }],
    }));
    render(<DevTeamPane />);
    expect(screen.getByText('Dev team instruction')).toBeTruthy();
    expect(document.querySelector('.msg-user')).toBeNull();
  });
});
