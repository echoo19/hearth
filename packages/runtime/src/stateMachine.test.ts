/**
 * Pure AnimationStateMachine stepper goldens: transition evaluation
 * (bool/number/trigger conditions, exitTime gating, any-state, declaration
 * order, explicit-before-any, self-transition), trigger consumption + latch,
 * clip advance with speed scaling, non-loop clip end, and determinism. Plus
 * the param mutation helpers backing ctx.animator (type/unknown errors).
 */
import { describe, it, expect } from 'vitest';
import type { AnimationData, AnimationStateMachineComponent, StateMachineData } from '@hearth/core';
import { StateMachineDataSchema } from '@hearth/core';
import {
  createSmState,
  stepStateMachine,
  setSmParam,
  getSmParam,
  fireSmTrigger,
  type SmState,
} from './stateMachine.js';

const DT = 1 / 60;

/** Two-frame clips (0.1s/frame) so 6 fixed steps advance one frame. */
const anims = (): Map<string, AnimationData> =>
  new Map<string, AnimationData>([
    ['idle', { frames: ['idle0', 'idle1'], frameDuration: 0.1, loop: true }],
    ['walk', { frames: ['walk0', 'walk1', 'walk2'], frameDuration: 0.1, loop: true }],
    ['run', { frames: ['run0', 'run1'], frameDuration: 0.1, loop: true }],
    ['jump', { frames: ['jump0', 'jump1'], frameDuration: 0.1, loop: false }],
    ['attack', { frames: ['atk0', 'atk1', 'atk2', 'atk3'], frameDuration: 0.1, loop: false }],
  ]);

function parse(data: unknown): StateMachineData {
  return StateMachineDataSchema.parse(data);
}

const comp = (playing = true): AnimationStateMachineComponent => ({ assetId: 'sm', playing });

function stepN(
  sm: SmState,
  component: AnimationStateMachineComponent,
  asset: StateMachineData,
  clips: Map<string, AnimationData>,
  n: number,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = stepStateMachine(sm, component, asset, clips, DT);
    out.push(r ? r.assetId : 'null');
  }
  return out;
}

