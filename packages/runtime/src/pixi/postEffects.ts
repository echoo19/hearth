/**
 * Screen-space post-processing filters for Camera.postEffects. Each
 * PostEffect variant maps to one hand-written
 * Pixi v8 GLSL filter applied, in stack order, to the game-view container.
 *
 * Design notes:
 *   - Filters are cached per view and rebuilt only when the stack's SHAPE
 *     (length + per-entry effect types) changes — per effect type the uniform
 *     layout is fixed, and uniform VALUES are refreshed every syncCamera call
 *     anyway, so a value change never needs a GPU-program rebuild. The shape
 *     check is a tiny loop with zero per-frame allocation (no JSON.stringify).
 *   - The one per-frame uniform is CRT's `uFrame` (fed from runtime.frame),
 *     so its noise is deterministic and frame-derived — never Date.now /
 *     Math.random, which would break headless/screenshot reproducibility.
 *   - Only a WebGL (`gl`) program is provided: PixiSceneView inits with the
 *     default renderer preference (webgl first), and hand-writing WGSL too
 *     would double the shader surface for no shipped benefit. If a build ever
 *     ran on WebGPU, an effect with no gpuProgram is simply skipped (the frame
 *     still renders), never a crash.
 *   - All shaders share Pixi's default filter vertex (`defaultFilterVert`),
 *     which exposes `vTextureCoord` plus the filter-system globals
 *     `uInputSize` / `uOutputFrame`. `uInputSize.xy` is the (padded) input
 *     texture size, `uOutputFrame.zw` the visible region size in px, so
 *     `uvN = vTextureCoord * uInputSize.xy / uOutputFrame.zw` is a 0..1
 *     coordinate across the visible frame regardless of texture-pool padding.
 */
import { Filter, defaultFilterVert } from 'pixi.js';
import type { PostEffect } from '@hearth/core';
import { hexToRgb01 } from './color.js';

/** Per-view cache: the filter instances for the current stack and their effect types. */
export interface PostEffectFilterState {
  /** Effect type per cached filter, index-aligned with `filters`. */
  types: PostEffect['type'][];
  filters: Filter[];
}

export function createPostEffectFilterState(): PostEffectFilterState {
  return { types: [], filters: [] };
}

type UniformDecl = Record<string, { value: number | Float32Array; type: string }>;

/** Access a filter's `fx` uniform group (auto-wrapped from the resources object). */
function fxUniforms(filter: Filter): Record<string, number | Float32Array> {
  return (filter.resources as { fx: { uniforms: Record<string, number | Float32Array> } }).fx
    .uniforms;
}

function makeFilter(fragment: string, uniforms: UniformDecl): Filter {
  return Filter.from({
    gl: { vertex: defaultFilterVert, fragment, name: 'hearth-post-effect' },
    resources: { fx: uniforms },
  });
}

