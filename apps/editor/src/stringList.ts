/**
 * Pure array helpers for the Inspector's StringListField control — the row
 * editor for string[] fields (Collider.collidesWith). Kept separate from
 * Inspector.tsx so the list-editing logic is unit-testable without a DOM.
 */

/** New array with the string at `index` set to `value`. */
export function setStringAt(list: readonly string[], index: number, value: string): string[] {
  return list.map((s, i) => (i === index ? value : s));
}

/**
 * New array without the string at `index`, or null when that would go below
 * `min`. Defaults to min of 0, allowing complete emptying.
 */
export function removeString(list: readonly string[], index: number, min = 0): string[] | null {
  if (list.length <= min) return null;
  return list.filter((_, i) => i !== index);
}

/** New array with an empty string appended. */
export function addString(list: readonly string[]): string[] {
  return [...list, ''];
}
