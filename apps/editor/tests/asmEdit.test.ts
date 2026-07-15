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
  setConditionOp,
  setConditionValue,
  setParamType,
  opsForParamType,
  draftIssues,
  isDraftComplete,
  humanizeSaveError,
  shouldBlockAsmSave,
  groupTransitions,
  moveTransitionInGroup,
  outgoingCount,
  summarizeTransition,
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

  it('setConditionOp updates only the targeted condition op', () => {
    const draft = setConditionOp(docToDraft(SAMPLE), 0, 0, 'gte');
    expect(draft.transitions[0].conditions[0].op).toBe('gte');
    // untouched fields preserved
    expect(draft.transitions[0].conditions[0]).toEqual({ param: 'speed', op: 'gte', value: 0 });
  });

  it('setConditionValue updates only the targeted condition value', () => {
    const draft = setConditionValue(docToDraft(SAMPLE), 0, 0, 42);
    expect(draft.transitions[0].conditions[0]).toEqual({ param: 'speed', op: 'gt', value: 42 });
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

describe('groupTransitions (L-085 source grouping)', () => {
  // A machine whose flat order interleaves two idle-sourced transitions around
  // an unrelated one — the exact confusing shape the audit reproduced.
  const INTERLEAVED: AsmDraft = {
    params: [{ name: 'moving', type: 'bool', default: false }],
    states: [
      { name: 'idle', animation: 'a', speed: 1 },
      { name: 'walk', animation: 'b', speed: 1 },
    ],
    initial: 'idle',
    transitions: [
      { from: 'idle', to: 'walk', conditions: [{ param: 'moving', op: 'eq', value: true }] }, // 0
      { from: 'walk', to: 'idle', conditions: [{ param: 'moving', op: 'eq', value: false }] }, // 1
      { from: 'idle', to: 'idle', conditions: [], exitTime: 0.5 }, // 2
      { from: 'any', to: 'idle', conditions: [{ param: 'moving', op: 'eq', value: false }] }, // 3
    ],
  };

  it('puts the any group first, then states in declaration order', () => {
    const groups = groupTransitions(INTERLEAVED);
    expect(groups.map((g) => g.from)).toEqual(['any', 'idle', 'walk']);
  });

  it('collects a source’s transitions across non-adjacent flat positions, preserving global index + group position', () => {
    const groups = groupTransitions(INTERLEAVED);
    const idle = groups.find((g) => g.from === 'idle')!;
    expect(idle.items.map((i) => i.index)).toEqual([0, 2]); // flat indices 0 and 2
    expect(idle.items.map((i) => i.groupPos)).toEqual([0, 1]);
    expect(idle.items[0].transition.to).toBe('walk');
    expect(idle.items[1].transition.to).toBe('idle');
  });

  it('lists orphan sources (from a renamed/removed state) after the known states', () => {
    const draft: AsmDraft = {
      ...INTERLEAVED,
      transitions: [...INTERLEAVED.transitions, { from: 'ghost', to: 'idle', conditions: [], exitTime: 0.2 }],
    };
    expect(groupTransitions(draft).map((g) => g.from)).toEqual(['any', 'idle', 'walk', 'ghost']);
  });

  it('outgoingCount matches the group size for each source', () => {
    expect(outgoingCount(INTERLEAVED, 'idle')).toBe(2);
    expect(outgoingCount(INTERLEAVED, 'walk')).toBe(1);
    expect(outgoingCount(INTERLEAVED, 'any')).toBe(1);
    expect(outgoingCount(INTERLEAVED, 'missing')).toBe(0);
  });
});

describe('moveTransitionInGroup (L-085 flat-array mapping)', () => {
  const draft: AsmDraft = {
    params: [{ name: 'moving', type: 'bool', default: false }],
    states: [
      { name: 'idle', animation: 'a', speed: 1 },
      { name: 'walk', animation: 'b', speed: 1 },
    ],
    initial: 'idle',
    transitions: [
      { from: 'idle', to: 'walk', conditions: [], exitTime: 0.1 }, // 0  idle pos 0
      { from: 'walk', to: 'idle', conditions: [], exitTime: 0.2 }, // 1  walk pos 0
      { from: 'idle', to: 'idle', conditions: [], exitTime: 0.3 }, // 2  idle pos 1
    ],
  };

  it('moving idle[1] up to group-pos 0 swaps the two idle slots, leaving the walk transition put', () => {
    const next = moveTransitionInGroup(draft, 2, 0); // flat idx 2 is idle's 2nd; move to group pos 0
    // idle's flat slots are [0, 2]; the two idle transitions swap into those slots.
    expect(next.transitions[0].exitTime).toBe(0.3); // was flat 2 (idle→idle)
    expect(next.transitions[2].exitTime).toBe(0.1); // was flat 0 (idle→walk)
    // the walk transition at flat 1 is untouched (cross-group order preserved).
    expect(next.transitions[1]).toBe(draft.transitions[1]);
  });

  it('the reordered group reads in the new declaration order via groupTransitions', () => {
    const next = moveTransitionInGroup(draft, 2, 0);
    const idle = groupTransitions(next).find((g) => g.from === 'idle')!;
    expect(idle.items.map((i) => i.transition.to)).toEqual(['idle', 'walk']);
    expect(idle.items.map((i) => i.index)).toEqual([0, 2]); // same flat slots, contents swapped
  });

  it('is a referential no-op at the group edges (never marks the draft dirty)', () => {
    expect(moveTransitionInGroup(draft, 0, -1)).toBe(draft); // idle pos 0 up → clamped, unchanged
    expect(moveTransitionInGroup(draft, 2, 5)).toBe(draft); // idle pos 1 down → clamped, unchanged
    expect(moveTransitionInGroup(draft, 1, 3)).toBe(draft); // lone walk transition can't move
  });

  it('does not disturb a third group when reordering another', () => {
    const three: AsmDraft = {
      ...draft,
      states: [...draft.states, { name: 'run', animation: 'c', speed: 1 }],
      transitions: [
        { from: 'idle', to: 'walk', conditions: [], exitTime: 0.1 }, // 0 idle
        { from: 'run', to: 'idle', conditions: [], exitTime: 0.9 }, // 1 run
        { from: 'idle', to: 'run', conditions: [], exitTime: 0.2 }, // 2 idle
      ],
    };
    const next = moveTransitionInGroup(three, 2, 0);
    expect(next.transitions[1]).toBe(three.transitions[1]); // run transition unmoved
    expect(next.transitions[0].to).toBe('run');
    expect(next.transitions[2].to).toBe('walk');
  });
});

describe('summarizeTransition (L-085 at-a-glance sentence)', () => {
  const draft: AsmDraft = {
    params: [
      { name: 'speed', type: 'number', default: 0 },
      { name: 'moving', type: 'bool', default: false },
      { name: 'jump', type: 'trigger' },
    ],
    states: [
      { name: 'walk', animation: 'a', speed: 1 },
      { name: 'run', animation: 'b', speed: 1 },
    ],
    initial: 'walk',
    transitions: [],
  };

  it('renders condition + exit time as a sentence', () => {
    expect(summarizeTransition(draft, { from: 'walk', to: 'run', conditions: [{ param: 'speed', op: 'gt', value: 5 }], exitTime: 0.8 })).toBe(
      'walk → run · when speed > 5 (exit 0.8)',
    );
  });

  it('joins multiple conditions with "and"', () => {
    expect(
      summarizeTransition(draft, {
        from: 'walk',
        to: 'run',
        conditions: [
          { param: 'speed', op: 'gte', value: 3 },
          { param: 'moving', op: 'eq', value: true },
        ],
      }),
    ).toBe('walk → run · when speed ≥ 3 and moving = true');
  });

  it('describes a trigger condition as "fires"', () => {
    expect(summarizeTransition(draft, { from: 'walk', to: 'run', conditions: [{ param: 'jump' }] })).toBe(
      'walk → run · when jump fires',
    );
  });

  it('reads "always" for a conditionless, exit-timeless transition and "· exit" for exit-only', () => {
    expect(summarizeTransition(draft, { from: 'walk', to: 'run', conditions: [] })).toBe('walk → run · always');
    expect(summarizeTransition(draft, { from: 'walk', to: 'run', conditions: [], exitTime: 0.5 })).toBe('walk → run · exit 0.5');
  });

  it('labels the any source as "Any"', () => {
    expect(summarizeTransition(draft, { from: 'any', to: 'walk', conditions: [{ param: 'jump' }] })).toBe(
      'Any → walk · when jump fires',
    );
  });
});

describe('setParamType', () => {
  it('resets the default to a sensible value for the new type', () => {
    let draft = setParamType(docToDraft(SAMPLE), 0, 'bool'); // speed: number -> bool
    expect(draft.params[0]).toEqual({ name: 'speed', type: 'bool', default: false });
    draft = setParamType(draft, 0, 'trigger');
    expect(draft.params[0]).toEqual({ name: 'speed', type: 'trigger' });
  });

  it('migrates dependent conditions to op/value valid for the new type', () => {
    // The idle->run transition gates on speed > 0 (a number condition).
    // Retyping "speed" to bool must not leave the stale gt/0 behind — the
    // condition should be reseeded to a bool-valid op/value.
    const draft = setParamType(docToDraft(SAMPLE), 0, 'bool');
    expect(draft.transitions[0].conditions[0]).toEqual({ param: 'speed', op: 'eq', value: true });
  });

  it('clears op/value from dependent conditions when retyped to trigger', () => {
    const draft = setParamType(docToDraft(SAMPLE), 0, 'trigger');
    expect(draft.transitions[0].conditions[0]).toEqual({ param: 'speed' });
  });

  it('leaves conditions on other params untouched', () => {
    // grounded (bool) is untouched by retyping speed.
    let draft = docToDraft(SAMPLE);
    draft = addCondition(draft, 1); // seeds a fresh condition on "speed" (first param) into run->idle
    draft = setConditionParam(draft, 1, draft.transitions[1].conditions.length - 1, 'grounded');
    const before = draft.transitions[1].conditions.map((c) => ({ ...c }));
    draft = setParamType(draft, 0, 'bool'); // retype speed
    // the grounded condition on transition 1 must be unchanged
    expect(draft.transitions[1].conditions.at(-1)).toEqual(before.at(-1));
  });

  it('a valid draft stays saveable after a type change (no stale invalid combo)', () => {
    const draft = setParamType(docToDraft(SAMPLE), 0, 'bool');
    expect(draftIssues(draft)).toEqual([]);
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

  it('flags a bool-param condition using an ordering operator (server superRefine mirror)', () => {
    // A hand-mangled draft (or a stale one a future edit path fails to migrate):
    // grounded is a bool, but its condition carries op:'gt' — the server rejects
    // this, so draftIssues must catch it before Save rather than after.
    const draft = docToDraft(SAMPLE);
    draft.transitions[0].conditions[0] = { param: 'grounded', op: 'gt', value: true };
    expect(isDraftComplete(draft)).toBe(false);
    expect(draftIssues(draft).some((m) => /bool|only supports|= or ≠/i.test(m))).toBe(true);
  });

  it('does not flag a bool-param condition using eq/neq', () => {
    const draft = docToDraft(SAMPLE);
    draft.transitions[0].conditions[0] = { param: 'grounded', op: 'neq', value: true };
    expect(draftIssues(draft)).toEqual([]);
  });
});

describe('shouldBlockAsmSave (external-edit gate, L-082)', () => {
  // The session's baseline: what the Animator loaded, normalized the same way
  // AnimatorEditor computes `loadedDoc`.
  const loadedDoc = JSON.stringify(draftToDoc(docToDraft(SAMPLE)));

  it('blocks when a raw fs write (no journal/exec) changed the doc on disk', () => {
    // Simulate `echo`/agent editing the .asm.json directly: same doc but
    // idle speed bumped to 9.9 — exactly the audit's live repro.
    const external = JSON.parse(JSON.stringify(SAMPLE)) as StateMachineData;
    external.states[0].speed = 9.9;
    const onDiskJson = JSON.stringify(external, null, 2);
    expect(shouldBlockAsmSave({ overwrite: false, onDiskJson, loadedDoc })).toBe(true);
  });

  it('does not block when the on-disk text is the same doc with different formatting/key order', () => {
    // Re-serialize with different whitespace and reordered keys — must
    // normalize equal through the doc<->draft round-trip.
    const reordered = {
      transitions: SAMPLE.transitions,
      initial: SAMPLE.initial,
      states: SAMPLE.states,
      params: SAMPLE.params,
    };
    const onDiskJson = JSON.stringify(reordered, null, 4);
    expect(shouldBlockAsmSave({ overwrite: false, onDiskJson, loadedDoc })).toBe(false);
  });

  it('does not block when the user already chose Overwrite', () => {
    const external = JSON.parse(JSON.stringify(SAMPLE)) as StateMachineData;
    external.states[0].speed = 9.9;
    const onDiskJson = JSON.stringify(external);
    expect(shouldBlockAsmSave({ overwrite: true, onDiskJson, loadedDoc })).toBe(false);
  });

  it('does not block when the on-disk read failed (cannot compare)', () => {
    expect(shouldBlockAsmSave({ overwrite: false, onDiskJson: null, loadedDoc })).toBe(false);
  });

  it('does not block on unparseable on-disk content', () => {
    expect(shouldBlockAsmSave({ overwrite: false, onDiskJson: '{not json', loadedDoc })).toBe(false);
  });
});

describe('humanizeSaveError', () => {
  it('translates a zod transition/condition path into a plain-language location', () => {
    const raw =
      'Invalid parameters for updateStateMachineAsset: data.transitions.2.conditions.0.op: bool param "spd" conditions only support eq/neq';
    expect(humanizeSaveError(raw)).toBe(
      'Transition 3, condition 1: bool param "spd" conditions only support eq/neq',
    );
  });

  it('translates a state path', () => {
    const raw = 'Invalid parameters for updateStateMachineAsset: data.states.0.animation: Required';
    expect(humanizeSaveError(raw)).toBe('State 1: Required');
  });

  it('keeps the param name for a params-record path', () => {
    const raw =
      'Invalid parameters for updateStateMachineAsset: data.params.spd.default: Expected boolean, received number';
    expect(humanizeSaveError(raw)).toBe('Parameter "spd": Expected boolean, received number');
  });

  it('strips the command prefix even when there is no data path', () => {
    const raw = 'Invalid parameters for updateStateMachineAsset: something went wrong';
    expect(humanizeSaveError(raw)).toBe('something went wrong');
  });

  it('passes a non-schema message through unchanged', () => {
    const raw = 'State "walk" references an unknown animation asset: ast_x';
    expect(humanizeSaveError(raw)).toBe('State "walk" references an unknown animation asset: ast_x');
  });
});
