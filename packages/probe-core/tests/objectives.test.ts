/**
 * Objectives: sticky achievement, definitive failure, and the refusal to judge
 * what the probe cannot see.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateObjectives,
  makeLiveObjectives,
  objectiveSummary,
  toOutcomes,
  type ObjectiveContext,
  type ProbeEntity,
} from '@hearth/probe-core';

const AVATAR: ProbeEntity = { id: 'avatar', name: 'Avatar', tags: ['player'], x: 0, y: 0, alive: true };
const GOAL: ProbeEntity = { id: 'goal', name: 'Goal', tags: ['goal'], x: 100, y: 0, alive: true };

function ctx(over: Partial<ObjectiveContext> = {}): ObjectiveContext {
  return {
    entities: [AVATAR, GOAL],
    avatarId: 'avatar',
    eventCounts: new Map(),
    instant: { frame: 1 },
    ...over,
  };
}

describe('reach', () => {
  it('achieves when the avatar is inside the tolerance, and stays achieved', () => {
    const live = makeLiveObjectives([{ type: 'reach', target: 'goal', tolerance: 10 }]);
    evaluateObjectives(live, ctx());
    expect(live[0].achievedAt).toBeNull();

    const near = { ...AVATAR, x: 95 };
    evaluateObjectives(live, ctx({ entities: [near, GOAL], instant: { frame: 7 } }));
    expect(live[0].achievedAt).toEqual({ frame: 7 });

    // Sticky: walking away does not un-achieve it.
    evaluateObjectives(live, ctx({ instant: { frame: 9 } }));
    expect(live[0].achievedAt).toEqual({ frame: 7 });
  });

  it('accepts an "x,y" point as a target', () => {
    const live = makeLiveObjectives([{ type: 'reach', target: '4,3', tolerance: 6 }]);
    evaluateObjectives(live, ctx());
    expect(live[0].achievedAt).not.toBeNull();
  });

  it('stays unachieved when there is no entity sense', () => {
    const live = makeLiveObjectives([{ type: 'reach', target: 'goal' }]);
    evaluateObjectives(live, ctx({ entities: null }));
    expect(toOutcomes(live)[0].achieved).toBe(false);
  });
});

describe('survive', () => {
  it('fails the moment its subject dies', () => {
    const live = makeLiveObjectives([{ type: 'survive', frames: 100 }]);
    evaluateObjectives(live, ctx({ entities: [{ ...AVATAR, alive: false }, GOAL] }));
    expect(live[0].failed).toBe(true);
    expect(live[0].achievedAt).toBeNull();
  });

  it('fails when the subject vanishes entirely', () => {
    const live = makeLiveObjectives([{ type: 'survive', target: 'goal', frames: 10 }]);
    evaluateObjectives(live, ctx({ entities: [AVATAR] }));
    expect(live[0].failed).toBe(true);
  });

  it('achieves once the frame target is reached', () => {
    const live = makeLiveObjectives([{ type: 'survive', frames: 10 }]);
    evaluateObjectives(live, ctx({ instant: { frame: 9 } }));
    expect(live[0].achievedAt).toBeNull();
    evaluateObjectives(live, ctx({ instant: { frame: 10 } }));
    expect(live[0].achievedAt).toEqual({ frame: 10 });
  });
});

describe('event and property', () => {
  it('counts cumulative events', () => {
    const live = makeLiveObjectives([{ type: 'event', event: 'coin', count: 3 }]);
    evaluateObjectives(live, ctx({ eventCounts: new Map([['coin', 2]]) }));
    expect(live[0].achievedAt).toBeNull();
    evaluateObjectives(live, ctx({ eventCounts: new Map([['coin', 3]]), instant: { frame: 5 } }));
    expect(live[0].achievedAt).toEqual({ frame: 5 });
  });

  it('compares entity properties', () => {
    const live = makeLiveObjectives([
      { type: 'property', target: 'goal', property: 'alive', equals: false },
      { type: 'property', target: 'goal', property: 'x', greaterThan: 50, lessThan: 150 },
    ]);
    evaluateObjectives(live, ctx());
    expect(live[0].achievedAt).toBeNull();
    expect(live[1].achievedAt).not.toBeNull();

    evaluateObjectives(live, ctx({ entities: [AVATAR, { ...GOAL, alive: false }] }));
    expect(live[0].achievedAt).not.toBeNull();
  });

  it('ignores a property objective with no comparator', () => {
    const live = makeLiveObjectives([{ type: 'property', target: 'goal', property: 'x' }]);
    evaluateObjectives(live, ctx());
    expect(live[0].achievedAt).toBeNull();
  });
});

describe('summaries and outcomes', () => {
  it('describes each objective in one line', () => {
    expect(objectiveSummary({ type: 'reach', target: 'goal', tolerance: 8 })).toBe('reach goal ±8');
    expect(objectiveSummary({ type: 'survive', frames: 300 })).toBe('survive avatar 300f');
    expect(objectiveSummary({ type: 'event', event: 'win', count: 2 })).toBe('event win x2');
    expect(objectiveSummary({ type: 'property', target: 'boss', property: 'alive', equals: false })).toContain(
      'boss.alive',
    );
  });

  it('projects to the contract outcome shape', () => {
    const live = makeLiveObjectives([{ type: 'event', event: 'win' }]);
    evaluateObjectives(live, ctx({ eventCounts: new Map([['win', 1]]), instant: { frame: 4 } }));
    expect(toOutcomes(live)).toEqual([
      { objective: { type: 'event', event: 'win' }, achieved: true, failed: false, achievedAt: { frame: 4 } },
    ]);
  });
});
