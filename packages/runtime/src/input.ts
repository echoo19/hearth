import { GAMEPAD_BUTTONS, type GamepadAxisBinding, type InputMappings, type VirtualAxis } from '@hearth/core';

/**
 * InputState — action-based input for the Hearth runtime.
 *
 * Actions are named in the project's inputMappings (action name → list of
 * KeyboardEvent.code values, plus optional gamepad button/axis bindings).
 * The runtime and scripts only ever see actions; raw key codes enter
 * through `handleKeyDown/Up` (browser hosts) while playtests drive actions
 * directly via `setActionDown/Up`.
 *
 * Gamepad buttons and axis-to-action bindings are translated into synthetic
 * codes (`gp:<name>`, `gp:axis<i>+`/`gp:axis<i>-`) that flow through the
 * exact same `codeToActions` index and `handleKeyDown/Up` held-state
 * machinery as keyboard codes — `pollGamepads` is the only gamepad-specific
 * logic; everything else (multi-binding, both-sources-held release,
 * justPressed) is reused untouched.
 */

/** Minimal shape of the browser Gamepad the runtime actually reads. */
export interface GamepadLike {
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

const EMPTY_MAPPINGS: InputMappings = {
  actions: {},
  gamepadButtons: {},
  gamepadAxes: {},
  axes: {},
  deadzone: 0.15,
};

/** Reverse of GAMEPAD_BUTTONS: index -> name. */
const BUTTON_NAME_BY_INDEX = new Map<number, string>(
  Object.entries(GAMEPAD_BUTTONS).map(([name, index]) => [index, name]),
);

function axisCode(axis: number, direction: 1 | -1): string {
  return `gp:axis${axis}${direction === 1 ? '+' : '-'}`;
}

/**
 * Hysteresis band for gamepad axis→action threshold bindings: once a
 * (pad, binding) latch engages at `effectiveThreshold`, it only releases
 * once the axis value drops below `effectiveThreshold - HYSTERESIS`
 * (strictly below), not merely back below the engage threshold. This
 * absorbs stick noise near the threshold that would otherwise flap the
 * synthetic gp: code and re-fire justPressed every frame.
 *
 * effectiveThreshold = max(binding.threshold, deadzone) is always >= the
 * configured deadzone (0.15 by default, always > HYSTERESIS in any sane
 * config), so `effectiveThreshold - HYSTERESIS` stays positive and the
 * band never inverts. This is assumed, not defended against, at the call
 * site below.
 */
const HYSTERESIS = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Back-compat: the old constructor took a plain `Record<string, string[]>`
 * of action -> keyboard codes. Detect that shape (no `actions` sub-record)
 * vs. a full InputMappings object and normalize to the latter.
 */
function normalizeMappings(input: InputMappings | Record<string, string[]>): InputMappings {
  const maybe = input as Partial<InputMappings>;
  const actions = maybe.actions;
  const hasMappingsShape = actions !== undefined && typeof actions === 'object' && !Array.isArray(actions);
  if (hasMappingsShape) {
    return {
      actions: actions ?? {},
      gamepadButtons: maybe.gamepadButtons ?? {},
      gamepadAxes: maybe.gamepadAxes ?? {},
      axes: maybe.axes ?? {},
      deadzone: maybe.deadzone ?? 0.15,
    };
  }
  return { ...EMPTY_MAPPINGS, actions: input as Record<string, string[]> };
}

export class InputState {
  private codeToActions = new Map<string, string[]>();
  private actionToCodes: Record<string, string[]>;
  private downActions = new Set<string>();
  private justPressedActions = new Set<string>();
  private downCodes = new Set<string>();

  private readonly axesConfig: Record<string, VirtualAxis>;
  private readonly gamepadAxes: Record<string, GamepadAxisBinding>;
  private readonly deadzone: number;

