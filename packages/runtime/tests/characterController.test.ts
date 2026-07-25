/**
 * CharacterController unit tests for the pure `stepCharacter` function:
 * diagonal normalisation, instant vs eased acceleration, drag that stops at
 * zero, platformer x-only movement, jump-height-to-impulse conversion,
 * coyote/jump-buffer windows, fall-speed capping, air control, configurable
 * action names, and the `enabled: false` escape hatch.
 *
 * `stepCharacter` takes gravity as its fifth argument (the plan's Task 4 Step 4
 * adds it), so every call passes the scene default `GRAVITY` explicitly.
 */
import { describe, it, expect } from 'vitest';
import { COMPONENT_SCHEMAS } from '@hearth/core';
import { stepCharacter } from '../src/characterController.js';
import { GRAVITY } from '../src/physics.js';

const DT = 1 / 60;

const cfg = (over: Record<string, unknown> = {}) =>
  COMPONENT_SCHEMAS.CharacterController.parse({ speed: 100, ...over });

const input = (down: string[], pressed: string[] = [], grounded = true) => ({
  isDown: (a: string) => down.includes(a),
  justPressed: (a: string) => pressed.includes(a),
  grounded,
});

describe('stepCharacter — topDown', () => {
  it('moves on both axes and normalises diagonals to one speed', () => {
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(cfg({ mode: 'topDown' }), input(['right', 'down']), body, DT, GRAVITY);
    const mag = Math.hypot(body.velocity.x, body.velocity.y);
    expect(mag).toBeCloseTo(100, 5);
    expect(body.velocity.x).toBeCloseTo(100 / Math.SQRT2, 5);
    expect(body.velocity.x).toBeGreaterThan(0);
    expect(body.velocity.y).toBeGreaterThan(0);
  });

  it('reaches full speed on a single axis', () => {
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(cfg({ mode: 'topDown' }), input(['up']), body, DT, GRAVITY);
    expect(body.velocity.x).toBe(0);
    expect(body.velocity.y).toBeCloseTo(-100, 5);
  });

  it('zeroes velocity with no input when acceleration is instant', () => {
    const body = { velocity: { x: 100, y: 0 } };
    stepCharacter(cfg({ mode: 'topDown' }), input([]), body, DT, GRAVITY);
    expect(body.velocity).toEqual({ x: 0, y: 0 });
  });

  it('eases toward target speed when acceleration is set', () => {
    const body = { velocity: { x: 0, y: 0 } };
    const c = cfg({ mode: 'topDown', acceleration: 200 });
    stepCharacter(c, input(['right']), body, DT, GRAVITY);
    expect(body.velocity.x).toBeCloseTo(200 * DT, 5);
    expect(body.velocity.x).toBeGreaterThan(0);
    expect(body.velocity.x).toBeLessThan(100);
  });

  it('never overshoots the target while accelerating', () => {
    const body = { velocity: { x: 99, y: 0 } };
    stepCharacter(cfg({ mode: 'topDown', acceleration: 600 }), input(['right']), body, DT, GRAVITY);
    expect(body.velocity.x).toBe(100);
  });

  it('decays toward zero at the drag rate with no input', () => {
    const body = { velocity: { x: 100, y: 0 } };
    stepCharacter(cfg({ mode: 'topDown', drag: 300 }), input([]), body, DT, GRAVITY);
    expect(body.velocity.x).toBeCloseTo(100 - 300 * DT, 5);
  });

  it('drag stops at zero instead of reversing the sign', () => {
    const body = { velocity: { x: 2, y: -2 } };
    stepCharacter(cfg({ mode: 'topDown', drag: 3000 }), input([]), body, DT, GRAVITY);
    expect(body.velocity.x).toBe(0);
    expect(body.velocity.y).toBe(0);
  });

  it('does not jump — jumpHeight is platformer only', () => {
    const body = { velocity: { x: 0, y: 250 } };
    stepCharacter(
      cfg({ mode: 'topDown', jumpHeight: 64 }),
      input([], ['jump'], true),
      body,
      DT,
      GRAVITY,
    );
    expect(body.velocity.y).toBe(0);
  });
});

