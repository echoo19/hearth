import { describe, expect, it } from 'vitest';
import { devTeamPlanSchema, type DevTeamPlan, type DevTeamTaskRecord } from '../server/devTeamStore';
import {
  buildEngineerPrompt,
  buildInterviewPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildWrapPrompt,
  formatPlanIssues,
} from '../server/devTeamPrompts';

const plan = (): DevTeamPlan => ({
  version: 1,
  roles: [
    { id: 'gameplay', name: 'Gameplay engineer', focus: 'Player rules and feel' },
    { id: 'art', name: 'Visual engineer', focus: 'Readable presentation' },
  ],
  milestones: [
    {
      id: 'foundation',
      title: 'Playable foundation',
      goal: 'Make the core interaction playable',
      tasks: [
        {
          id: 'movement',
          title: 'Build movement',
          roleId: 'gameplay',
          detail: 'Implement the player movement rules.',
          scope: ['src/player.ts'],
          effort: 'medium',
        },
        {
          id: 'presentation',
          title: 'Add presentation',
          roleId: 'art',
          detail: 'Make the playfield readable.',
          dependsOn: ['movement'],
          scope: ['src/render'],
          effort: 'low',
        },
      ],
    },
    {
      id: 'finish',
      title: 'Finish',
      goal: 'Complete the playable loop',
      tasks: [
        {
          id: 'loop',
          title: 'Complete the loop',
          roleId: 'gameplay',
          detail: 'Add the end condition and restart.',
          dependsOn: ['movement', 'presentation'],
          scope: ['src/game.ts'],
          effort: 'high',
        },
      ],
    },
  ],
});

describe('devTeamPlanSchema', () => {
  it('accepts the literal version-one plan shape without changing it', () => {
    const literal = plan();
    expect(devTeamPlanSchema.parse(literal)).toEqual(literal);
  });

  it('bounds a team at six roles', () => {
    const literal = plan();
    literal.roles = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, name: `Role ${i}`, focus: `Focus ${i}` }));
    expect(devTeamPlanSchema.safeParse(literal).success).toBe(false);
  });

  it('requires globally unique task ids and known role ids', () => {
    const duplicate = plan();
    duplicate.milestones[1].tasks[0].id = 'movement';
    expect(devTeamPlanSchema.safeParse(duplicate).success).toBe(false);

    const unknownRole = plan();
    unknownRole.milestones[0].tasks[0].roleId = 'nobody';
    expect(devTeamPlanSchema.safeParse(unknownRole).success).toBe(false);
  });

  it('requires known dependencies and rejects self-dependencies and cycles', () => {
    const unknown = plan();
    unknown.milestones[0].tasks[1].dependsOn = ['missing'];
    expect(devTeamPlanSchema.safeParse(unknown).success).toBe(false);

    const self = plan();
    self.milestones[0].tasks[0].dependsOn = ['movement'];
    expect(devTeamPlanSchema.safeParse(self).success).toBe(false);

    const cycle = plan();
    cycle.milestones[0].tasks[0].dependsOn = ['presentation'];
    expect(devTeamPlanSchema.safeParse(cycle).success).toBe(false);
  });

  it('does not let an earlier milestone depend on a later milestone', () => {
    const literal = plan();
    literal.milestones[0].tasks[0].dependsOn = ['loop'];
    expect(devTeamPlanSchema.safeParse(literal).success).toBe(false);
  });

  it('accepts only safe normalized relative scope paths', () => {
    for (const safe of ['src', 'src/player.ts', 'assets/ui/button.png']) {
      const literal = plan();
      literal.milestones[0].tasks[0].scope = [safe];
      expect(devTeamPlanSchema.safeParse(literal).success, safe).toBe(true);
    }

    for (const unsafe of ['', '.', './src', '../src', 'src/../secret', '/tmp/file', 'src//player.ts', 'src\\player.ts', 'C:\\game\\file']) {
      const literal = plan();
      literal.milestones[0].tasks[0].scope = [unsafe];
      expect(devTeamPlanSchema.safeParse(literal).success, unsafe).toBe(false);
    }
  });
});

const record = (over: Partial<DevTeamTaskRecord> & { taskId: string }): DevTeamTaskRecord => ({
  engineerId: `engineer-${over.taskId}`,
  status: 'done',
  ...over,
});