  /** Max-abs-by-sign gamepad axis values from the most recent pollGamepads. */
  private lastAxes: number[] = [];
  /** Synthetic gamepad codes considered active as of the previous poll. */
  private prevGamepadCodes = new Set<string>();
  /**
   * Per (pad index, action) latch state for axis→action threshold bindings,
   * keyed by `${padIndex}:${action}`. Tracks whether that specific pad's
   * binding is currently engaged, so hysteresis is applied independently
   * per pad — preserving the per-pad-OR semantics (the synthetic code is
   * down iff ANY pad's latch is engaged) while each pad's own latch only
   * releases per its own hysteresis band.
   */
  private axisLatch = new Map<string, boolean>();
  /** Sticky playtest overrides set via setAxis/cleared via clearAxis. */
  private readonly axisOverrides = new Map<string, number>();

  constructor(mappings: InputMappings | Record<string, string[]> = {}) {
    const m = normalizeMappings(mappings);
    this.axesConfig = m.axes;
    this.gamepadAxes = m.gamepadAxes;
    this.deadzone = m.deadzone;

    const actionToCodes: Record<string, string[]> = {};
    for (const [action, codes] of Object.entries(m.actions)) {
      actionToCodes[action] = [...codes];
    }
    for (const [action, buttonNames] of Object.entries(m.gamepadButtons)) {
      const codes = buttonNames
        .filter((name) => Object.prototype.hasOwnProperty.call(GAMEPAD_BUTTONS, name))
        .map((name) => `gp:${name}`);
      if (codes.length === 0) continue;
      actionToCodes[action] = [...(actionToCodes[action] ?? []), ...codes];
    }
    for (const [action, binding] of Object.entries(m.gamepadAxes)) {
      const code = axisCode(binding.axis, binding.direction);
      actionToCodes[action] = [...(actionToCodes[action] ?? []), code];
    }

    this.actionToCodes = actionToCodes;
    for (const [action, codes] of Object.entries(actionToCodes)) {
      for (const code of codes) {
        const list = this.codeToActions.get(code) ?? [];
        list.push(action);
        this.codeToActions.set(code, list);
      }
    }
  }

  /** Is the action currently held? */
  isDown(action: string): boolean {
    return this.downActions.has(action);
  }

  /** Did the action transition to down this frame? Cleared by `endFrame()`. */
  justPressed(action: string): boolean {
    return this.justPressedActions.has(action);
  }

  /** Programmatically press an action (used by playtests). */
  setActionDown(action: string): void {
    if (!this.downActions.has(action)) {
      this.downActions.add(action);
      this.justPressedActions.add(action);
    }
  }

  /** Programmatically release an action (used by playtests). */
  setActionUp(action: string): void {
    this.downActions.delete(action);
  }

  /** Feed a KeyboardEvent.code (or synthetic gp: code) keydown; dedupes repeats. */
  handleKeyDown(code: string): void {
    if (this.downCodes.has(code)) return; // OS key repeat
    this.downCodes.add(code);
    for (const action of this.codeToActions.get(code) ?? []) {
      this.setActionDown(action);
    }
  }

  /** Feed a KeyboardEvent.code (or synthetic gp: code) keyup; releases actions with no other held code. */
  handleKeyUp(code: string): void {
    this.downCodes.delete(code);
    for (const action of this.codeToActions.get(code) ?? []) {
      const codes = this.actionToCodes[action] ?? [];
      if (!codes.some((c) => this.downCodes.has(c))) this.setActionUp(action);
    }
  }

  /** True when a KeyboardEvent.code is bound to any action (for preventDefault). */
  isMappedCode(code: string): boolean {
    return this.codeToActions.has(code);
  }