describe('stepCharacter — platformer', () => {
  it('leaves vertical velocity to gravity and only drives x', () => {
    const body = { velocity: { x: 0, y: 250 } };
    stepCharacter(cfg({ mode: 'platformer' }), input(['right']), body, DT, GRAVITY);
    expect(body.velocity.x).toBeCloseTo(100, 5);
    expect(body.velocity.y).toBe(250);
  });

  it('does not normalise vertical input into horizontal movement', () => {
    const body = { velocity: { x: 0, y: 250 } };
    stepCharacter(cfg({ mode: 'platformer' }), input(['right', 'down']), body, DT, GRAVITY);
    expect(body.velocity.x).toBeCloseTo(100, 5);
    expect(body.velocity.y).toBe(250);
  });

  it('jumps when grounded and jumpHeight is set', () => {
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(
      cfg({ mode: 'platformer', jumpHeight: 64 }),
      input([], ['jump'], true),
      body,
      DT,
      GRAVITY,
    );
    expect(body.velocity.y).toBeLessThan(0);
  });

  it('converts jumpHeight to sqrt(2 * gravity * height) upward', () => {
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(
      cfg({ mode: 'platformer', jumpHeight: 64 }),
      input([], ['jump'], true),
      body,
      DT,
      GRAVITY,
    );
    expect(body.velocity.y).toBeCloseTo(-Math.sqrt(2 * GRAVITY * 64), 5);
  });

  it('cannot jump without gravity to convert the height against', () => {
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(
      cfg({ mode: 'platformer', jumpHeight: 64 }),
      input([], ['jump'], true),
      body,
      DT,
      0,
    );
    expect(body.velocity.y).toBe(0);
  });

  it('cannot jump when jumpHeight is zero', () => {
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(cfg({ mode: 'platformer' }), input([], ['jump'], true), body, DT, GRAVITY);
    expect(body.velocity.y).toBe(0);
  });

  it('refuses to jump in mid-air once coyote frames are exhausted', () => {
    const c = cfg({ mode: 'platformer', jumpHeight: 64, coyoteFrames: 0 });
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(c, input([], ['jump'], false), body, DT, GRAVITY);
    expect(body.velocity.y).toBe(0);
  });

  it('allows a jump within the coyote window after leaving the ground', () => {
    const c = cfg({ mode: 'platformer', jumpHeight: 64, coyoteFrames: 6 });
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(c, input([], [], true), body, DT, GRAVITY); // grounded, no jump
    stepCharacter(c, input([], [], false), body, DT, GRAVITY); // just left the ledge
    stepCharacter(c, input([], ['jump'], false), body, DT, GRAVITY);
    expect(body.velocity.y).toBeLessThan(0);
  });

  it('closes the coyote window after exactly coyoteFrames airborne frames', () => {
    const c = cfg({ mode: 'platformer', jumpHeight: 64, coyoteFrames: 2 });
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(c, input([], [], true), body, DT, GRAVITY); // grounded
    stepCharacter(c, input([], [], false), body, DT, GRAVITY); // airborne 1
    stepCharacter(c, input([], [], false), body, DT, GRAVITY); // airborne 2
    stepCharacter(c, input([], ['jump'], false), body, DT, GRAVITY); // airborne 3 — too late
    expect(body.velocity.y).toBe(0);
  });

  it('replays a buffered jump press on landing', () => {
    const c = cfg({ mode: 'platformer', jumpHeight: 64, jumpBufferFrames: 4 });
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(c, input([], ['jump'], false), body, DT, GRAVITY); // pressed too early
    expect(body.velocity.y).toBe(0);
    stepCharacter(c, input([], [], false), body, DT, GRAVITY); // still falling
    expect(body.velocity.y).toBe(0);
    stepCharacter(c, input([], [], true), body, DT, GRAVITY); // lands
    expect(body.velocity.y).toBeLessThan(0);
  });

  it('forgets a buffered jump press once the buffer expires', () => {
    const c = cfg({ mode: 'platformer', jumpHeight: 64, jumpBufferFrames: 1 });
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(c, input([], ['jump'], false), body, DT, GRAVITY); // press
    stepCharacter(c, input([], [], false), body, DT, GRAVITY); // buffer frame 1
    stepCharacter(c, input([], [], false), body, DT, GRAVITY); // expired
    stepCharacter(c, input([], [], true), body, DT, GRAVITY); // lands, nothing left
    expect(body.velocity.y).toBe(0);
  });

  it('does not buffer a jump at all when jumpBufferFrames is zero', () => {
    const c = cfg({ mode: 'platformer', jumpHeight: 64 });
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(c, input([], ['jump'], false), body, DT, GRAVITY);
    stepCharacter(c, input([], [], true), body, DT, GRAVITY);
    expect(body.velocity.y).toBe(0);
  });

  it('caps fall speed when maxFallSpeed is set', () => {
    const body = { velocity: { x: 0, y: 900 } };
    stepCharacter(cfg({ mode: 'platformer', maxFallSpeed: 400 }), input([]), body, DT, GRAVITY);
    expect(body.velocity.y).toBe(400);
  });

  it('never caps upward velocity', () => {
    const body = { velocity: { x: 0, y: -900 } };
    stepCharacter(cfg({ mode: 'platformer', maxFallSpeed: 400 }), input([]), body, DT, GRAVITY);
    expect(body.velocity.y).toBe(-900);
  });

  it('scales the airborne target speed by airControl', () => {
    const c = cfg({ mode: 'platformer', airControl: 0.5 });
    const grounded = { velocity: { x: 0, y: 0 } };
    const airborne = { velocity: { x: 0, y: 0 } };
    stepCharacter(c, input(['right'], [], true), grounded, DT, GRAVITY);
    stepCharacter(c, input(['right'], [], false), airborne, DT, GRAVITY);
    expect(grounded.velocity.x).toBeCloseTo(100, 5);
    expect(airborne.velocity.x).toBeCloseTo(50, 5);
  });

  it('keeps airborne momentum when airControl is zero', () => {
    const c = cfg({ mode: 'platformer', airControl: 0 });
    const body = { velocity: { x: 80, y: 120 } };
    stepCharacter(c, input(['left'], [], false), body, DT, GRAVITY);
    expect(body.velocity.x).toBe(80);
    expect(body.velocity.y).toBe(120);
  });
});

