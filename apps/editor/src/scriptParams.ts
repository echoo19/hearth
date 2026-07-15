/**
 * Pure helpers for the Inspector's Script.params key/value editor
 * (INSPECTOR-5 / INSPSPEC-8 / L-034) — the last field that used to fall back
 * to a read-only raw-JSON dump. Kept out of Inspector.tsx so the
 * record-editing and type-inference logic stays unit-testable without a DOM
 * (same idiom as vec2List.ts / stringList.ts). No JSON parsing anywhere: the
 * UI renders a typed control per inferred value kind, never a JSON textarea.
 */

/** The controls the params editor can render a value with. */
export type ParamKind = 'number' | 'boolean' | 'color' | 'string' | 'array' | 'object' | 'null';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Which typed control renders a given param value. */
export function inferParamKind(value: unknown): ParamKind {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return HEX.test(value) ? 'color' : 'string';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'string';
}

/** The three primitive kinds a user can add a brand-new param as. */
export type NewParamType = 'number' | 'string' | 'boolean';

/** Default value for a freshly-added param of the given primitive type. */
export function defaultForParamType(type: NewParamType): number | string | boolean {
  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      return '';
  }
}

/** New record with `key` set to `value` (append if absent, replace in place if present). */
export function setParamKey(
  params: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  return { ...params, [key]: value };
}

/** New record without `key`. */
export function removeParamKey(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const next = { ...params };
  delete next[key];
  return next;
}

/**
 * New record with `oldKey` renamed to `newKey`, preserving insertion order
 * (the renamed entry stays in place rather than jumping to the end). Returns
 * null when the rename is invalid: empty name, a '.' (params.<key> is a
 * single path segment — a dotted key can be created but never scalar-edited,
 * since setProperty('params.a.b') reads as an over-specified path rather than
 * a literal key), unknown source key, or a collision with a different
 * existing key.
 */
export function renameParamKey(
  params: Record<string, unknown>,
  oldKey: string,
  newKey: string,
): Record<string, unknown> | null {
  if (!newKey || newKey.includes('.') || !(oldKey in params)) return null;
  if (newKey === oldKey) return { ...params };
  if (newKey in params) return null;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    next[k === oldKey ? newKey : k] = v;
  }
  return next;
}

/**
 * A new array element to append, typed to match the array's existing
 * elements (number[] -> 0, boolean[] -> false, else ''), so "Add item" never
 * introduces a type the array didn't already hold.
 */
export function appendArrayItem(arr: readonly unknown[]): unknown[] {
  const sample = arr[arr.length - 1];
  if (typeof sample === 'number') return [...arr, 0];
  if (typeof sample === 'boolean') return [...arr, false];
  return [...arr, ''];
}
