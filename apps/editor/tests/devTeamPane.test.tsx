// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevTeamPane } from '../src/components/chat/DevTeamPane';
import { devTeamActivity, devTeamPhaseLabel, pendingLaneAsk } from '../src/chat/devteam';
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
  plan,
  tasks: [
    { taskId: 'controls', engineerId: 'engineer-controls', status: 'running', files: ['src/input.ts'] },
    { taskId: 'look', engineerId: 'engineer-look', status: 'done', summary: 'Finished two sprites.' },
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
    expect(devTeamActivity(engineerLane)).toBe('Waiting for you');
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
});

describe('DevTeamPane', () => {
  it('renders a lead-first calm board with milestone and engineer status', () => {
    render(<DevTeamPane />);

    expect(screen.getByRole('status', { name: 'Dev team phase' }).textContent).toContain('Build');
    const lanes = screen.getAllByRole('button', { name: /lane/i });
    expect(lanes[0].textContent).toContain('Lead');
    expect(screen.getByText('Playable loop')).toBeTruthy();
    expect(screen.getAllByText('Build controls').length).toBeGreaterThan(0);
    const engineer = screen.getByRole('button', { name: /Gameplay builder lane/i });
    expect(engineer.getAttribute('aria-expanded')).toBe('false');
    expect(engineer.getAttribute('aria-label')).toBe(
      'Gameplay builder lane, Build controls, Waiting for you, Wiring movement now., 1 waiting question',
    );
    expect(screen.getByText('Waiting for you')).toBeTruthy();
    expect(screen.getByText(/Ask mode pauses engineers/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Tell the team' }).getAttribute('placeholder')).toBe('Tell the team…');
  });

  it('expands engineer activity and routes asks to that engineer only', () => {
    render(<DevTeamPane />);
    fireEvent.click(screen.getByRole('button', { name: /Gameplay builder lane/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /Gameplay builder lane/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /Gameplay builder lane/i }));
    fireEvent.click(screen.getByRole('button', { name: /Visual maker lane/i }));
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
    render(<DevTeamPane />);
    const lead = screen.getByRole('button', { name: /Lead lane/i });
    const composer = screen.getByRole('textbox', { name: 'Tell the team' });
    composer.focus();
    expect(lead.getAttribute('aria-expanded')).toBe('false');

    act(() => useApp.setState({ devTeam: snapshot({ phase: 'reviewing' }) }));

    expect(lead.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(composer);
  });

  it('explains that active team steering is text-only', () => {
    render(<DevTeamPane />);
    expect(screen.getByText('Dev team steering is text-only. Files are available when the run is done.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    expect(screen.getByRole('menuitem', { name: 'Add photos & files…' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('shows the spec as the one primary decision and keeps revision messaging live', () => {
    act(() => useApp.setState({ devTeam: snapshot({ phase: 'spec-review', plan: null, tasks: [], approvals: [] }) }));
    render(<DevTeamPane />);

    expect(screen.getByRole('region', { name: 'Specification' }).textContent).toContain('Tiny world');
    fireEvent.click(screen.getByRole('button', { name: 'Approve & build' }));
    expect(useApp.getState().approveDevTeamSpec).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Message the lead' }).getAttribute('placeholder')).toBe('Describe a revision…');
  });

  it('settles an approved spec to a one-line record during planning and build', () => {
    act(() => useApp.setState({ devTeam: snapshot({ phase: 'planning' }) }));
    render(<DevTeamPane />);
    expect(screen.getByText('Approved specification v1')).toBeTruthy();
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
  });

  it('returns to the ordinary transcript with a compact reopenable run record when done', () => {
    act(() => useApp.setState({
      devTeam: snapshot({ phase: 'done', summary: 'A tactile tiny world.', wrap: 'Open the game and use arrow keys.' }),
    }));
    render(<DevTeamPane />);

    expect(screen.getAllByText('I am reviewing the first pass.').length).toBeGreaterThan(0);
    const record = screen.getByText(/Run complete/).closest('details');
    expect(record?.hasAttribute('open')).toBe(false);
    expect(record?.querySelector('.devteam-run-chevron')?.textContent).toBe('›');
    expect(screen.queryByText('Dev team steering is text-only. Files are available when the run is done.')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message the lead' })).toBeTruthy();
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
