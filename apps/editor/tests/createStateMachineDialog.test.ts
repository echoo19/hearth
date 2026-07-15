/**
 * T9-U8: the ONE "New state machine" dialog (AnimatorEditor + AssetsPanel both
 * render CreateStateMachineDialog). The seed payload is the pure piece —
 * createStateMachineAsset requires ≥1 state whose animation resolves, so the
 * dialog seeds a single `idle` state on the first available animation.
 */
import { describe, expect, it } from 'vitest';
import { seedStateMachinePayload } from '../src/components/CreateStateMachineDialog';

describe('seedStateMachinePayload', () => {
  it('seeds one idle state on the given animation, no params/transitions', () => {
    expect(seedStateMachinePayload('courier-motion', 'ast_anim1')).toEqual({
      name: 'courier-motion',
      data: {
        params: {},
        states: [{ name: 'idle', animation: 'ast_anim1', speed: 1 }],
        initial: 'idle',
        transitions: [],
      },
    });
  });
});