const engineerInput = (scope?: string[]) => ({
  spec: 'The approved specification.',
  role: plan().roles[0],
  task: { ...plan().milestones[0].tasks[0], scope },
  dependencies: [record({ taskId: 'movement', summary: 'Movement lands on tiles.', files: ['src/player.ts'] })],
  context: '',
});

describe('the plan prompt', () => {
  it('shows the shape the runtime will validate', () => {
    const prompt = buildPlanPrompt('chat-1', 'Build the thing.');
    expect(prompt).toContain('Unknown keys are rejected');
    expect(prompt).toContain('"version": 1');
    expect(prompt).toContain('"roles"');
    expect(prompt).toContain('"dependsOn"');
    expect(prompt).toContain('"roleId"');
    expect(prompt).toContain('"goal"');
    expect(prompt).toContain('dependsOn, scope and effort are optional');
    expect(prompt).toContain('at most 6 roles');
    expect(prompt).toContain('at most 100 tasks per milestone');
    expect(prompt).toContain('.hearth/devteam/chat-1/plan.json');
  });

  it('quotes an id pattern the schema agrees with', () => {
    const quoted = buildPlanPrompt('chat-1', 'Build the thing.').match(/\/(\^[^\s/]*\$)\//);
    expect(quoted, 'the plan prompt no longer quotes an id pattern').not.toBeNull();
    const pattern = new RegExp(quoted![1]);

    for (const id of ['ok', 'ok.1', 'a-b_c', 'A9', '', '-bad', 'bad id', '.hidden', `a${'b'.repeat(128)}`]) {
      const literal = plan();
      literal.milestones[1].tasks[0].id = id;
      expect(pattern.test(id), id || '(empty)').toBe(devTeamPlanSchema.safeParse(literal).success);
    }
  });

  it('tells the lead that each task is run by an agent that knows nothing about the others', () => {
    const prompt = buildPlanPrompt('chat-1', 'Build the thing.');
    expect(prompt).toContain('no memory of the others');
    expect(prompt).toContain('in the handoff of a task it declares in dependsOn');
    expect(prompt).toContain('omitting scope serializes the whole run');
  });

  it('carries queued steering into the planning turn', () => {
    expect(buildPlanPrompt('chat-1', 'spec', 'Keep it small.')).toContain('Keep it small.');
    expect(buildPlanPrompt('chat-1', 'spec')).not.toContain('New direction from the person');
  });
});

describe('the interview prompt', () => {
  it('says who reads the specification and where it goes, without dictating its shape', () => {
    const prompt = buildInterviewPrompt('chat-1', 'Make me something.');
    expect(prompt).toContain('look at the project folder');
    // The lead has to know its audience and its budget...
    expect(prompt).toMatch(/approves it.*planner|planner.*approves it/);
    expect(prompt).toContain('this run will actually build');
    expect(prompt).toContain('.hearth/devteam/chat-1/spec.md');
    expect(prompt).toContain('Make me something.');
    // ...and must be left to choose the form. A section list here would decide
    // the shape of every specification Hearth ever writes, and pinning one in a
    // test locks the next edit out of changing it. Ban the shape, check the
    // intent — the same rule the website's contract tests had to learn.
    expect(prompt).toContain('shape it however suits this project');
    expect(prompt).not.toMatch(/Write it as:|first section|in this order|the following sections/i);
  });

  it('asks the lead to contribute taste, and scales the interview to what is missing', () => {
    const prompt = buildInterviewPrompt('chat-1', 'make me a game');
    expect(prompt).toContain('in proportion to what is missing');
    expect(prompt).toContain('two or three concrete and genuinely different options');
    expect(prompt).toContain('changing its shape');
    // The push for a fuller interview must not become a push toward a house
    // style: the options come from the person's idea, not from a stock list.
    expect(prompt).toContain('never out of a template');
  });

  it('keeps the standing rule against assuming the kind of project', () => {
    expect(buildInterviewPrompt('chat-1', 'Make me something.')).toContain(
      'Do not assume a genre, dimension, engine, role, or input method.',
    );
  });
});

describe('the engineer prompt', () => {
  it('turns a declared scope into a constraint', () => {
    const prompt = buildEngineerPrompt(engineerInput(['src/player.ts', 'src/input.ts']));
    expect(prompt).toContain('Files you may create or change: src/player.ts, src/input.ts. Do not write outside them.');
    expect(prompt).not.toContain('runs exclusively');
  });

  it('gives an unscoped task a rule instead of a scheduler note', () => {
    const prompt = buildEngineerPrompt(engineerInput());
    expect(prompt).toContain('No files were reserved for this task');
    expect(prompt).toContain('prefer creating new files over editing shared ones');
    expect(prompt).not.toContain('exclusively');
  });

  it('asks for a check that was actually run and forbids claiming one that was not', () => {
    const prompt = buildEngineerPrompt(engineerInput(['src/player.ts']));
    expect(prompt).toContain('Before finishing, check your own work');
    expect(prompt).toContain('a script in package.json');
    expect(prompt).toContain('what you actually ran and what it said');
    expect(prompt).toContain('Do not claim results you did not observe.');
  });

  it('passes dependency handoffs through and marks an empty context', () => {
    const prompt = buildEngineerPrompt(engineerInput(['src/player.ts']));
    expect(prompt).toContain('- movement: Movement lands on tiles.; files: src/player.ts');
    expect(prompt).toContain('No earlier task handoffs yet.');
  });
});

describe('the review prompt', () => {
  it('carries the milestone goal, not just its title', () => {
    const prompt = buildReviewPrompt(plan(), 0, [record({ taskId: 'movement' })]);
    expect(prompt).toContain('Review milestone 1: Playable foundation.');
    expect(prompt).toContain('Its goal: Make the core interaction playable');
  });

  it('offers remediation for the current milestone only when a task failed', () => {
    const failed = buildReviewPrompt(plan(), 0, [
      record({ taskId: 'movement', status: 'error', summary: 'The driver stopped.' }),
      record({ taskId: 'presentation' }),
    ]);
    expect(failed).toContain('These tasks failed: movement.');
    expect(failed).toContain('add remediation tasks to this milestone');
    expect(failed).toContain('- movement [error]: The driver stopped.');

    const clean = buildReviewPrompt(plan(), 0, [record({ taskId: 'movement' }), record({ taskId: 'presentation' })]);
    expect(clean).toContain('None failed, so amend later milestones only.');
  });

  it('reports only the reviewed milestone and says so when nothing was observed', () => {
    const prompt = buildReviewPrompt(plan(), 0, [record({ taskId: 'loop', summary: 'Later milestone.' })]);
    expect(prompt).toContain('- No task outcome was observed.');
    expect(prompt).not.toContain('Later milestone.');
  });
});

describe('the wrap prompt', () => {
  it('lists every task outcome and refuses to let a failure read as finished', () => {
    const prompt = buildWrapPrompt(plan(), '', [
      record({ taskId: 'movement', summary: 'Movement works.', files: ['src/player.ts'] }),
      record({ taskId: 'presentation', status: 'error', summary: 'The renderer never compiled.' }),
      record({ taskId: 'loop', status: 'interrupted' }),
    ]);
    expect(prompt).toContain('- presentation [error]: The renderer never compiled.');
    expect(prompt).toContain('- loop [interrupted]: no completed prose observed');
    expect(prompt).toContain('- movement [done]: Movement works.; observed files: src/player.ts');
    expect(prompt).toContain('Report failed or interrupted tasks honestly; do not describe them as finished.');
    expect(prompt).toContain('The plan contained 2 milestones.');
  });

  it('still reads sensibly when no task record is passed', () => {
    const prompt = buildWrapPrompt(plan());
    expect(prompt).toContain('- No task outcome was recorded.');
    expect(prompt).toContain('do not invent verification results');
  });
});

describe('formatPlanIssues', () => {
  it('names the failing field so a repair turn has something to act on', () => {
    expect(formatPlanIssues([{ path: ['milestones', 0, 'tasks'], message: 'Required' }])).toBe(
      'milestones.0.tasks: Required',
    );
  });

  it('joins several issues and keeps a pathless issue readable', () => {
    expect(
      formatPlanIssues([
        { path: [], message: 'Task ids must be unique.' },
        { path: ['roles', 1, 'focus'], message: 'Required' },
      ]),
    ).toBe('Task ids must be unique.; roles.1.focus: Required');
  });
});
