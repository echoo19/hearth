/**
 * Per-sprite visual effects (SpriteEffects component, Task 5 → Task 6): a
 * single combined Pixi v8 GLSL filter that does outline, hit-flash, and
 * dissolve in one pass, attached to an entity's display node only while at
 * least one field is non-neutral.
 *
 * The no-op invariant is load-bearing: a SpriteEffects component left at its
 * schema defaults (outline off, flashStrength 0, dissolveAmount 0) must render
 * byte-identical to having no component at all. A filter — even an identity
 * shader — round-trips the node through an offscreen texture and can perturb
 * pixels, so the neutral case attaches NO filter (`node.filters = null`)
 * rather than an identity one.
 *
 * Determinism: dissolve is a per-texel hash of the pixel position + seed, so
 * the same seed dissolves the same texels every run — no RNG, no time input.
 */
import { Filter, defaultFilterVert, type Container } from 'pixi.js';
import type { SpriteEffectsComponent } from '@hearth/core';
import { hexToRgb01 } from './color.js';

// `uInputSize` is declared highp in Pixi's default filter vertex; the fragment
// must match its precision or the program won't link, so pin it highp
// explicitly (see postEffects.ts for the full note).
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform float uOutlineEnabled;
uniform vec3 uOutlineColor;
uniform float uOutlineWidth;
uniform vec3 uFlashColor;
uniform float uFlashStrength;
uniform float uDissolveAmount;
uniform float uDissolveSeed;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec4 color = texture(uTexture, vTextureCoord);

  // Dissolve: deterministic per-texel threshold discard.
  if (uDissolveAmount > 0.0) {
    float n = hash(floor(vTextureCoord * uInputSize.xy) + uDissolveSeed);
    if (n < uDissolveAmount) color = vec4(0.0);
  }

  // Flash: mix toward flashColor (operate on straight color, re-premultiply).
  if (uFlashStrength > 0.0 && color.a > 0.0) {
    vec3 straight = color.rgb / color.a;
    straight = mix(straight, uFlashColor, uFlashStrength);
    color.rgb = straight * color.a;
  }

  // Outline: color transparent texels that neighbor an opaque one.
  if (uOutlineEnabled > 0.5 && color.a < 0.5) {
    vec2 s = uInputSize.zw * uOutlineWidth;
    float a = 0.0;
    a = max(a, texture(uTexture, vTextureCoord + vec2( s.x, 0.0)).a);
    a = max(a, texture(uTexture, vTextureCoord + vec2(-s.x, 0.0)).a);
    a = max(a, texture(uTexture, vTextureCoord + vec2(0.0,  s.y)).a);
    a = max(a, texture(uTexture, vTextureCoord + vec2(0.0, -s.y)).a);
    a = max(a, texture(uTexture, vTextureCoord + vec2( s.x,  s.y)).a);
    a = max(a, texture(uTexture, vTextureCoord + vec2(-s.x,  s.y)).a);
    a = max(a, texture(uTexture, vTextureCoord + vec2( s.x, -s.y)).a);
    a = max(a, texture(uTexture, vTextureCoord + vec2(-s.x, -s.y)).a);
    if (a > 0.5) color = vec4(uOutlineColor, 1.0);
  }

  finalColor = color;
}
`;

/** Cached filter per display node (created lazily, reused across frames). */
const filters = new WeakMap<Container, Filter>();

/** True when the component has no visible effect and should attach no filter. */
function isNeutral(fx: SpriteEffectsComponent): boolean {
  return !fx.outlineEnabled && fx.flashStrength <= 0 && fx.dissolveAmount <= 0;
}

function makeFilter(): Filter {
  return Filter.from({
    gl: { vertex: defaultFilterVert, fragment: FRAGMENT, name: 'hearth-sprite-effects' },
    resources: {
      fx: {
        uOutlineEnabled: { value: 0, type: 'f32' },
        uOutlineColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
        uOutlineWidth: { value: 2, type: 'f32' },
        uFlashColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
        uFlashStrength: { value: 0, type: 'f32' },
        uDissolveAmount: { value: 0, type: 'f32' },
        uDissolveSeed: { value: 0, type: 'f32' },
      },
    },
  });
}

/**
 * Attach, update, or detach the combined SpriteEffects filter on `node` to
 * match `fx`. Detaches (sets `node.filters = null`) when the component is
 * absent or fully neutral, so the default-component case stays a pixel no-op.
 */
export function syncSpriteEffectsFilter(
  node: Container,
  fx: SpriteEffectsComponent | undefined,
): void {
  if (!fx || isNeutral(fx)) {
    if (node.filters) node.filters = null;
    return;
  }

  let filter = filters.get(node);
  if (!filter) {
    filter = makeFilter();
    filters.set(node, filter);
  }

  const u = (filter.resources as { fx: { uniforms: Record<string, number | Float32Array> } }).fx
    .uniforms;
  u.uOutlineEnabled = fx.outlineEnabled ? 1 : 0;
  const oc = u.uOutlineColor as Float32Array;
  [oc[0], oc[1], oc[2]] = hexToRgb01(fx.outlineColor);
  u.uOutlineWidth = fx.outlineWidth;
  const fc = u.uFlashColor as Float32Array;
  [fc[0], fc[1], fc[2]] = hexToRgb01(fx.flashColor);
  u.uFlashStrength = fx.flashStrength;
  u.uDissolveAmount = fx.dissolveAmount;
  u.uDissolveSeed = fx.dissolveSeed;

  // Outline halos bleed outside the sprite's own bounds; pad so they aren't
  // clipped by the filter region (0 when outline is off).
  filter.padding = fx.outlineEnabled ? fx.outlineWidth + 1 : 0;

  const current = node.filters as Filter[] | null | undefined;
  if (!current || current[0] !== filter) node.filters = [filter];
}
