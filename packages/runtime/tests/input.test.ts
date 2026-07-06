/**
 * InputState gamepad polling and virtual axes: synthetic gp: codes reuse the
 * existing keyboard held-state machinery, so these tests exercise
 * pollGamepads/axisValue/setAxis against fake GamepadLike objects (no
 * browser, no real Gamepad API).
 */
import { describe, it, expect } from 'vitest';
import { InputState, type GamepadLike } from '@hearth/runtime';

/** Build a fake pad with all 16 standard buttons unpressed and given axes. */
function pad(overrides: {
  buttons?: Record<number, { pressed: boolean; value: number }>;
  axes?: number[];
} = {}): GamepadLike {
  const buttons = Array.from({ length: 16 }, (_, i) => overrides.buttons?.[i] ?? { pressed: false, value: 0 });
  return { buttons, axes: overrides.axes ?? [] };
}

describe('InputState back-compat constructor', () => {
  it('treats a plain record as { actions: record }', () => {
    const input = new InputState({ left: ['ArrowLeft'] });
    input.handleKeyDown('ArrowLeft');
    expect(input.isDown('left')).toBe(true);
  });
});

describe('InputState.pollGamepads — buttons', () => {
  it('button press → action down; release → up; justPressed one frame', () => {
    const input = new InputState({
      actions: {},
      gamepadButtons: { jump: ['a'] },
    });

    input.pollGamepads([pad({ buttons: { 0: { pressed: true, value: 1 } } })]);
    expect(input.isDown('jump')).toBe(true);
    expect(input.justPressed('jump')).toBe(true);

    input.endFrame();
    input.pollGamepads([pad({ buttons: { 0: { pressed: true, value: 1 } } })]);
    expect(input.isDown('jump')).toBe(true);
    expect(input.justPressed('jump')).toBe(false); // held, not a new press

    input.pollGamepads([pad({ buttons: { 0: { pressed: false, value: 0 } } })]);
    expect(input.isDown('jump')).toBe(false);
  });

  it('keyboard AND gamepad both holding one action: releasing one keeps it down', () => {
    const input = new InputState({
      actions: { jump: ['Space'] },
      gamepadButtons: { jump: ['a'] },
    });

    input.handleKeyDown('Space');
    input.pollGamepads([pad({ buttons: { 0: { pressed: true, value: 1 } } })]);
    expect(input.isDown('jump')).toBe(true);

    // release the gamepad button; keyboard still held → action stays down.
    input.pollGamepads([pad({ buttons: { 0: { pressed: false, value: 0 } } })]);
    expect(input.isDown('jump')).toBe(true);

    // now release the keyboard key too → action releases.
    input.handleKeyUp('Space');
    expect(input.isDown('jump')).toBe(false);
  });

  it('unknown button name in bindings is ignored without throwing', () => {
    expect(() => {
      const input = new InputState({
        actions: {},
        gamepadButtons: { jump: ['not-a-real-button'] },
      });
      input.pollGamepads([pad({ buttons: { 0: { pressed: true, value: 1 } } })]);
      expect(input.isDown('jump')).toBe(false);
    }).not.toThrow();
  });
});

describe('InputState.pollGamepads — axis-to-action bindings', () => {
  it('crosses threshold on both signs and releases below threshold', () => {
    const input = new InputState({
      actions: {},
      gamepadAxes: {
        right: { axis: 0, direction: 1, threshold: 0.5 },
        left: { axis: 0, direction: -1, threshold: 0.5 },
      },
    });

    input.pollGamepads([pad({ axes: [0.6] })]);
    expect(input.isDown('right')).toBe(true);
    expect(input.isDown('left')).toBe(false);

    input.pollGamepads([pad({ axes: [0.4] })]);
    expect(input.isDown('right')).toBe(false);

    input.pollGamepads([pad({ axes: [-0.6] })]);
    expect(input.isDown('left')).toBe(true);
    expect(input.isDown('right')).toBe(false);
  });
});

describe('InputState.axisValue', () => {
  it('deadzone: below the deadzone reads as 0 and fires no synthetic code', () => {
    const input = new InputState({
      actions: {},
      axes: { moveX: { gamepadAxis: 0, negativeCodes: [], positiveCodes: [] } },
      deadzone: 0.15,
    });
    input.pollGamepads([pad({ axes: [0.1] })]);
    expect(input.axisValue('moveX')).toBe(0);
  });

  it('reads the gamepad axis beyond the deadzone', () => {
    const input = new InputState({
      actions: {},
      axes: { moveX: { gamepadAxis: 0, negativeCodes: [], positiveCodes: [] } },
      deadzone: 0.15,
    });
    input.pollGamepads([pad({ axes: [0.6] })]);
    expect(input.axisValue('moveX')).toBeCloseTo(0.6, 5);
  });

  it('precedence: setAxis override > gamepad > keyboard fallback', () => {
    const input = new InputState({
      actions: {},
      axes: {
        moveX: { gamepadAxis: 0, negativeCodes: ['ArrowLeft'], positiveCodes: ['ArrowRight'] },
      },
      deadzone: 0.15,
    });

    // keyboard fallback: nothing held → 0
    expect(input.axisValue('moveX')).toBe(0);

    // keyboard fallback: positive
    input.handleKeyDown('ArrowRight');
    expect(input.axisValue('moveX')).toBe(1);

    // keyboard fallback: negative
    input.handleKeyDown('ArrowLeft');
    // both held → 0
    expect(input.axisValue('moveX')).toBe(0);
    input.handleKeyUp('ArrowRight');
    expect(input.axisValue('moveX')).toBe(-1);

    // gamepad beats keyboard once it clears the deadzone
    input.pollGamepads([pad({ axes: [0.8] })]);
    expect(input.axisValue('moveX')).toBeCloseTo(0.8, 5);

    // setAxis override beats everything
    input.setAxis('moveX', -0.3);
    expect(input.axisValue('moveX')).toBeCloseTo(-0.3, 5);

    input.clearAxis('moveX');
    expect(input.axisValue('moveX')).toBeCloseTo(0.8, 5);
  });

  it('unknown axis name returns 0 without throwing', () => {
    const input = new InputState({});
    expect(input.axisValue('nope')).toBe(0);
  });
});
