/**
 * `StateMachineDataSchema` — the animation state machine asset payload
 * schema (assets/statemachines/<slug>.asm.json). Schema-level tests only;
 * command-level behavior (ASM_ANIMATION_NOT_FOUND, undo, journal) lives in
 * stateMachineCommands.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { StateMachineDataSchema } from '@hearth/core';

/** A minimal but fully valid state machine doc, covering bool/number/trigger
 * params, an exitTime-only transition, and a from:'any' transition. */
function validDoc() {
  return {
    params: {
      alive: { type: 'bool' as const, default: true },
      speed: { type: 'number' as const, default: 0 },
      jump: { type: 'trigger' as const },
    },
    states: [
      { name: 'idle', animation: 'ast_idle', speed: 1 },
      { name: 'run', animation: 'ast_run', speed: 1 },
      { name: 'jumping', animation: 'ast_jump', speed: 1.5 },
    ],
    initial: 'idle',
    transitions: [
      { from: 'idle', to: 'run', conditions: [{ param: 'speed', op: 'gt' as const, value: 0 }] },
      { from: 'run', to: 'idle', conditions: [{ param: 'alive', op: 'eq' as const, value: false }] },
      { from: 'any', to: 'jumping', conditions: [{ param: 'jump' }] },
      { from: 'jumping', to: 'idle', conditions: [], exitTime: 1 },
    ],
  };
}

describe('StateMachineDataSchema', () => {
  it('round-trips a valid doc', () => {
    const doc = validDoc();
    const parsed = StateMachineDataSchema.parse(doc);
    expect(parsed.initial).toBe('idle');
    expect(parsed.states).toHaveLength(3);
    expect(parsed.transitions).toHaveLength(4);
    expect(parsed.params.jump.type).toBe('trigger');
    // defaults default() where params record itself is omitted
    expect(StateMachineDataSchema.parse({ states: [{ name: 'idle', animation: 'a' }], initial: 'idle' })).toEqual({
      params: {},
      states: [{ name: 'idle', animation: 'a', speed: 1 }],
      initial: 'idle',
      transitions: [],
    });
  });

  it('rejects an initial that names no state', () => {
    const doc = { ...validDoc(), initial: 'nonexistent' };
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a transition referencing an unknown "from" state', () => {
    const doc = validDoc();
    doc.transitions[0] = { from: 'ghost', to: 'run', conditions: [{ param: 'speed', op: 'gt', value: 0 }] };
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a transition referencing an unknown "to" state', () => {
    const doc = validDoc();
    doc.transitions[0] = { from: 'idle', to: 'ghost', conditions: [{ param: 'speed', op: 'gt', value: 0 }] };
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a condition referencing an unknown param', () => {
    const doc = validDoc();
    doc.transitions[0].conditions = [{ param: 'notreal', op: 'gt', value: 0 }];
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a trigger condition that specifies op', () => {
    const doc = validDoc();
    doc.transitions[2].conditions = [{ param: 'jump', op: 'eq', value: true } as any];
    const result = StateMachineDataSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a trigger condition that specifies value', () => {
    const doc = validDoc();
    doc.transitions[2].conditions = [{ param: 'jump', value: true } as any];
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a bool condition with an op other than eq/neq', () => {
    const doc = validDoc();
    doc.transitions[1].conditions = [{ param: 'alive', op: 'gt', value: 0 as any }];
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('accepts a bool condition with neq', () => {
    const doc = validDoc();
    doc.transitions[1].conditions = [{ param: 'alive', op: 'neq', value: true }];
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(true);
  });

  it('rejects a non-trigger condition missing op', () => {
    const doc = validDoc();
    doc.transitions[0].conditions = [{ param: 'speed', value: 0 } as any];
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a non-trigger condition missing value', () => {
    const doc = validDoc();
    doc.transitions[0].conditions = [{ param: 'speed', op: 'gt' } as any];
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects duplicate state names', () => {
    const doc = validDoc();
    doc.states.push({ name: 'idle', animation: 'ast_idle2', speed: 1 });
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a transition with no conditions and no exitTime', () => {
    const doc = validDoc();
    doc.transitions[0] = { from: 'idle', to: 'run', conditions: [] };
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('accepts a transition with exitTime and no conditions (non-any from)', () => {
    const doc = validDoc();
    doc.transitions[0] = { from: 'idle', to: 'run', conditions: [], exitTime: 0.5 };
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(true);
  });

  it('rejects a from:"any" transition with no conditions, even with exitTime set', () => {
    const doc = validDoc();
    doc.transitions[2] = { from: 'any', to: 'jumping', conditions: [], exitTime: 0.5 };
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects state speed <= 0', () => {
    const doc = validDoc();
    doc.states[0].speed = 0;
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
    doc.states[0].speed = -1;
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('defaults state speed to 1', () => {
    const doc = validDoc();
    delete (doc.states[0] as any).speed;
    const parsed = StateMachineDataSchema.parse(doc);
    expect(parsed.states[0].speed).toBe(1);
  });

  it('rejects unknown keys (strict)', () => {
    const doc = { ...validDoc(), bogus: true };
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects an empty states array', () => {
    const doc = { ...validDoc(), states: [] };
    expect(StateMachineDataSchema.safeParse(doc).success).toBe(false);
  });
});
