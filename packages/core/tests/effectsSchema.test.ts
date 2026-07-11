/**
 * Effects data model: PostEffectSchema (Camera.postEffects) and
 * SpriteEffectsSchema, plus their registration into COMPONENT_SCHEMAS/
 * ComponentMap/COMPONENT_DOCS and backward compatibility with pre-0.10
 * scenes that predate Camera.postEffects.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_DOCS,
  COMPONENT_SCHEMAS,
  COMPONENT_TYPES,
  CameraSchema,
  POST_EFFECT_TYPES,
  PostEffectSchema,
  SpriteEffectsSchema,
} from '../src/schema/components.js';
import { MemoryFileSystem, createProject, HearthSession, SceneSchema } from '../src/index.js';

describe('PostEffectSchema', () => {
  it('exposes the six post-effect types', () => {
    expect(POST_EFFECT_TYPES).toEqual([
      'bloom',
      'crt',
      'vignette',
      'chromaticAberration',
      'pixelate',
      'colorGrade',
    ]);
  });

  it('parses each variant with its documented defaults', () => {
    expect(PostEffectSchema.parse({ type: 'bloom' })).toEqual({
      type: 'bloom',
      strength: 1,
      threshold: 0.5,
    });
    expect(PostEffectSchema.parse({ type: 'crt' })).toEqual({
      type: 'crt',
      curvature: 0.15,
      scanlineIntensity: 0.25,
      noise: 0,
    });
    expect(PostEffectSchema.parse({ type: 'vignette' })).toEqual({
      type: 'vignette',
      intensity: 0.4,
      color: '#000000',
    });
    expect(PostEffectSchema.parse({ type: 'chromaticAberration' })).toEqual({
      type: 'chromaticAberration',
      offset: 2,
    });
    expect(PostEffectSchema.parse({ type: 'pixelate' })).toEqual({ type: 'pixelate', size: 4 });
    expect(PostEffectSchema.parse({ type: 'colorGrade' })).toEqual({
      type: 'colorGrade',
      brightness: 1,
      contrast: 1,
      saturation: 1,
      tint: '#ffffff',
    });
  });

  it('rejects an unknown discriminant', () => {
    expect(() => PostEffectSchema.parse({ type: 'nope' })).toThrow();
  });

  it('enforces per-field bounds (e.g. bloom.strength max 3)', () => {
    expect(() => PostEffectSchema.parse({ type: 'bloom', strength: 4 })).toThrow();
  });
});

describe('Camera.postEffects', () => {
  it('defaults to an empty stack — a fresh Camera is a no-op', () => {
    expect(CameraSchema.parse({}).postEffects).toEqual([]);
  });

  it('accepts a stack of mixed effect types', () => {
    const cam = CameraSchema.parse({
      postEffects: [{ type: 'bloom' }, { type: 'vignette', intensity: 0.8 }],
    });
    expect(cam.postEffects).toEqual([
      { type: 'bloom', strength: 1, threshold: 0.5 },
      { type: 'vignette', intensity: 0.8, color: '#000000' },
    ]);
  });

  it('caps the stack at 8 entries', () => {
    const nine = Array.from({ length: 9 }, () => ({ type: 'bloom' as const }));
    expect(() => CameraSchema.parse({ postEffects: nine })).toThrow();
    const eight = Array.from({ length: 8 }, () => ({ type: 'bloom' as const }));
    expect(CameraSchema.parse({ postEffects: eight }).postEffects).toHaveLength(8);
  });
});

describe('SpriteEffectsSchema', () => {
  it('defaults to a fully no-op state', () => {
    expect(SpriteEffectsSchema.parse({})).toEqual({
      outlineEnabled: false,
      outlineColor: '#ffffff',
      outlineWidth: 2,
      flashColor: '#ffffff',
      flashStrength: 0,
      flashDuration: 0.15,
      dissolveAmount: 0,
      dissolveSeed: 0,
    });
  });

  it('enforces flashDuration bounds [0.01, 10]', () => {
    expect(() => SpriteEffectsSchema.parse({ flashDuration: 0 })).toThrow();
    expect(() => SpriteEffectsSchema.parse({ flashDuration: 11 })).toThrow();
    expect(SpriteEffectsSchema.parse({ flashDuration: 0.01 }).flashDuration).toBe(0.01);
  });

  it('enforces flashStrength/dissolveAmount bounds [0, 1]', () => {
    expect(() => SpriteEffectsSchema.parse({ flashStrength: 1.5 })).toThrow();
    expect(() => SpriteEffectsSchema.parse({ dissolveAmount: -0.1 })).toThrow();
  });
});

describe('SpriteEffects registration', () => {
  it('is registered in COMPONENT_SCHEMAS/COMPONENT_TYPES/COMPONENT_DOCS', () => {
    expect(COMPONENT_TYPES).toContain('SpriteEffects');
    expect(COMPONENT_SCHEMAS.SpriteEffects).toBe(SpriteEffectsSchema);
    expect(COMPONENT_DOCS.SpriteEffects).toMatch(/ctx\.effects\.flash/);
  });

  it('inspectComponents lists 19 types, including SpriteEffects defaults', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test' });
    const session = HearthSession.fromStore(store, {});
    const result = await session.execute<{ components: { type: string; defaults: unknown }[] }>(
      'inspectComponents',
      {},
    );
    expect(result.success).toBe(true);
    const components = result.data!.components;
    expect(components).toHaveLength(19);
    const spriteEffects = components.find((c) => c.type === 'SpriteEffects');
    expect(spriteEffects).toBeDefined();
    expect(spriteEffects!.defaults).toEqual({
      outlineEnabled: false,
      outlineColor: '#ffffff',
      outlineWidth: 2,
      flashColor: '#ffffff',
      flashStrength: 0,
      flashDuration: 0.15,
      dissolveAmount: 0,
      dissolveSeed: 0,
    });
  });
});

describe('assertPostEffect playtest step schema', () => {
  it('rejects a step missing active with a clear message', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
    const session = HearthSession.fromStore(store, {});
    const pt = await session.execute('createPlaytest', {
      name: 'invalid',
      scene: 'Main',
      steps: [{ type: 'assertPostEffect', effect: 'bloom' }],
    });
    expect(pt.success).toBe(false);
    expect(pt.errors[0].message).toContain('assertPostEffect requires active (boolean)');
  });

  it('accepts a step with active: true/false', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
    const session = HearthSession.fromStore(store, {});
    const ptTrue = await session.execute('createPlaytest', {
      name: 'active',
      scene: 'Main',
      steps: [{ type: 'assertPostEffect', effect: 'bloom', active: true }],
    });
    expect(ptTrue.success).toBe(true);
    const ptFalse = await session.execute('createPlaytest', {
      name: 'inactive',
      scene: 'Main',
      steps: [{ type: 'assertPostEffect', effect: 'crt', active: false }],
    });
    expect(ptFalse.success).toBe(true);
  });

  it('rejects an unknown effect type', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
    const session = HearthSession.fromStore(store, {});
    const pt = await session.execute('createPlaytest', {
      name: 'bad-effect',
      scene: 'Main',
      steps: [{ type: 'assertPostEffect', effect: 'sparkle', active: true }],
    });
    expect(pt.success).toBe(false);
  });
});

describe('pre-0.10 scene compatibility', () => {
  it('a scene whose Camera lacks postEffects parses with postEffects: []', () => {
    const raw = {
      formatVersion: 1,
      id: 'scn_legacy',
      name: 'Legacy',
      entities: [
        {
          id: 'ent_cam',
          name: 'Camera',
          parentId: null,
          enabled: true,
          tags: [],
          components: {
            Transform: {},
            Camera: {
              zoom: 1,
              isMain: true,
              backgroundColor: '#1a1a2e',
              ambientLight: 1,
              // no postEffects field — pre-0.10 authored data
            },
          },
        },
      ],
    };
    const scene = SceneSchema.parse(raw);
    const cam = scene.entities.find((e) => e.name === 'Camera')!;
    expect(cam.components.Camera!.postEffects).toEqual([]);
  });
});
