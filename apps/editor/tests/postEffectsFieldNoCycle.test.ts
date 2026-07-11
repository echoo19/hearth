import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * PostEffectsField.tsx used to import {ColorField, NumberField} from
 * './Inspector', while Inspector.tsx imports {PostEffectsField} from
 * './PostEffectsField' — a circular import that only worked because of
 * module hoisting. The shared field primitives (NumberField/ColorField/
 * TextField) live in ui.tsx now, which both modules already import
 * independently, so the cycle is gone. This guards against it coming back:
 * a source-level check (no accidental re-import from Inspector.tsx) plus an
 * isolated module import (the cycle, if reintroduced, can produce
 * `undefined` exports depending on import order — importing PostEffectsField
 * on its own, with no prior import of Inspector.tsx in this test file,
 * exercises the worst case).
 */
const postEffectsFieldPath = fileURLToPath(
  new URL('../src/components/PostEffectsField.tsx', import.meta.url),
);

describe('PostEffectsField import graph', () => {
  it('does not import from Inspector.tsx', async () => {
    const src = await readFile(postEffectsFieldPath, 'utf8');
    expect(src).not.toMatch(/from ['"]\.\/Inspector['"]/);
  });

  it('imports its shared field primitives from ui.tsx', async () => {
    const src = await readFile(postEffectsFieldPath, 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*\bColorField\b[^}]*\bNumberField\b[^}]*\}\s*from\s*['"]\.\/ui['"]/);
  });

  it('resolves the shared field primitives when imported in isolation', async () => {
    const mod = await import('../src/components/PostEffectsField');
    expect(typeof mod.PostEffectsField).toBe('function');
    expect(typeof mod.humanize).toBe('function');
  });
});
