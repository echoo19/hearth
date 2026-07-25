/**
 * Character movement as a pure function of (config, input, body, dt, gravity).
 *
 * Runs BEFORE per-entity onUpdate in SceneRuntime.step(), so a script can
 * overwrite PhysicsBody.velocity in the same frame — that is the supported way
 * to layer game-specific feel (dash, drift, wall-jump) on top of the primitive
 * rather than instead of it.
 *
 * Deterministic: no clock, no RNG, no frame-rate-dependent smoothing. Coyote
 * and jump-buffer counters live in a WeakMap keyed by the component object so
 * authored project data stays clean and project diffs stay quiet — they are
 * runtime bookkeeping, not fields anyone should see in `hearth.json`. Two
 * entities that literally share one config object would therefore share those
 * counters; the runtime parses components per entity, so each entity gets its
 * own object and its own state.
 *
 * Coordinate convention: +y is down (see physics.ts, and `GRAVITY` is a
 * positive number added to `velocity.y`), so a jump is a NEGATIVE y impulse.
 */
import type { CharacterControllerComponent } from '@hearth/core';

/** What the controller needs to know about the player's intent this frame. */
export interface CharacterInput {
  /** Is this action held right now? */
  isDown(action: string): boolean;
  /** Did this action go down on this exact frame? */
  justPressed(action: string): boolean;
  /** Is the body resting on something solid this frame? */
  grounded: boolean;
}

/** Per-component timing state, kept out of authored data. */
interface ControllerState {
  /** Frames of coyote time left; refreshed to `coyoteFrames` while grounded. */
  coyote: number;
  /** Frames a buffered jump press stays valid; set on a press that could not fire. */
  buffer: number;
}

const STATE = new WeakMap<CharacterControllerComponent, ControllerState>();

function stateFor(cfg: CharacterControllerComponent): ControllerState {
  let state = STATE.get(cfg);
  if (!state) {
    state = { coyote: 0, buffer: 0 };
    STATE.set(cfg, state);
  }
  return state;
}

/**
 * Move `current` toward `target` at `rate` px/s², never overshooting.
 * `rate <= 0` means instant — that is what hand-written controllers do and
 * what `acceleration: 0` / `drag: 0` promise.
 */
function approach(current: number, target: number, rate: number, dt: number): number {
  if (rate <= 0) return target;
  const maxDelta = rate * dt;
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

/** One axis of movement: ease toward `target`, or drag toward zero with no input. */
function driveAxis(
  current: number,
  target: number,
  hasInput: boolean,
  cfg: CharacterControllerComponent,
  dt: number,
  accelScale: number,
): number {
  if (hasInput) return approach(current, target, cfg.acceleration * accelScale, dt);
  return approach(current, 0, cfg.drag, dt);
}

/**
 * Advance one character-controller frame, writing `body.velocity` in place.
 *
 * Pure with respect to the world: everything it needs — config, input, the
 * body, the timestep, and the gravity that applies to this body — arrives as a
 * parameter, which is what makes it unit-testable and reusable outside
 * SceneRuntime.
 *
 * `topDown` drives both axes and normalises diagonals so diagonal speed equals
 * `speed`. `platformer` drives x only and leaves y to the physics engine, apart
 * from the jump impulse and the `maxFallSpeed` cap.
 */
/**
 * What the controller did this frame, for the caller to turn into events.
 * The controller performs the jump itself, so without this a game could not
 * tell when to play the jump sound, puff dust, or squash the sprite — the
 * movement would be configurable but undressable.
 */
export interface CharacterStepResult {
  jumped: boolean;
}

const NO_JUMP: CharacterStepResult = { jumped: false };

export function stepCharacter(
  cfg: CharacterControllerComponent,
  input: CharacterInput,
  body: { velocity: { x: number; y: number } },
  dt: number,
  gravity: number,
): CharacterStepResult {
  if (!cfg.enabled) return NO_JUMP;

  const a = cfg.actions;
  const state = stateFor(cfg);

  // Raw intent, then normalised so holding two directions is not faster than one.
  let ax = (input.isDown(a.right) ? 1 : 0) - (input.isDown(a.left) ? 1 : 0);
  let ay = (input.isDown(a.down) ? 1 : 0) - (input.isDown(a.up) ? 1 : 0);
  if (cfg.mode === 'topDown' && ax !== 0 && ay !== 0) {
    const len = Math.hypot(ax, ay);
    ax /= len;
    ay /= len;
  }

  let jumped = false;

  if (cfg.mode === 'topDown') {
    body.velocity.x = driveAxis(body.velocity.x, ax * cfg.speed, ax !== 0, cfg, dt, 1);
    body.velocity.y = driveAxis(body.velocity.y, ay * cfg.speed, ay !== 0, cfg, dt, 1);
  } else {
    // platformer: x only. airControl scales both the reachable target and how
    // fast it is reached while airborne; at 0 the body keeps its momentum
    // instead of being stopped dead in mid-air.
    const control = input.grounded ? 1 : cfg.airControl;
    if (control > 0) {
      body.velocity.x = driveAxis(
        body.velocity.x,
        ax * cfg.speed * control,
        ax !== 0,
        cfg,
        dt,
        control,
      );
    }

    // Coyote time: refreshed on the ground, spent in the air.
    if (input.grounded) state.coyote = cfg.coyoteFrames;
    const canJump = input.grounded || state.coyote > 0;

    const pressed = input.justPressed(a.jump);
    // A press that cannot fire is remembered for `jumpBufferFrames` frames.
    if (pressed) state.buffer = cfg.jumpBufferFrames;
    const wantJump = pressed || state.buffer > 0;

    // jumpHeight in pixels -> launch velocity, so the field means what it says.
    const jumpSpeed =
      gravity > 0 && cfg.jumpHeight > 0 ? Math.sqrt(2 * gravity * cfg.jumpHeight) : 0;

    if (wantJump && canJump && jumpSpeed > 0) {
      body.velocity.y = -jumpSpeed; // up is -y
      state.buffer = 0;
      state.coyote = 0;
      jumped = true;
    } else if (!pressed && state.buffer > 0) {
      state.buffer -= 1;
    }

    if (!input.grounded && state.coyote > 0) state.coyote -= 1;
  }

  // Terminal velocity, downward only — an upward jump must not be clipped.
  if (cfg.maxFallSpeed > 0 && body.velocity.y > cfg.maxFallSpeed) {
    body.velocity.y = cfg.maxFallSpeed;
  }

  return jumped ? { jumped: true } : NO_JUMP;
}
