import { describe, it, expect } from 'vitest';
import type { StateMachineData } from '@hearth/core';
import {
  docToDraft,
  draftToDoc,
  savePayload,
  addParam,
  removeParam,
  renameParam,
  addState,
  removeState,
  addTransition,
  removeTransition,
  addCondition,
  removeCondition,
  setConditionParam,
  opsForParamType,
  draftIssues,
  isDraftComplete,
  type AsmDraft,
} from '../src/asmEdit';

const SAMPLE: StateMachineData = {
  params: {
    speed: { type: 'number', default: 0 },
    grounded: { type: 'bool', default: true },
    jump: { type: 'trigger' },
  },
  states: [
    { name: 'idle', animation: 'anim-idle', speed: 1 },
    { name: 'run', animation: 'anim-run', speed: 1.5 },
  ],
  initial: 'idle',
  transitions: [
    { from: 'idle', to: 'run', conditions: [{ param: 'speed', op: 'gt', value: 0 }] },
    { from: 'run', to: 'idle', conditions: [{ param: 'jump' }], exitTime: 0.5 },
  ],
};

describe('docToDraft / draftToDoc round-trip', () => {
  it('converts the params record into an ordered array and back', () => {
    const draft = docToDraft(SAMPLE);
    expect(draft.params.map((p) => p.name)).toEqual(['speed', 'grounded', 'jump']);
    expect(draft.params[0]).toEqual({ name: 'speed', type: 'number', default: 0 });
    expect(draft.params[2]).toEqual({ name: 'jump', type: 'trigger' });
    expect(draftToDoc(draft)).toEqual(SAMPLE);
  });

  it('drops op/value from trigger conditions in the saved doc', () => {
    const draft = docToDraft(SAMPLE);
    // A trigger condition that somehow carries stale op/value must serialize clean.
    draft.transitions[1].conditions[0] = { param: 'jump', op: 'eq', value: true };
    const doc = draftToDoc(draft);
    expect(doc.transitions[1].conditions[0]).toEqual({ param: 'jump' });
  });

  it('omits an absent param default rather than writing default: undefined', () => {
    const draft = docToDraft(SAMPLE);
    const doc = draftToDoc(draft);
    expect(Object.prototype.hasOwnProperty.call(doc.params.jump, 'default')).toBe(false);
  });

  it('savePayload wraps the doc with the asset id', () => {
    const draft = docToDraft(SAMPLE);
    expect(savePayload('asm-1', draft)).toEqual({ assetId: 'asm-1', data: draftToDoc(draft) });
  });
});

describe('params', () => {
  it('addParam appends a uniquely-named bool param', () => {
    const draft = addParam(docToDraft(SAMPLE));
    expect(draft.params).toHaveLength(4);
    const added = draft.params[3];
    expect(added.type).toBe('bool');
    expect(draft.params.filter((p) => p.name === added.name)).toHaveLength(1);
  });

  it('renameParam updates every dependent condition to the new name', () => {
    const draft = renameParam(docToDraft(SAMPLE), 0, 'velocity');
    expect(draft.params[0].name).toBe('velocity');
    expect(draft.transitions[0].conditions[0].param).toBe('velocity');
  });

  it('removeParam drops conditions that referenced it', () => {
    const draft = removeParam(docToDraft(SAMPLE), 0);
    expect(draft.params.map((p) => p.name)).toEqual(['grounded', 'jump']);
    // The idle->run transition's only condition referenced "speed" and is gone.
    expect(draft.transitions[0].conditions).toHaveLength(0);
    // The run->idle transition kept its trigger condition.
    expect(draft.transitions[1].conditions).toHaveLength(1);
  });
});

describe('states', () => {
  it('addState appends a state and makes it initial when it is the first', () => {
    const empty: AsmDraft = { params: [], states: [], initial: '', transitions: [] };
    const draft = addState(empty);
    expect(draft.states).toHaveLength(1);
    expect(draft.initial).toBe(draft.states[0].name);
  });

  it('removeState drops transitions referencing that state', () => {
    const draft = removeState(docToDraft(SAMPLE), 1); // remove "run"
    expect(draft.states.map((s) => s.name)).toEqual(['idle']);
    // Both sample transitions touched "run" (as to, then as from) — both gone.
    expect(draft.transitions).toHaveLength(0);
  });

  it('removing the initial state clears initial to force a re-choice', () => {
    const draft = removeState(docToDraft(SAMPLE), 0); // remove "idle" (initial)
    expect(draft.states.map((s) => s.name)).toEqual(['run']);
    expect(draft.initial).toBe('');
  });
});