  /**
   * Poll connected gamepads: compute the active synthetic-code set (button
   * pressed on any pad; axis-to-action binding beyond its threshold on any
   * pad — per-pad OR, so two pads pushing one axis index in opposite
   * directions both register), diff against the previous poll, and feed
   * handleKeyDown/Up — so held-state, multi-binding, and justPressed are
   * all reused from the keyboard path. Also records `lastAxes` (max over
   * pads by |value|, respecting sign) for axisValue(), where a single
   * combined reading is the right semantic.
   */
  pollGamepads(pads: ReadonlyArray<GamepadLike | null>): void {
    const activeCodes = new Set<string>();

    let axisCount = 0;
    for (const gp of pads) {
      if (gp && gp.axes.length > axisCount) axisCount = gp.axes.length;
    }
    const combinedAxes: number[] = new Array(axisCount).fill(0);

    for (let padIndex = 0; padIndex < pads.length; padIndex++) {
      const gp = pads[padIndex];
      if (!gp) {
        // Disconnected (or never-connected) slot: drop any latch state for
        // it so a later reconnect (possibly a different physical pad)
        // starts fresh rather than inheriting a stale engaged latch.
        for (const action of Object.keys(this.gamepadAxes)) {
          this.axisLatch.delete(`${padIndex}:${action}`);
        }
        continue;
      }
      for (const [index, name] of BUTTON_NAME_BY_INDEX) {
        if (gp.buttons[index]?.pressed) activeCodes.add(`gp:${name}`);
      }
      for (let i = 0; i < gp.axes.length; i++) {
        const value = gp.axes[i];
        if (Math.abs(value) > Math.abs(combinedAxes[i])) combinedAxes[i] = value;
      }
      // Evaluate each axis binding against THIS pad's own reading — never
      // the max-|value| merge, which would let a larger opposing input on
      // another pad swallow a genuinely-past-threshold one on this pad.
      // The global deadzone is a floor under the binding's own threshold —
      // a binding can demand more precision than the deadzone (a stricter
      // threshold), but can never fire inside the deadzone band.
      for (const [action, binding] of Object.entries(this.gamepadAxes)) {
        const raw = gp.axes[binding.axis] ?? 0;
        const effectiveThreshold = Math.max(binding.threshold, this.deadzone);
        const latchKey = `${padIndex}:${action}`;
        const wasEngaged = this.axisLatch.get(latchKey) ?? false;
        // Engage at value >= effective (mirrored below zero for direction
        // -1). Once engaged, only release once the value drops below
        // effective - HYSTERESIS — hysteresis per pad+binding latch, so
        // stick noise oscillating around the threshold doesn't flap the
        // synthetic code or re-fire justPressed.
        const engaged =
          binding.direction === 1
            ? wasEngaged
              ? raw >= effectiveThreshold - HYSTERESIS
              : raw >= effectiveThreshold
            : wasEngaged
              ? raw <= -(effectiveThreshold - HYSTERESIS)
              : raw <= -effectiveThreshold;
        this.axisLatch.set(latchKey, engaged);
        if (engaged) activeCodes.add(axisCode(binding.axis, binding.direction));
      }
    }
    this.lastAxes = combinedAxes;

    for (const code of activeCodes) {
      if (!this.prevGamepadCodes.has(code)) this.handleKeyDown(code);
    }
    for (const code of this.prevGamepadCodes) {
      if (!activeCodes.has(code)) this.handleKeyUp(code);
    }
    this.prevGamepadCodes = activeCodes;
  }

  /**
   * Analog value for a virtual axis in inputMappings.axes, clamped to
   * [-1, 1]. Precedence: setAxis override (sticky, playtest-only) > gamepad
   * axis reading (once beyond the deadzone) > keyboard fallback (negative
   * held → -1, positive held → +1, both/neither → 0). Unknown axis name or
   * no signal → 0.
   */
  axisValue(name: string): number {
    const override = this.axisOverrides.get(name);
    if (override !== undefined) return clamp(override, -1, 1);

    const axis = this.axesConfig[name];
    if (!axis) return 0;

    if (axis.gamepadAxis !== undefined) {
      const raw = this.lastAxes[axis.gamepadAxis] ?? 0;
      const dz = axis.deadzone ?? this.deadzone;
      if (Math.abs(raw) > dz) return clamp(raw, -1, 1);
    }

    const negative = axis.negativeCodes.some((c) => this.downCodes.has(c));
    const positive = axis.positiveCodes.some((c) => this.downCodes.has(c));
    if (negative === positive) return 0; // both or neither
    return negative ? -1 : 1;
  }

  /** Sticky playtest override for a virtual axis; see clearAxis to remove it. */
  setAxis(name: string, value: number): void {
    this.axisOverrides.set(name, value);
  }

  /** Remove a playtest override set via setAxis, restoring gamepad/keyboard reads. */
  clearAxis(name: string): void {
    this.axisOverrides.delete(name);
  }

  /** Internal: called by the runtime at the end of each fixed frame. */
  endFrame(): void {
    this.justPressedActions.clear();
  }
}
