import { describe, expect, it } from 'vitest';
import { devTeamPlanSchema, type DevTeamPlan } from '../server/devTeamStore';

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