describe('transitions & conditions', () => {
  it('opsForParamType scopes operators to the param type', () => {
    expect(opsForParamType('bool')).toEqual(['eq', 'neq']);
    expect(opsForParamType('number')).toEqual(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
    expect(opsForParamType('trigger')).toEqual([]);
  });

  it('addCondition seeds op/value from the first param type', () => {
    const draft = addCondition(docToDraft(SAMPLE), 0);
    const cond = draft.transitions[0].conditions.at(-1)!;
    expect(cond.param).toBe('speed'); // first param, a number
    expect(cond.op).toBe('eq');
    expect(cond.value).toBe(0);
  });

  it('setConditionParam resets op/value when switching to a trigger param', () => {
    let draft = addCondition(docToDraft(SAMPLE), 0);
    const cIndex = draft.transitions[0].conditions.length - 1;
    draft = setConditionParam(draft, 0, cIndex, 'jump'); // trigger
    const cond = draft.transitions[0].conditions[cIndex];
    expect(cond).toEqual({ param: 'jump' });
  });

  it('setConditionParam seeds a bool param with an eq/true default', () => {
    let draft = addCondition(docToDraft(SAMPLE), 0);
    const cIndex = draft.transitions[0].conditions.length - 1;
    draft = setConditionParam(draft, 0, cIndex, 'grounded');
    expect(draft.transitions[0].conditions[cIndex]).toEqual({ param: 'grounded', op: 'eq', value: true });
  });

  it('addTransition / removeTransition add and drop rows', () => {
    let draft = addTransition(docToDraft(SAMPLE));
    expect(draft.transitions).toHaveLength(3);
    draft = removeTransition(draft, 2);
    expect(draft.transitions).toHaveLength(2);
  });

  it('removeCondition drops a single condition row', () => {
    const draft = removeCondition(docToDraft(SAMPLE), 0, 0);
    expect(draft.transitions[0].conditions).toHaveLength(0);
  });
});

describe('completeness gating', () => {
  it('a well-formed sample draft is complete', () => {
    const draft = docToDraft(SAMPLE);
    expect(draftIssues(draft)).toEqual([]);
    expect(isDraftComplete(draft)).toBe(true);
  });

  it('flags a transition with neither condition nor exitTime', () => {
    const draft = docToDraft(SAMPLE);
    draft.transitions[0].conditions = [];
    draft.transitions[0].exitTime = undefined;
    const issues = draftIssues(draft);
    expect(issues.some((m) => /condition|exit/i.test(m))).toBe(true);
    expect(isDraftComplete(draft)).toBe(false);
  });

  it('flags a missing initial state', () => {
    const draft = docToDraft(SAMPLE);
    draft.initial = '';
    expect(isDraftComplete(draft)).toBe(false);
    expect(draftIssues(draft).some((m) => /initial/i.test(m))).toBe(true);
  });

  it('flags a state with no animation', () => {
    const draft = docToDraft(SAMPLE);
    draft.states[0].animation = '';
    expect(isDraftComplete(draft)).toBe(false);
    expect(draftIssues(draft).some((m) => /animation/i.test(m))).toBe(true);
  });

  it('flags an empty machine with no states', () => {
    const empty: AsmDraft = { params: [], states: [], initial: '', transitions: [] };
    expect(isDraftComplete(empty)).toBe(false);
    expect(draftIssues(empty).some((m) => /state/i.test(m))).toBe(true);
  });

  it("flags a from:'any' transition that has no conditions", () => {
    const draft = docToDraft(SAMPLE);
    draft.transitions.push({ from: 'any', to: 'idle', conditions: [], exitTime: 0.5 });
    expect(isDraftComplete(draft)).toBe(false);
    expect(draftIssues(draft).some((m) => /any/i.test(m))).toBe(true);
  });

  it('flags a duplicate state name', () => {
    const draft = docToDraft(SAMPLE);
    draft.states[1].name = 'idle';
    expect(isDraftComplete(draft)).toBe(false);
    expect(draftIssues(draft).some((m) => /duplicate/i.test(m))).toBe(true);
  });
});
