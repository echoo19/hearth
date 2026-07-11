/**
 * Pure stack helpers for the Inspector's PostEffectsField control — the
 * typed card editor for Camera.postEffects (PostEffect[], a discriminated
 * union stack), replacing JsonField's raw JSON textarea. Kept separate from
 * PostEffectsField.tsx so the stack-editing logic is unit-testable without a
 * DOM, matching vec2List.ts/tileAssetsList.ts for the other array/row
 * editors.
 */
import { PostEffectSchema, type PostEffect, type PostEffectType } from '@hearth/core';

/** Camera.postEffects.max(8) in the schema — add is disabled at this cap. */
export const POST_EFFECTS_MAX = 8;

/** Schema defaults for a fresh effect of `type` — every field at its neutral (no-op-ish) default. */
export function defaultPostEffect(type: PostEffectType): PostEffect {
  return PostEffectSchema.parse({ type });
}

/**
 * New stack with a fresh default-valued `type` effect appended, or `null`
 * when the stack is already at POST_EFFECTS_MAX (mirrors removePoint's
 * null-signals-no-op convention; the "Add effect" control also disables
 * itself at the cap, so this is a defensive backstop).
 */
export function addEffect(stack: readonly PostEffect[], type: PostEffectType): PostEffect[] | null {
  if (stack.length >= POST_EFFECTS_MAX) return null;
  return [...stack, defaultPostEffect(type)];
}

/** New stack without the effect at `index`. */
export function removeEffect(stack: readonly PostEffect[], index: number): PostEffect[] {
  return stack.filter((_, i) => i !== index);
}

/**
 * New stack with the effect at `index` swapped with its `dir` neighbor
 * (-1 = up/earlier, +1 = down/later), or `null` when that neighbor is out of
 * bounds (already first/last).
 */
export function moveEffect(stack: readonly PostEffect[], index: number, dir: -1 | 1): PostEffect[] | null {
  const target = index + dir;
  if (index < 0 || index >= stack.length || target < 0 || target >= stack.length) return null;
  const next = stack.slice();
  const tmp = next[index];
  next[index] = next[target];
  next[target] = tmp;
  return next;
}

/**
 * New stack with a single field of the effect at `index` set to `value`
 * (the effect's `type` — and so its variant — is never touched here;
 * swapping variants means removing and re-adding a fresh default effect).
 */
export function updateEffect(
  stack: readonly PostEffect[],
  index: number,
  field: string,
  value: unknown,
): PostEffect[] {
  return stack.map((effect, i) => (i === index ? { ...effect, [field]: value } : effect)) as PostEffect[];
}
