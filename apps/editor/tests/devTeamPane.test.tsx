// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevTeamPane } from '../src/components/chat/DevTeamPane';
import {
  devTeamActivity,
  devTeamPhaseLabel,
  devTeamStage,
  devTeamStepStates,
  pendingLaneAsk,
  teamNames,
} from '../src/chat/devteam';
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

/** A member's card, found by the task it is on: the NAME is generated, so a
 *  test that hunted for one would be pinning the name table rather than the
 *  board. */
const cardOf = (assignment: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`, ${assignment},`) });

beforeEach(() => {
  // jsdom implements neither showModal nor close; the Plan and Specification
  // dialogs only need them to be open/close toggles.
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) { this.open = true; };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
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

  it('gives every task a stable, unique name without asking anything but its id', () => {
    // Headless engineers with no names read as a queue of robots rather than as
    // people doing work. The names have to survive a reload and a reorder, and
    // two of them must never collide inside one run.
    const ids = ['controls', 'look', 'audio', 'hud', 'waves', 'polish'];
    const first = teamNames(ids);
    expect(new Set(first.values()).size).toBe(ids.length);
    expect(teamNames(ids)).toEqual(first);
    // Adding somebody must not rename everybody who is already on the board.
    const later = teamNames([...ids, 'shipping']);
    for (const id of ids) expect(later.get(id)).toBe(first.get(id));
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

  it('reads the steps off the handshakes a parked run actually finished', () => {
    const at = (over: Partial<DevTeamSnapshot>) => devTeamStepStates({
      phase: 'interrupted', spec: '# Spec', approvals: [{ specVersion: 1, approvedAt: 'x' }], specVersion: 1, ...over,
    } as DevTeamSnapshot);

    // Planning is the stretch where a spec is approved and no plan exists yet,
    // and it is the longest a lead turn ever runs, so it is the state most
    // likely to be looked at. Keying on the plan sent it back to a step it had
    // already finished.
    expect(at({})).toEqual(['done', 'done', 'waiting', 'waiting']);
    expect(at({ approvals: [] })).toEqual(['done', 'waiting', 'waiting', 'waiting']);
    expect(at({ spec: null, approvals: [] })).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    // Nothing turns on a parked run; the one being worked spins only while it is.
    expect(at({ phase: 'building' } as Partial<DevTeamSnapshot>)).toEqual(['done', 'done', 'active', 'waiting']);
    expect(at({ phase: 'done' } as Partial<DevTeamSnapshot>)).toEqual(['done', 'done', 'done', 'done']);
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
    expect(screen.queryByRole('navigation', { name: 'Dev team progress' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message the lead' })).toBeTruthy();
  });

  it('puts the lead above its team in the same card everyone else wears', () => {
    render(<DevTeamPane />);

    const lead = screen.getByRole('button', { name: /^Lead, Tech lead/ });
    expect(lead.className).toBe(cardOf('Build controls').className);
    // Named people with real roles, not a task with a robot beside it.
    expect(cardOf('Build controls').getAttribute('aria-label'))
      .toMatch(/^\w+, Gameplay builder, Build controls, Needs you, 1 waiting question$/);
    expect(cardOf('Shape the look').getAttribute('aria-label'))
      .toMatch(/^\w+, Visual maker, Shape the look, Working$/);
    expect(screen.getByRole('textbox', { name: 'Tell the team' }).getAttribute('placeholder')).toBe('Tell the team…');
  });

  it('keeps only the members still on the job, and leaves the rest in the plan', () => {
    // A sixteen-task run put sixteen cards on the board, thirteen of them
    // reading QUEUED. A queued task is not a person yet and a finished one is
    // not a person any more; both belong in the plan.
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

    expect(screen.queryByRole('button', { name: /Build controls/ })).toBeNull();
    expect(cardOf('Shape the look')).toBeTruthy();
    expect(screen.getByText('1 of 2 finished')).toBeTruthy();
    // Still accounted for: the plan carries the outcome.
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    const planned = screen.getAllByText('Build controls').map((node) => node.closest('li')).find(Boolean);
    expect(planned?.getAttribute('data-status')).toBe('done');
  });

  it('keeps the plan and the specification behind buttons rather than in the way', () => {
    render(<DevTeamPane />);
    // Neither of the loose notes that used to float above the work.
    expect(screen.queryByText(/queued for the lead/)).toBeNull();
    expect(screen.queryByText(/Approved specification/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(screen.getByText('Playable loop')).toBeTruthy();
    // What the task asks for is text in the row, not a hover-only title=.
    expect(screen.getByText('Implement interaction')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Specification' }));
    expect(screen.getByText(/Build a small, tactile world./)).toBeTruthy();
    // Opening one closes the other rather than stacking two dialogs.
    expect(screen.queryByText('Playable loop')).toBeNull();
  });

  it('ticks the steps behind it, spins the one being worked, numbers the rest', () => {
    render(<DevTeamPane />);
    const marks = screen.getAllByRole('listitem').map((item) => ({
      name: item.textContent,
      state: item.getAttribute('data-state'),
      spinning: item.querySelector('.devteam-spin') !== null,
    }));

    expect(marks.map((mark) => mark.state)).toEqual(['done', 'done', 'active', 'waiting']);
    expect(marks[2].spinning).toBe(true);
    expect(marks[3].name).toContain('4');
    // A parked run has nothing turning, because nothing is.
    act(() => useApp.setState({ devTeam: snapshot({ phase: 'paused' }) }));
    expect(document.querySelectorAll('.devteam-steps .devteam-spin')).toHaveLength(0);
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

  it('opens a member over the board, and comes back to where you left', () => {
    // The board gives way rather than a log appearing under it. A panel below a
    // board is a preview of a conversation; going INTO somebody is the point.
    render(<DevTeamPane />);
    fireEvent.click(cardOf('Build controls'));

    expect(screen.getByRole('region', { name: /log$/ })).toBeTruthy();
    expect(screen.getAllByText('Wiring movement now.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Lead, Tech lead/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the team' }));
    expect(screen.getByRole('button', { name: /^Lead, Tech lead/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /log$/ })).toBeNull();
  });

  it('puts the ordinary conversation in front of you when you open the lead', () => {
    // A dev team run is an agent using subagents, so going into the lead has to
    // be the ordinary conversation with every ordinary control working.
    render(<DevTeamPane />);
    fireEvent.click(screen.getByRole('button', { name: /^Lead, Tech lead/ }));

    expect(screen.getByRole('region', { name: 'Lead log' }).textContent)
      .toContain('I am reviewing the first pass.');
    expect(screen.getByRole('textbox', { name: 'Tell the team' })).toBeTruthy();
  });

  it('falls back to the board when the member you opened finishes and leaves', () => {
    // A card can vanish mid-read: the whole point of the board is that members
    // leave when they are done.
    cleanup();
    act(() => useApp.setState({ devTeamLanes: { 'engineer-controls': [], 'engineer-look': [] } } as never));
    const view = render(<DevTeamPane />);
    fireEvent.click(cardOf('Shape the look'));
    expect(screen.getByRole('region', { name: /log$/ })).toBeTruthy();

    act(() => useApp.setState({
      devTeam: snapshot({
        tasks: [
          { taskId: 'controls', engineerId: 'engineer-controls', status: 'running' },
          { taskId: 'look', engineerId: 'engineer-look', status: 'done', summary: 'Sprites done.' },
        ],
      }),
    }));
    view.rerender(<DevTeamPane />);

    expect(screen.queryByRole('region', { name: /log$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Lead, Tech lead/ })).toBeTruthy();
  });

  it('tells you a headless member has reported nothing rather than showing a blank', () => {
    cleanup();
    act(() => useApp.setState({ devTeamLanes: { 'engineer-controls': [], 'engineer-look': [] } } as never));
    render(<DevTeamPane />);

    fireEvent.click(cardOf('Shape the look'));
    expect(screen.getByText(/headless, so whatever it does shows up here/)).toBeTruthy();
  });

  it('marks the member that is blocked and routes its answer to that engineer', () => {
    render(<DevTeamPane />);
    // Findable without reading a word: the count on the board and the badge on
    // the card. Opening it is a decision the person makes, not one the board
    // makes for them by yanking the screen away.
    expect(screen.getByText('1 working · 1 needs you')).toBeTruthy();
    expect(cardOf('Build controls').getAttribute('aria-label')).toContain('1 waiting question');

    fireEvent.click(cardOf('Build controls'));
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
    fireEvent.click(cardOf('Build controls'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Direction' }), { target: { value: 'north' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(useApp.getState().answerEngineerInput).toHaveBeenCalledWith(
      'engineer-controls',
      'input-1',
      'submit',
      { direction: 'north' },
    );
  });

  it('gives keyboard shortcuts only to the blocked ask you are actually looking at', () => {
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
    // A shortcut that answers a question offscreen is worse than no shortcut,
    // so the board itself owns none of them.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useApp.getState().approveEngineer).not.toHaveBeenCalled();

    fireEvent.click(cardOf('Build controls'));
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
    expect(screen.queryByRole('button', { name: /^Lead, Tech lead/ })).toBeNull();
    expect(screen.getAllByText('I am reviewing the first pass.').length).toBeGreaterThan(0);
    const record = screen.getByText(/Run complete/).closest('details');
    expect(record?.hasAttribute('open')).toBe(true);
    expect(screen.getByText('Open the game and use arrow keys.')).toBeTruthy();
    expect(record?.querySelector('.devteam-run-chevron')?.textContent).toBe('›');
    expect(screen.queryByText('Steering is text-only while the team is running.')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message the lead' })).toBeTruthy();
  });

  it('gives two people in one role different names', () => {
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

    const first = cardOf('Build controls').getAttribute('aria-label')!.split(',')[0];
    const second = cardOf('Tune the camera').getAttribute('aria-label')!.split(',')[0];
    expect(first).not.toBe(second);
    expect(cardOf('Tune the camera').getAttribute('aria-label')).toContain('Gameplay builder');
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

    expect(screen.getByRole('button', { name: /^Lead, Tech lead/ }).getAttribute('aria-label'))
      .toBe('Lead, Tech lead, Plans the work and reviews it, Supervising');
  });

  it('names what the lead is doing rather than saying Supervising for three hours', () => {
    act(() => useApp.setState({ messages: [], devTeam: snapshot({ phase: 'reviewing' }) }));
    render(<DevTeamPane />);
    expect(screen.getByRole('button', { name: /^Lead, Tech lead/ }).getAttribute('aria-label'))
      .toContain('Reviewing');

    act(() => useApp.setState({ messages: [{ ...leadMessage, streaming: true }] }));
    expect(screen.getByRole('button', { name: /^Lead, Tech lead/ }).getAttribute('aria-label'))
      .toContain('Working');
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
