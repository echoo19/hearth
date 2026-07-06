/**
 * Standard gamepad button mappings (W3C GamepadEvent spec).
 * Keys are human-readable names; values are button indices.
 */
export const GAMEPAD_BUTTONS: Record<string, number> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  back: 8,
  start: 9,
  ls: 10,
  rs: 11,
  'dpad-up': 12,
  'dpad-down': 13,
  'dpad-left': 14,
  'dpad-right': 15,
};

export const GAMEPAD_BUTTON_NAMES = Object.keys(GAMEPAD_BUTTONS);
