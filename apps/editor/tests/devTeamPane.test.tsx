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
    // out; the report is read when the engineers have all gone home. The stretch
    // in between is a thing being managed, and wrapping up is the end of it: the
    // build finishing is reported where the work is, on the board.
    const stage = (phase: DevTeamSnapshot['phase'], hasPlan = true) =>
      devTeamStage({ phase, plan: hasPlan ? plan : null });

    expect(stage('idle')).toBe('conversation');
    expect(stage('interviewing')).toBe('conversation');
    expect(stage('spec-review')).toBe('conversation');
    expect(stage('planning', false)).toBe('team');
    expect(stage('building')).toBe('team');
    expect(stage('reviewing')).toBe('team');
    expect(stage('wrapping')).toBe('team');
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
    // Wrapping up is not part of the build. Every engineer has finished by then,
    // and a rail still spinning on Build while every card on the board says
    // Finished is the run's own progress bar contradicting it.
    expect(at({ phase: 'wrapping' } as Partial<DevTeamSnapshot>)).toEqual(['done', 'done', 'done', 'active']);
    expect(at({ phase: 'done' } as Partial<DevTeamSnapshot>)).toEqual(['done', 'done', 'done', 'done']);
  });
});

describe('DevTeamPane', () => {
  it('puts Stop in the box you type into, and nowhere else', () => {
    // The run's controls used to be a pair of buttons on the strip over the
    // conversation, which put its one destructive control somewhere different
    // from the Stop every other conversation in this app has. Stop is where it
    // is everywhere else now, and it stops the RUN: a lead turn the runtime
    // started on its own — planning, review, the report — is exactly the case
    // `chatBusy` cannot see, and exactly the case someone needs to halt.
    for (const phase of ['interviewing', 'drafting-spec'] as const) {
      cleanup();
      act(() => useApp.setState({ devTeam: snapshot({ phase, plan: null, tasks: [] }) } as never));
      render(<DevTeamPane />);
      expect(screen.queryByRole('button', { name: 'Stop dev team' }), phase).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(useApp.getState().stopDevTeam, phase).toHaveBeenCalled();
      (useApp.getState().stopDevTeam as ReturnType<typeof vi.fn>).mockClear();
    }

    // Once there is a team the box is the lead's own, one click in, and Stop
    // is in it there too: the board itself carries no controls.
    cleanup();
    act(() => useApp.setState({ devTeam: snapshot({ phase: 'planning' }) } as never));
    render(<DevTeamPane />);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Lead, Plans the work/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(useApp.getState().stopDevTeam).toHaveBeenCalled();
    (useApp.getState().stopDevTeam as ReturnType<typeof vi.fn>).mockClear();
    // Nothing is running: the box offers Send and nothing to stop.
    for (const phase of ['spec-review', 'done'] as const) {
      cleanup();
      act(() => useApp.setState({ devTeam: snapshot({ phase, plan: null, tasks: [] }) } as never));
      render(<DevTeamPane />);
      expect(screen.queryByRole('button', { name: 'Stop' }), phase).toBeNull();
    }
  });

  it('never interrupts the conversation to ask what to do about a slow turn', () => {
    // A turn running twenty minutes used to raise a bordered warning offering
    // to recover the run or stop it, and it was the loudest thing on screen at
    // the exact moment the screen was meant to be a conversation someone was in
    // the middle of. No chat app does this. You wait, or you press Stop, and
    // Stop is in the box where it is in every other conversation in this app.
    cleanup();
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'interviewing', plan: null, tasks: [], phaseSince: Date.now() - 20 * 60 * 1000 }),
    } as never));
    render(<DevTeamPane />);

    expect(screen.queryByRole('button', { name: /Pick the run back up/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop the run/ })).toBeNull();
    expect(screen.queryByText(/has not finished/)).toBeNull();
    // What is left is the truth and one control: the step, its clock, and Stop.
    expect(screen.getByRole('status', { name: 'Dev team phase' }).textContent).toBe('Interview');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
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

    const lead = screen.getByRole('button', { name: /^Lead, Plans the work/ });
    expect(lead.className).toBe(cardOf('Build controls').className);
    // Named people with real roles, not a task with a robot beside it.
    expect(cardOf('Build controls').getAttribute('aria-label'))
      .toMatch(/^\w+, Gameplay builder, Build controls, Needs you, 1 waiting question$/);
    expect(cardOf('Shape the look').getAttribute('aria-label'))
      .toMatch(/^\w+, Visual maker, Shape the look, Working$/);
    // Nothing on the board is a thing you talk to, so it has no composer.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps every agent that exists on the board, and no task that is not one', () => {
    // A sixteen-task run put sixteen cards on the board, thirteen of them
    // reading QUEUED. A task nobody has been summoned for is not an agent; a
    // finished one is, and how it finished is a status worth showing.
    cleanup();
    act(() => useApp.setState({
      devTeam: snapshot({
        tasks: [
          { taskId: 'controls', engineerId: 'engineer-controls', status: 'done', summary: 'Controls landed.' },
          { taskId: 'look', engineerId: '', status: 'pending' },
        ],
      }),
      devTeamLanes: { 'engineer-controls': [] },
    } as never));
    render(<DevTeamPane />);

    expect(cardOf('Build controls').getAttribute('aria-label')).toContain('Finished');
    expect(screen.queryByRole('button', { name: /Shape the look/ })).toBeNull();
    expect(screen.getByText('1 done')).toBeTruthy();
    expect(screen.getByText('1 of 2 finished')).toBeTruthy();
    // The one nobody is on is still accounted for, in the plan.
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    const planned = screen.getAllByText('Shape the look').map((node) => node.closest('li')).find(Boolean);
    expect(planned?.getAttribute('data-status')).toBe('pending');
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

  it('ticks the steps behind it, burns the one being worked, numbers the rest', () => {
    render(<DevTeamPane />);
    const marks = screen.getAllByRole('listitem').map((item) => ({
      name: item.textContent,
      state: item.getAttribute('data-state'),
      burning: item.querySelector('.flame-mark[data-flame="burn"]') !== null,
    }));

    expect(marks.map((mark) => mark.state)).toEqual(['done', 'done', 'active', 'waiting']);
    expect(marks[2].burning).toBe(true);
    expect(marks[3].name).toContain('4');
    // A parked run has nothing alight, because nothing is running.
    act(() => useApp.setState({ devTeam: snapshot({ phase: 'paused' }) }));
    expect(document.querySelectorAll('.devteam-steps .flame-mark')).toHaveLength(0);
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

  it('runs the clock on a lead turn and not on a build', () => {
    // `building` is the one long phase that is not a single turn: engineers are
    // reporting the whole time, and a counter climbing past two hours beside the
    // word Build would be describing the run as one stuck turn when it is
    // sixteen healthy ones.
    cleanup();
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'building', phaseSince: Date.now() - 2 * 60 * 60 * 1000 }),
    } as never));
    render(<DevTeamPane />);
    expect(document.querySelector('.devteam-strip-clock')).toBeNull();

    cleanup();
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'interviewing', plan: null, tasks: [], phaseSince: Date.now() - 90 * 1000 }),
    } as never));
    render(<DevTeamPane />);
    expect(document.querySelector('.devteam-strip-clock')?.textContent).toBe('1m 30s');
  });

  it('opens a member over the board, and comes back to where you left', () => {
    // The board gives way rather than a log appearing under it. A panel below a
    // board is a preview of a conversation; going INTO somebody is the point.
    render(<DevTeamPane />);
    fireEvent.click(cardOf('Build controls'));

    expect(screen.getByRole('region', { name: /log$/ })).toBeTruthy();
    expect(screen.getAllByText('Wiring movement now.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Lead, Plans the work/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the team' }));
    expect(screen.getByRole('button', { name: /^Lead, Plans the work/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /log$/ })).toBeNull();
  });

  it('puts the ordinary conversation in front of you when you open the lead', () => {
    // A dev team run is an agent using subagents, so going into the lead has to
    // be the ordinary conversation with every ordinary control working.
    render(<DevTeamPane />);
    fireEvent.click(screen.getByRole('button', { name: /^Lead, Plans the work/ }));

    expect(screen.getByRole('region', { name: 'Lead log' }).textContent)
      .toContain('I am reviewing the first pass.');
    expect(screen.getByRole('textbox', { name: 'Message the lead' }).getAttribute('placeholder'))
      .toBe('Message the lead…');
  });

  it('gives the composer to the lead alone, never to the board or an engineer', () => {
    render(<DevTeamPane />);
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(cardOf('Build controls'));
    // An engineer is headless and read-only: the only thing you can answer is
    // an ask inside its own log.
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the team' }));
    fireEvent.click(screen.getByRole('button', { name: /^Lead, Plans the work/ }));
    expect(screen.getByRole('textbox', { name: 'Message the lead' })).toBeTruthy();
  });

  it('keeps you where you are when the member you opened finishes', () => {
    // Finishing is a status, not a disappearance: reading somebody's log must
    // not be interrupted by their last turn ending.
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

    expect(screen.getByRole('region', { name: /log$/ })).toBeTruthy();
    expect(document.querySelector('.devteam-view-state')?.textContent).toBe('Finished');
  });

  it('sends you back to the board if the agent you opened is no longer in the run', () => {
    // Whoever is open can leave the run entirely (a replanned milestone drops
    // its tasks). Falling back in the render rather than in an effect means
    // there is never a frame showing a member who is not there.
    cleanup();
    act(() => useApp.setState({ devTeamLanes: { 'engineer-controls': [], 'engineer-look': [] } } as never));
    const view = render(<DevTeamPane />);
    fireEvent.click(cardOf('Shape the look'));

    act(() => useApp.setState({
      devTeam: snapshot({ tasks: [{ taskId: 'controls', engineerId: 'engineer-controls', status: 'running' }] }),
    }));
    view.rerender(<DevTeamPane />);

    expect(screen.queryByRole('region', { name: /log$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Lead, Plans the work/ })).toBeTruthy();
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

  it('leaves a parked run with a status line and a box, and no controls at all', () => {
    cleanup();
    // Pause and Resume are both gone: every phase Pause applied to has a team,
    // and a parked run is picked back up by being spoken to (devTeamRuntime).
    // What is left is the truth about where the run got to.
    act(() => useApp.setState({ devTeam: snapshot({ phase: 'paused', plan: null, tasks: [] }) } as never));
    render(<DevTeamPane />);

    for (const name of ['Pause dev team', 'Resume dev team', 'Stop dev team', 'Stop']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
    expect(screen.getByRole('status', { name: 'Dev team phase' }).textContent).toBe('Paused');
    expect(screen.getByRole('textbox', { name: 'Message the lead' })).toBeTruthy();
  });

  it('explains that active team steering is text-only, only when a file is offered', () => {
    render(<DevTeamPane />);
    fireEvent.click(screen.getByRole('button', { name: /^Lead, Plans the work/ }));
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

  it('moves the rail onto the last step while the lead writes the report', () => {
    // The run's last visible act is the build finishing, and it used to happen
    // on the one screen with no steps on it: wrapping dropped straight to the
    // transcript, so the rail never moved off Build and the report simply
    // appeared. The board holds until there is a report to show.
    cleanup();
    act(() => useApp.setState({ devTeam: snapshot({ phase: 'wrapping' }) } as never));
    render(<DevTeamPane />);

    expect(screen.getByRole('button', { name: /^Lead, Plans the work/ })).toBeTruthy();
    const steps = [...screen.getByRole('list', { name: 'Dev team progress' }).children];
    expect(steps.map((step) => step.getAttribute('data-state'))).toEqual(['done', 'done', 'done', 'active']);
    expect(steps[3].getAttribute('aria-current')).toBe('step');
  });

  it('returns to the ordinary transcript with the closing handoff already open when done', () => {
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'done', summary: 'A tactile tiny world.', wrap: 'Open the game and use arrow keys.' }),
    }));
    render(<DevTeamPane />);

    // The team has dissolved: there is no board left, only the conversation and
    // the report, with the plan under it carrying what each task came to.
    expect(screen.queryByRole('button', { name: /^Lead, Plans the work/ })).toBeNull();
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

    expect(screen.getByRole('button', { name: /^Lead, Plans the work/ }).getAttribute('aria-label'))
      .toBe('Lead, Plans the work and reviews it, Supervising');
  });

  it('names what the lead is doing rather than saying Supervising for three hours', () => {
    act(() => useApp.setState({ messages: [], devTeam: snapshot({ phase: 'reviewing' }) }));
    render(<DevTeamPane />);
    expect(screen.getByRole('button', { name: /^Lead, Plans the work/ }).getAttribute('aria-label'))
      .toContain('Reviewing');

    act(() => useApp.setState({ messages: [{ ...leadMessage, streaming: true }] }));
    expect(screen.getByRole('button', { name: /^Lead, Plans the work/ }).getAttribute('aria-label'))
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
