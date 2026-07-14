/**
 * INSPSPEC-1 — every bounded numeric field of every post-effect must carry a
 * client-side min/max (and `.int()` flag) so an out-of-range or non-integer
 * value is rejected in the field (revert + cue) instead of committed and
 * silently refused by the server.
 *
 * The expected map is built by introspecting PostEffectSchema itself (zod
 * `_def.checks` on each numeric field, unwrapped from `.default()`), then
 * compared against EFFECT_FIELD_RANGES in BOTH directions — so a schema bound
 * added, changed, or removed without updating the UI map fails here rather
 * than regressing the silent-rejection bug.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PostEffectSchema } from '@hearth/core';
import { EFFECT_FIELD_RANGES } from '../src/components/PostEffectsField';

/** Unwrap ZodDefault/ZodOptional wrappers down to the base type. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur = schema;
  while (cur instanceof z.ZodDefault || cur instanceof z.ZodOptional) {
    cur = cur._def.innerType as z.ZodTypeAny;
  }
  return cur;
}

/** Build `type.field` -> { min, max, int? } from the live schema. */
function schemaRanges(): Record<string, { min: number; max: number; int?: boolean }> {
  const out: Record<string, { min: number; max: number; int?: boolean }> = {};
  for (const option of PostEffectSchema.options) {
    const shape = option.shape as Record<string, z.ZodTypeAny>;
    const type = (unwrap(shape.type) as z.ZodLiteral<string>).value;
    for (const [field, fieldSchema] of Object.entries(shape)) {
      if (field === 'type') continue;
      const base = unwrap(fieldSchema);
      if (!(base instanceof z.ZodNumber)) continue; // color fields etc.
      let min: number | undefined;
      let max: number | undefined;
      let int = false;
      for (const check of base._def.checks) {
        if (check.kind === 'min') min = check.value;
        if (check.kind === 'max') max = check.value;
        if (check.kind === 'int') int = true;
      }
      // Every current numeric effect field is bounded; a new unbounded one
      // must be a deliberate decision, so surface it here.
      expect(min, `${type}.${field} has no .min() in the schema`).toBeDefined();
      expect(max, `${type}.${field} has no .max() in the schema`).toBeDefined();
      out[`${type}.${field}`] = int
        ? { min: min as number, max: max as number, int: true }
        : { min: min as number, max: max as number };
    }
  }
  return out;
}

describe('EFFECT_FIELD_RANGES', () => {
  it('matches the zod schema bounds exactly, in both directions', () => {
    expect(EFFECT_FIELD_RANGES).toEqual(schemaRanges());
  });

  it('flags integer-only fields from the schema (.int())', () => {
    const fromSchema = schemaRanges();
    const intKeys = Object.keys(fromSchema).filter((k) => fromSchema[k].int);
    expect(intKeys).toContain('pixelate.size');
    for (const key of intKeys) {
      expect(EFFECT_FIELD_RANGES[key]?.int, `${key} must set int: true`).toBe(true);
    }
  });
});