// Shared GLSL prelude: input sampler, filter-system globals, and the
// visible-frame normalization helper described in the module header. The
// `#version 300 es` line is what flips Pixi's GlProgram into its ES300
// preprocessor path (strip → ensure-precision → re-insert version), so the
// `in`/`out`/`texture()` syntax below — and in the shared default vertex —
// compiles; without it the program links as GLSL ES 1.00 and fails.
// The filter-system globals uInputSize/uOutputFrame are declared `highp` in
// Pixi's default vertex; the fragment must match their precision or the
// program fails to link ("precisions of uniform differ between VERTEX and
// FRAGMENT shaders"), so pin them highp explicitly (an inline qualifier
// survives Pixi's precision preprocessor even on a highp-less device).
const HEAD = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;
vec2 hearthNorm() {
  return vTextureCoord * uInputSize.xy / uOutputFrame.zw;
}
vec2 hearthToCoord(vec2 n) {
  return n * uOutputFrame.zw * uInputSize.zw;
}
`;

const BLOOM_FRAG = `${HEAD}
uniform float uStrength;
uniform float uThreshold;
vec3 bright(vec2 uv) {
  vec3 c = texture(uTexture, uv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  return l > uThreshold ? c : vec3(0.0);
}
void main() {
  vec4 base = texture(uTexture, vTextureCoord);
  vec2 texel = uInputSize.zw * 2.0;
  vec3 sum = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += bright(vTextureCoord + vec2(float(x), float(y)) * texel);
    }
  }
  finalColor = vec4(base.rgb + (sum / 9.0) * uStrength, base.a);
}
`;

const CRT_FRAG = `${HEAD}
uniform float uCurvature;
uniform float uScanline;
uniform float uNoise;
uniform float uFrame;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec2 n = hearthNorm();
  vec2 cc = n - 0.5;
  vec2 warped = n + cc * dot(cc, cc) * uCurvature;
  vec4 color = texture(uTexture, hearthToCoord(warped));
  if (warped.x < 0.0 || warped.x > 1.0 || warped.y < 0.0 || warped.y > 1.0) {
    color = vec4(0.0);
  }
  float row = warped.y * uOutputFrame.w;
  color.rgb *= 1.0 - uScanline * (0.5 + 0.5 * sin(row * 3.14159265));
  if (uNoise > 0.0) {
    float g = hash(floor(warped * uOutputFrame.zw) + uFrame) - 0.5;
    color.rgb += g * uNoise;
  }
  finalColor = color;
}
`;

const VIGNETTE_FRAG = `${HEAD}
uniform float uIntensity;
uniform vec3 uColor;
void main() {
  vec4 color = texture(uTexture, vTextureCoord);
  float d = distance(hearthNorm(), vec2(0.5));
  float v = smoothstep(0.35, 0.75, d) * uIntensity;
  color.rgb = mix(color.rgb, uColor, v);
  finalColor = color;
}
`;

const CHROMATIC_FRAG = `${HEAD}
uniform float uOffset;
void main() {
  vec2 dir = normalize(hearthNorm() - 0.5 + vec2(1e-5));
  vec2 o = dir * uOffset * uInputSize.zw;
  vec4 c = texture(uTexture, vTextureCoord);
  float r = texture(uTexture, vTextureCoord + o).r;
  float b = texture(uTexture, vTextureCoord - o).b;
  finalColor = vec4(r, c.g, b, c.a);
}
`;

const PIXELATE_FRAG = `${HEAD}
uniform float uSize;
void main() {
  vec2 blocks = uOutputFrame.zw / max(uSize, 1.0);
  vec2 quant = (floor(hearthNorm() * blocks) + 0.5) / blocks;
  finalColor = texture(uTexture, hearthToCoord(quant));
}
`;

const COLOR_GRADE_FRAG = `${HEAD}
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uTint;
void main() {
  vec4 color = texture(uTexture, vTextureCoord);
  vec3 rgb = color.rgb;
  if (color.a > 0.0) rgb /= color.a;
  rgb *= uBrightness;
  rgb = (rgb - 0.5) * uContrast + 0.5;
  float l = dot(rgb, vec3(0.299, 0.587, 0.114));
  rgb = mix(vec3(l), rgb, uSaturation);
  rgb *= uTint;
  finalColor = vec4(clamp(rgb, 0.0, 1.0) * color.a, color.a);
}
`;

/** Build the filter for one effect, seeding its uniforms from the effect data. */
function buildFilter(effect: PostEffect): Filter {
  switch (effect.type) {
    case 'bloom':
      return makeFilter(BLOOM_FRAG, {
        uStrength: { value: effect.strength, type: 'f32' },
        uThreshold: { value: effect.threshold, type: 'f32' },
      });
    case 'crt':
      return makeFilter(CRT_FRAG, {
        uCurvature: { value: effect.curvature, type: 'f32' },
        uScanline: { value: effect.scanlineIntensity, type: 'f32' },
        uNoise: { value: effect.noise, type: 'f32' },
        uFrame: { value: 0, type: 'f32' },
      });
    case 'vignette':
      return makeFilter(VIGNETTE_FRAG, {
        uIntensity: { value: effect.intensity, type: 'f32' },
        uColor: { value: new Float32Array(hexToRgb01(effect.color)), type: 'vec3<f32>' },
      });
    case 'chromaticAberration':
      return makeFilter(CHROMATIC_FRAG, {
        uOffset: { value: effect.offset, type: 'f32' },
      });
    case 'pixelate':
      return makeFilter(PIXELATE_FRAG, {
        uSize: { value: effect.size, type: 'f32' },
      });
    case 'colorGrade':
      return makeFilter(COLOR_GRADE_FRAG, {
        uBrightness: { value: effect.brightness, type: 'f32' },
        uContrast: { value: effect.contrast, type: 'f32' },
        uSaturation: { value: effect.saturation, type: 'f32' },
        uTint: { value: new Float32Array(hexToRgb01(effect.tint)), type: 'vec3<f32>' },
      });
  }
}

/** Refresh a filter's uniforms from the (unchanged-shape) effect data + frame. */
function updateFilter(filter: Filter, effect: PostEffect, frame: number): void {
  const u = fxUniforms(filter);
  switch (effect.type) {
    case 'bloom':
      u.uStrength = effect.strength;
      u.uThreshold = effect.threshold;
      break;
    case 'crt':
      u.uCurvature = effect.curvature;
      u.uScanline = effect.scanlineIntensity;
      u.uNoise = effect.noise;
      u.uFrame = frame;
      break;
    case 'vignette': {
      u.uIntensity = effect.intensity;
      const c = u.uColor as Float32Array;
      [c[0], c[1], c[2]] = hexToRgb01(effect.color);
      break;
    }
    case 'chromaticAberration':
      u.uOffset = effect.offset;
      break;
    case 'pixelate':
      u.uSize = effect.size;
      break;
    case 'colorGrade': {
      u.uBrightness = effect.brightness;
      u.uContrast = effect.contrast;
      u.uSaturation = effect.saturation;
      const t = u.uTint as Float32Array;
      [t[0], t[1], t[2]] = hexToRgb01(effect.tint);
      break;
    }
  }
}

/** True when the cached filter list no longer matches the stack's length/types. */
function shapeChanged(state: PostEffectFilterState, stack: PostEffect[]): boolean {
  if (state.types.length !== stack.length) return true;
  for (let i = 0; i < stack.length; i++) {
    if (state.types[i] !== stack[i].type) return true;
  }
  return false;
}

/**
 * Reconcile `state`'s cached filters with `stack`, returning the Filter[] to
 * assign to the game-view container (or null when the stack is empty, so the
 * container renders with `filters = null` — byte-identical to no effects).
 * Rebuilds the GPU programs only when the stack's shape (length/types)
 * changes; otherwise just refreshes uniforms (including CRT's per-frame
 * `uFrame`) — see the module header for why value changes never rebuild.
 */
export function syncPostEffectFilters(
  state: PostEffectFilterState,
  stack: PostEffect[],
  frame: number,
): Filter[] | null {
  if (stack.length === 0) {
    state.types = [];
    state.filters = [];
    return null;
  }
  if (shapeChanged(state, stack)) {
    state.types = stack.map((e) => e.type);
    state.filters = stack.map(buildFilter);
  }
  for (let i = 0; i < stack.length; i++) updateFilter(state.filters[i], stack[i], frame);
  return state.filters;
}
