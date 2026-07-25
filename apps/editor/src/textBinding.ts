/**
 * Text.binding helpers — the nullable `{ key, format, precision }` group from
 * TextBindingSchema (@hearth/core). Kept out of the React component so the
 * bind/unbind and per-field write logic stays unit-testable without a DOM,
 * the same split postEffectsList.ts / vec2List.ts use for their fields.
 *
 * Every write goes out as a WHOLE binding object (or null) rather than a
 * nested `Text.binding.key` path: `binding` is nullable, so a dotted write
 * has nothing to descend into while the binding is off. One shape for both
 * the on and off case is simpler than two.
 */
import type { GameStateEntry } from './types';

export interface TextBinding {
  /** A key declared in hearth.json `gameState`. */
  key: string;
  /** Template with a single {value} placeholder, e.g. "Score: {value}". */
  format: string;
  /** Decimal places for number values; ignored for booleans and strings. */
  precision: number;
}

/** TextBindingSchema's own defaults, so a fresh binding matches the schema. */
export const BINDING_DEFAULT_FORMAT = '{value}';
export const BINDING_DEFAULT_PRECISION = 0;
/** TextBindingSchema: precision is `.int().min(0).max(6)`. */
export const BINDING_PRECISION_MIN = 0;
export const BINDING_PRECISION_MAX = 6;
/** The placeholder a format has to carry for the value to appear at all. */
export const BINDING_VALUE_TOKEN = '{value}';

export function isTextBinding(value: unknown): value is TextBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === 'string' && typeof v.format === 'string' && typeof v.precision === 'number'
  );
}

/** The binding committed when the user turns the toggle on. */
export function newBinding(key: string): TextBinding {
  return { key, format: BINDING_DEFAULT_FORMAT, precision: BINDING_DEFAULT_PRECISION };
}

export function withBindingField<K extends keyof TextBinding>(
  binding: TextBinding,
  field: K,
  value: TextBinding[K],
): TextBinding {
  return { ...binding, [field]: value };
}

/**
 * Precision only means something for a number-typed key — TextBindingSchema
 * says as much ("ignored for booleans and strings"), so the control hides the
 * input rather than offering a knob that provably does nothing. An UNDECLARED
 * key (a stale binding, or a project whose gameState was edited out from
 * under it) keeps the input: we can't prove it's inert, and blanking it would
 * lose the authored value.
 */
export function precisionApplies(entry: GameStateEntry | undefined): boolean {
  return entry === undefined || entry.type === 'number';
}

/**
 * A format with no {value} renders a constant label — the binding runs but
 * the value never shows, which looks exactly like a broken binding. Worth a
 * quiet inline note; not worth refusing the value (a deliberate constant is
 * legal, and the schema allows it).
 */
export function formatShowsValue(format: string): boolean {
  return format.includes(BINDING_VALUE_TOKEN);
}