describe('stepCharacter — configuration', () => {
  it('reads the action names from cfg.actions', () => {
    const c = cfg({ mode: 'platformer', actions: { right: 'moveRight' } });
    const wrong = { velocity: { x: 0, y: 0 } };
    const right = { velocity: { x: 0, y: 0 } };
    stepCharacter(c, input(['right']), wrong, DT, GRAVITY);
    stepCharacter(c, input(['moveRight']), right, DT, GRAVITY);
    expect(wrong.velocity.x).toBe(0);
    expect(right.velocity.x).toBeCloseTo(100, 5);
  });

  it('reads the jump action name from cfg.actions', () => {
    const c = cfg({ mode: 'platformer', jumpHeight: 64, actions: { jump: 'hop' } });
    const body = { velocity: { x: 0, y: 0 } };
    stepCharacter(c, input([], ['jump'], true), body, DT, GRAVITY);
    expect(body.velocity.y).toBe(0);
    stepCharacter(c, input([], ['hop'], true), body, DT, GRAVITY);
    expect(body.velocity.y).toBeLessThan(0);
  });

  it('touches nothing when disabled', () => {
    const c = cfg({ mode: 'platformer', jumpHeight: 64, maxFallSpeed: 100, enabled: false });
    const body = { velocity: { x: 7, y: 900 } };
    stepCharacter(c, input(['right'], ['jump'], true), body, DT, GRAVITY);
    expect(body.velocity).toEqual({ x: 7, y: 900 });
  });

  it('is deterministic — identical inputs produce identical velocities', () => {
    const frames: Array<[string[], string[], boolean]> = [
      [['right'], [], true],
      [['right'], ['jump'], true],
      [['right'], [], false],
      [[], [], false],
      [['left'], [], false],
      [['left'], [], true],
    ];
    const run = () => {
      const c = cfg({
        mode: 'platformer',
        acceleration: 900,
        drag: 600,
        jumpHeight: 48,
        coyoteFrames: 3,
        jumpBufferFrames: 3,
        maxFallSpeed: 500,
        airControl: 0.6,
      });
      const body = { velocity: { x: 0, y: 0 } };
      const trace: number[] = [];
      for (const [down, pressed, grounded] of frames) {
        stepCharacter(c, input(down, pressed, grounded), body, DT, GRAVITY);
        trace.push(body.velocity.x, body.velocity.y);
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});
