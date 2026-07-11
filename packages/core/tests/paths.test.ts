import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateComponentPath, validateSchemaPath } from '../src/schema/paths.js';

describe('validateComponentPath', () => {
  it('accepts a valid nested path', () => {
    expect(validateComponentPath('Transform', ['position', 'x'])).toEqual({ ok: true });
  });

  it('rejects an unknown top-level field with a did-you-mean suggestion', () => {
    const check = validateComponentPath('Transform', ['postiion', 'x']);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.failedAt).toBe('Transform.postiion');
      expect(check.validKeys.sort()).toEqual(['position', 'rotation', 'scale']);
      expect(check.suggestions).toContain('position');
    }
  });

  it('rejects an unknown nested field with a did-you-mean suggestion', () => {
    const check = validateComponentPath('Transform', ['position', 'xx']);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.failedAt).toBe('Transform.position.xx');
      expect(check.suggestions).toContain('x');
    }
  });

  it('allows a path to stop early on a whole nested object', () => {
    // Setting the whole `position` object (not drilling into x/y) is legal.
    expect(validateComponentPath('Transform', ['position'])).toEqual({ ok: true });
  });

  it('allows a path to stop early on a whole array field', () => {
    expect(validateComponentPath('Collider', ['points'])).toEqual({ ok: true });
  });

  it('accepts a numeric segment into an array field, then descends into the element', () => {
    expect(validateComponentPath('Collider', ['points', '0', 'x'])).toEqual({ ok: true });
  });

  it('rejects a non-numeric segment into an array field', () => {
    const check = validateComponentPath('Collider', ['points', 'zero', 'x']);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.failedAt).toBe('Collider.points.zero');
    }
  });

  it('accepts any key into a record field (Script.params)', () => {
    expect(validateComponentPath('Script', ['params', 'anythingGoes'])).toEqual({ ok: true });
  });

  it('accepts any key into a record field (Tilemap.tileAssets)', () => {
    expect(validateComponentPath('Tilemap', ['tileAssets', 'G'])).toEqual({ ok: true });
  });

  it('rejects a path that over-specifies past a leaf/primitive field', () => {
    const check = validateComponentPath('Transform', ['rotation', 'degrees']);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.failedAt).toBe('Transform.rotation.degrees');
      expect(check.validKeys).toEqual([]);
    }
  });

  it('rejects an unknown top-level field with no close match: empty suggestions', () => {
    const check = validateComponentPath('Transform', ['zzzzzzzzzz']);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.suggestions).toEqual([]);
    }
  });

  it('accepts a valid nested path into Camera.postEffects (real discriminated union)', () => {
    expect(validateComponentPath('Camera', ['postEffects', '0', 'strength'])).toEqual({ ok: true });
  });

  it('rejects a typo\'d Camera.postEffects field with a did-you-mean suggestion', () => {
    const check = validateComponentPath('Camera', ['postEffects', '0', 'strenght']);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.failedAt).toBe('Camera.postEffects.0.strenght');
      expect(check.suggestions).toContain('strength');
    }
  });
});

describe('validateSchemaPath — union / discriminated union node kinds', () => {
  // Synthetic stand-in for the future Camera.postEffects: z.array(z.discriminatedUnion(...)).
  const PostEffectSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('bloom'), strength: z.number().default(1) }),
    z.object({ type: z.literal('vignette'), radius: z.number().default(100) }),
  ]);
  const SyntheticSchema = z.object({
    postEffects: z.array(PostEffectSchema).default([]),
  });

  it('accepts a segment valid in one option of a discriminated union but not another', () => {
    expect(
      validateSchemaPath(SyntheticSchema, ['postEffects', '0', 'strength'], 'Camera'),
    ).toEqual({ ok: true });
    expect(
      validateSchemaPath(SyntheticSchema, ['postEffects', '0', 'radius'], 'Camera'),
    ).toEqual({ ok: true });
  });

  it('accepts the shared discriminator field across every option', () => {
    expect(validateSchemaPath(SyntheticSchema, ['postEffects', '0', 'type'], 'Camera')).toEqual({
      ok: true,
    });
  });

  it('rejects a segment invalid in every option, aggregating valid keys from all options', () => {
    const check = validateSchemaPath(SyntheticSchema, ['postEffects', '0', 'strenght'], 'Camera');
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.failedAt).toBe('Camera.postEffects.0.strenght');
      expect(check.validKeys.sort()).toEqual(['radius', 'strength', 'type']);
      expect(check.suggestions).toContain('strength');
    }
  });

  it('plain z.union works the same way', () => {
    const schema = z.object({
      value: z.union([z.object({ a: z.number() }), z.object({ b: z.number() })]),
    });
    expect(validateSchemaPath(schema, ['value', 'a'])).toEqual({ ok: true });
    expect(validateSchemaPath(schema, ['value', 'b'])).toEqual({ ok: true });
    const check = validateSchemaPath(schema, ['value', 'c']);
    expect(check.ok).toBe(false);
  });
});