describe('stateMachine stepper — conditions', () => {
  it('takes a bool-condition transition when the param becomes true', () => {
    const asset = parse({
      params: { moving: { type: 'bool' } },
      states: [
        { name: 'idle', animation: 'idle' },
        { name: 'walk', animation: 'walk' },
      ],
      initial: 'idle',
      transitions: [{ from: 'idle', to: 'walk', conditions: [{ param: 'moving', op: 'eq', value: true }] }],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    stepStateMachine(sm, comp(), asset, clips, DT);
    expect(sm.current).toBe('idle'); // moving still false
    setSmParam(sm, asset, 'moving', true);
    stepStateMachine(sm, comp(), asset, clips, DT);
    expect(sm.current).toBe('walk');
  });

  it('evaluates number-condition operators (gt)', () => {
    const asset = parse({
      params: { speed: { type: 'number', default: 0 } },
      states: [
        { name: 'idle', animation: 'idle' },
        { name: 'run', animation: 'run' },
      ],
      initial: 'idle',
      transitions: [{ from: 'idle', to: 'run', conditions: [{ param: 'speed', op: 'gt', value: 5 }] }],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    setSmParam(sm, asset, 'speed', 5);
    stepStateMachine(sm, comp(), asset, clips, DT);
    expect(sm.current).toBe('idle'); // 5 is not > 5
    setSmParam(sm, asset, 'speed', 6);
    stepStateMachine(sm, comp(), asset, clips, DT);
    expect(sm.current).toBe('run');
  });

  it('number-condition defaults come from the param default', () => {
    const asset = parse({
      params: { hp: { type: 'number', default: 3 } },
      states: [
        { name: 'a', animation: 'idle' },
        { name: 'b', animation: 'walk' },
      ],
      initial: 'a',
      transitions: [{ from: 'a', to: 'b', conditions: [{ param: 'hp', op: 'lte', value: 0 }] }],
    });
    const sm = createSmState(asset, 'sm');
    expect(getSmParam(sm, asset, 'hp')).toBe(3);
    stepStateMachine(sm, comp(), asset, anims(), DT);
    expect(sm.current).toBe('a');
  });

  it('takes a trigger transition and consumes only that trigger', () => {
    const asset = parse({
      params: { jump: { type: 'trigger' } },
      states: [
        { name: 'idle', animation: 'idle' },
        { name: 'jumping', animation: 'jump' },
      ],
      initial: 'idle',
      transitions: [{ from: 'idle', to: 'jumping', conditions: [{ param: 'jump' }] }],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    fireSmTrigger(sm, asset, 'jump');
    expect(sm.triggers.has('jump')).toBe(true);
    stepStateMachine(sm, comp(), asset, clips, DT);
    expect(sm.current).toBe('jumping');
    expect(sm.triggers.has('jump')).toBe(false); // consumed by the taken transition
  });
});

describe('stateMachine stepper — exitTime', () => {
  it('gates a transition until clip progress reaches exitTime', () => {
    const asset = parse({
      params: {},
      states: [
        { name: 'attack', animation: 'attack' },
        { name: 'idle', animation: 'idle' },
      ],
      initial: 'attack',
      transitions: [{ from: 'attack', to: 'idle', exitTime: 0.9 }],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    // attack: 4 frames * 0.1s = 0.4s total; exitTime 0.9 -> ~0.36s in.
    stepN(sm, comp(), asset, clips, 18); // 0.30s -> progress 0.75 < 0.9
    expect(sm.current).toBe('attack');
    stepN(sm, comp(), asset, clips, 6); // 0.36s -> progress 0.9
    expect(sm.current).toBe('idle');
  });

  it('non-looping clip that has finished reports progress 1 (exitTime 1 fires)', () => {
    const asset = parse({
      params: {},
      states: [
        { name: 'jump', animation: 'jump' },
        { name: 'idle', animation: 'idle' },
      ],
      initial: 'jump',
      transitions: [{ from: 'jump', to: 'idle', exitTime: 1 }],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    // jump: 2 frames * 0.1s = 0.2s; runs to the end, then exitTime 1 fires.
    stepN(sm, comp(), asset, clips, 6); // progress 0.5
    expect(sm.current).toBe('jump');
    stepN(sm, comp(), asset, clips, 12); // clip done -> progress 1
    expect(sm.current).toBe('idle');
  });
});

describe('stateMachine stepper — priority', () => {
  it('any-state transitions fire from every state', () => {
    const asset = parse({
      params: { hurt: { type: 'trigger' } },
      states: [
        { name: 'idle', animation: 'idle' },
        { name: 'walk', animation: 'walk' },
        { name: 'hurt', animation: 'jump' },
      ],
      initial: 'idle',
      transitions: [
        { from: 'idle', to: 'walk', conditions: [{ param: 'hurt' }] }, // never: consumed by any first? see below
        { from: 'any', to: 'hurt', conditions: [{ param: 'hurt' }] },
      ],
    });
    // Put the entity in walk first via a plain machine, then fire hurt.
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    sm.current = 'walk';
    fireSmTrigger(sm, asset, 'hurt');
    stepStateMachine(sm, comp(), asset, clips, DT);
    expect(sm.current).toBe('hurt'); // any-state reached it from walk
  });

  it('explicit from:current wins over from:any (both eligible)', () => {
    const asset = parse({
      params: { go: { type: 'bool' } },
      states: [
        { name: 'idle', animation: 'idle' },
        { name: 'walk', animation: 'walk' },
        { name: 'run', animation: 'run' },
      ],
      initial: 'idle',
      transitions: [
        { from: 'any', to: 'run', conditions: [{ param: 'go', op: 'eq', value: true }] },
        { from: 'idle', to: 'walk', conditions: [{ param: 'go', op: 'eq', value: true }] },
      ],
    });
    const sm = createSmState(asset, 'sm');
    setSmParam(sm, asset, 'go', true);
    stepStateMachine(sm, comp(), asset, anims(), DT);
    expect(sm.current).toBe('walk'); // explicit from:idle beats from:any even though 'any' is declared first
  });

  it('declaration order breaks ties among same-from transitions', () => {
    const asset = parse({
      params: { go: { type: 'bool' } },
      states: [
        { name: 'idle', animation: 'idle' },
        { name: 'a', animation: 'walk' },
        { name: 'b', animation: 'run' },
      ],
      initial: 'idle',
      transitions: [
        { from: 'idle', to: 'a', conditions: [{ param: 'go', op: 'eq', value: true }] },
        { from: 'idle', to: 'b', conditions: [{ param: 'go', op: 'eq', value: true }] },
      ],
    });
    const sm = createSmState(asset, 'sm');
    setSmParam(sm, asset, 'go', true);
    stepStateMachine(sm, comp(), asset, anims(), DT);
    expect(sm.current).toBe('a'); // first-declared eligible wins
  });

  it('self-transition via any restarts the clip', () => {
    const asset = parse({
      params: { restart: { type: 'trigger' } },
      states: [{ name: 'walk', animation: 'walk' }],
      initial: 'walk',
      transitions: [{ from: 'any', to: 'walk', conditions: [{ param: 'restart' }] }],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    stepN(sm, comp(), asset, clips, 9); // into frame 1
    expect(sm.frame).toBe(1);
    fireSmTrigger(sm, asset, 'restart');
    stepStateMachine(sm, comp(), asset, clips, DT); // restart -> frame 0, no advance this step
    expect(sm.current).toBe('walk');
    expect(sm.frame).toBe(0);
  });
});

describe('stateMachine stepper — trigger latch', () => {
  it('an unconsumed trigger latches until its transition becomes eligible', () => {
    const asset = parse({
      params: { fire: { type: 'trigger' }, armed: { type: 'bool' } },
      states: [
        { name: 'idle', animation: 'idle' },
        { name: 'shoot', animation: 'jump' },
      ],
      initial: 'idle',
      // needs BOTH the trigger AND armed==true.
      transitions: [
        {
          from: 'idle',
          to: 'shoot',
          conditions: [{ param: 'fire' }, { param: 'armed', op: 'eq', value: true }],
        },
      ],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    fireSmTrigger(sm, asset, 'fire'); // armed still false -> not eligible
    stepN(sm, comp(), asset, clips, 3);
    expect(sm.current).toBe('idle');
    expect(sm.triggers.has('fire')).toBe(true); // latched, not consumed
    setSmParam(sm, asset, 'armed', true);
    stepStateMachine(sm, comp(), asset, clips, DT);
    expect(sm.current).toBe('shoot');
    expect(sm.triggers.has('fire')).toBe(false);
  });

  it('consumes only triggers named in the taken transition; others latch', () => {
    const asset = parse({
      params: { a: { type: 'trigger' }, b: { type: 'trigger' } },
      states: [
        { name: 's0', animation: 'idle' },
        { name: 's1', animation: 'walk' },
        { name: 's2', animation: 'run' },
      ],
      initial: 's0',
      transitions: [
        { from: 's0', to: 's1', conditions: [{ param: 'a' }] },
        { from: 's1', to: 's2', conditions: [{ param: 'b' }] },
      ],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    fireSmTrigger(sm, asset, 'a');
    fireSmTrigger(sm, asset, 'b');
    stepStateMachine(sm, comp(), asset, clips, DT); // s0->s1 consumes only 'a'
    expect(sm.current).toBe('s1');
    expect(sm.triggers.has('a')).toBe(false);
    expect(sm.triggers.has('b')).toBe(true); // still latched
    stepStateMachine(sm, comp(), asset, clips, DT); // s1->s2 consumes 'b'
    expect(sm.current).toBe('s2');
    expect(sm.triggers.has('b')).toBe(false);
  });
});

describe('stateMachine stepper — clip playback', () => {
  it('scales clip speed by the state speed multiplier', () => {
    const asset = parse({
      params: {},
      states: [{ name: 'walk', animation: 'walk', speed: 2 }],
      initial: 'walk',
      transitions: [],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    // speed 2 -> 0.05s/frame -> the frame advances on every 3rd fixed step.
    const seq = stepN(sm, comp(), asset, clips, 9);
    expect(seq.slice(0, 9)).toEqual([
      'walk0', 'walk0', 'walk1', // advanced at the 3rd step (0.05s)
      'walk1', 'walk1', 'walk2',
      'walk2', 'walk2', 'walk0', // 3-frame clip wraps
    ]);
  });

  it('non-looping clip holds its last frame and marks the clip done', () => {
    const asset = parse({
      params: {},
      states: [{ name: 'jump', animation: 'jump' }],
      initial: 'jump',
      transitions: [],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    const seq = stepN(sm, comp(), asset, clips, 60); // way past the 0.2s clip
    expect(seq.at(-1)).toBe('jump1'); // stuck on last frame
    expect(sm.clipDone).toBe(true);
  });

  it('playing=false freezes the frame and blocks transitions', () => {
    const asset = parse({
      params: { go: { type: 'bool' } },
      states: [
        { name: 'walk', animation: 'walk' },
        { name: 'idle', animation: 'idle' },
      ],
      initial: 'walk',
      transitions: [{ from: 'walk', to: 'idle', conditions: [{ param: 'go', op: 'eq', value: true }] }],
    });
    const clips = anims();
    const sm = createSmState(asset, 'sm');
    setSmParam(sm, asset, 'go', true);
    const seq = stepN(sm, comp(false), asset, clips, 12);
    expect(seq.every((s) => s === 'walk0')).toBe(true); // frame frozen
    expect(sm.current).toBe('walk'); // transition not taken while paused
  });
});

describe('stateMachine stepper — determinism', () => {
  it('two identical runs produce identical frame sequences', () => {
    const build = (): { sm: SmState; asset: StateMachineData; clips: Map<string, AnimationData> } => {
      const asset = parse({
        params: { speed: { type: 'number', default: 0 }, jump: { type: 'trigger' } },
        states: [
          { name: 'idle', animation: 'idle' },
          { name: 'walk', animation: 'walk', speed: 1.5 },
          { name: 'jumping', animation: 'jump' },
        ],
        initial: 'idle',
        transitions: [
          { from: 'any', to: 'jumping', conditions: [{ param: 'jump' }] },
          { from: 'idle', to: 'walk', conditions: [{ param: 'speed', op: 'gt', value: 0 }] },
          { from: 'walk', to: 'idle', conditions: [{ param: 'speed', op: 'lte', value: 0 }] },
          { from: 'jumping', to: 'idle', exitTime: 1 },
        ],
      });
      return { sm: createSmState(asset, 'sm'), asset, clips: anims() };
    };
    const run = (): string[] => {
      const { sm, asset, clips } = build();
      const out: string[] = [];
      for (let f = 0; f < 120; f++) {
        if (f === 10) setSmParam(sm, asset, 'speed', 4);
        if (f === 40) fireSmTrigger(sm, asset, 'jump');
        if (f === 80) setSmParam(sm, asset, 'speed', 0);
        const r = stepStateMachine(sm, comp(), asset, clips, DT);
        out.push(r ? `${sm.current}:${r.assetId}` : 'null');
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('stateMachine param helpers (ctx.animator backing)', () => {
  const asset = (): StateMachineData =>
    parse({
      params: { moving: { type: 'bool' }, speed: { type: 'number' }, jump: { type: 'trigger' } },
      states: [{ name: 'idle', animation: 'idle' }],
      initial: 'idle',
      transitions: [],
    });

  it('setSmParam rejects unknown params', () => {
    const a = asset();
    const sm = createSmState(a, 'sm');
    expect(() => setSmParam(sm, a, 'nope', 1)).toThrow(/unknown param/);
  });

  it('setSmParam enforces the param type', () => {
    const a = asset();
    const sm = createSmState(a, 'sm');
    expect(() => setSmParam(sm, a, 'moving', 3 as unknown as boolean)).toThrow(/bool/);
    expect(() => setSmParam(sm, a, 'speed', true as unknown as number)).toThrow(/number/);
    expect(() => setSmParam(sm, a, 'jump', true)).toThrow(/trigger/);
  });

  it('fireSmTrigger rejects non-trigger params', () => {
    const a = asset();
    const sm = createSmState(a, 'sm');
    expect(() => fireSmTrigger(sm, a, 'moving')).toThrow(/not a trigger/);
    expect(() => fireSmTrigger(sm, a, 'ghost')).toThrow(/unknown param/);
  });

  it('getSmParam returns trigger latch state and rejects unknown params', () => {
    const a = asset();
    const sm = createSmState(a, 'sm');
    expect(getSmParam(sm, a, 'jump')).toBe(false);
    fireSmTrigger(sm, a, 'jump');
    expect(getSmParam(sm, a, 'jump')).toBe(true);
    expect(() => getSmParam(sm, a, 'ghost')).toThrow(/unknown param/);
  });
});
