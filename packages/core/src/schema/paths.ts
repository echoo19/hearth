/**
 * Strict property-path validation against a component's Zod schema shape.
 *
 * `setComponentProperty`/`setProperties` used to accept any dot path and let
 * `safeParse` decide whether the result was valid — but Zod objects strip
 * unknown keys by default, so a typo like `Transform.postiion.x` silently
 * wrote to a throwaway key and "succeeded", corrupting agent-driven builds
 * without any error. `validateComponentPath` walks the path against the
 * schema shape itself (not just the final parsed value) so a bad segment is
 * caught immediately, with a did-you-mean suggestion.
 */
import { z } from 'zod';
import { COMPONENT_SCHEMAS, type ComponentType } from './components.js';

export type PathCheck =
  | { ok: true }
  | { ok: false; failedAt: string; validKeys: string[]; suggestions: string[] };

/** Classic Levenshtein edit distance between two strings. No dependency. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/** validKeys within edit distance 2 of `segment`, closest first. */
function suggestionsFor(segment: string, validKeys: string[]): string[] {
  return validKeys
    .map((key) => ({ key, dist: levenshtein(segment, key) }))
    .filter((s) => s.dist <= 2)
    .sort((a, b) => a.dist - b.dist)
    .map((s) => s.key);
}

/**
 * Unwraps `.default(...)`/`.optional()`/`.nullable()` wrappers, same loop
 * shape as `enumOptions` (components.ts). Exported so other passes that need
 * to reach a field's "real" node — e.g. validate.ts's unknown-key warning —
 * don't duplicate the unwrap loop.
 */
export function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  ) {
    current = current instanceof z.ZodDefault ? current._def.innerType : current.unwrap();
  }
  return current;
}

function fail(prefix: string[], segment: string, validKeys: string[]): PathCheck {
  return {
    ok: false,
    failedAt: [...prefix, segment].join('.'),
    validKeys,
    suggestions: suggestionsFor(segment, validKeys),
  };
}

/**
 * Walks `parts` against `node`. `prefix` is the dotted path (including the
 * component type) walked so far, used to build `failedAt`. A path may stop
 * early — assigning a whole nested object/array wholesale is legal — so this
 * only rejects when a *remaining* segment can't be resolved at its node.
 */
function walk(node: z.ZodTypeAny, parts: string[], prefix: string[]): PathCheck {
  if (parts.length === 0) return { ok: true };
  const [segment, ...rest] = parts;
  const shape = unwrap(node);

  if (shape instanceof z.ZodObject) {
    const fields = shape.shape as Record<string, z.ZodTypeAny>;
    const validKeys = Object.keys(fields);
    if (!Object.prototype.hasOwnProperty.call(fields, segment)) {
      return fail(prefix, segment, validKeys);
    }
    return walk(fields[segment], rest, [...prefix, segment]);
  }

  if (shape instanceof z.ZodArray) {
    if (!/^\d+$/.test(segment)) return fail(prefix, segment, []);
    return walk(shape.element, rest, [...prefix, segment]);
  }

  if (shape instanceof z.ZodRecord) {
    // Any key is a legal record entry; descend into the record's value schema.
    return walk(shape.valueSchema, rest, [...prefix, segment]);
  }

  if (shape instanceof z.ZodDiscriminatedUnion || shape instanceof z.ZodUnion) {
    const options: z.ZodTypeAny[] = [...shape.options];
    const results = options.map((option) => walk(option, parts, prefix));
    const match = results.find((r) => r.ok);
    if (match) return match;
    // No option accepted this segment: aggregate every option's valid keys
    // at this node so the suggestion/valid-keys list stays useful.
    const validKeys = Array.from(
      new Set(results.flatMap((r) => (r.ok ? [] : r.validKeys))),
    );
    return fail(prefix, segment, validKeys);
  }

  // A leaf/primitive node (string, number, boolean, enum, ...) can't be
  // descended into further, but a segment remains to place — over-specified.
  return fail(prefix, segment, []);
}

/**
 * General form of the walk, exported so tests can exercise node kinds (e.g.
 * a `z.discriminatedUnion(...)` field like the future `Camera.postEffects`)
 * against a synthetic schema without needing a real registered component.
 */
export function validateSchemaPath(schema: z.ZodTypeAny, pathParts: string[], rootLabel = '$'): PathCheck {
  return walk(schema, pathParts, [rootLabel]);
}

/** Validates `pathParts` (the dot path *after* the leading component type) against `type`'s schema. */
export function validateComponentPath(type: ComponentType, pathParts: string[]): PathCheck {
  return validateSchemaPath(COMPONENT_SCHEMAS[type], pathParts, type);
}
