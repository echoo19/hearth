/**
 * Procedural sound effect generation.
 *
 * A small, deterministic jsfxr-style synthesizer that renders short SFX
 * presets to real 16-bit PCM mono WAV files (44.1kHz), so agents can give a
 * game working audio before real sound design exists.
 *
 * Determinism is a hard requirement: the same preset + seed must produce
 * byte-identical output on every machine. All randomness comes from a seeded
 * PRNG — Date.now() and Math.random() are forbidden in this file.
 */

export const SOUND_PRESETS = ['coin', 'jump', 'hit', 'laser', 'powerup', 'explosion', 'blip'] as const;
export type SoundPreset = (typeof SOUND_PRESETS)[number];

export const SOUND_SAMPLE_RATE = 44100;

/** Mulberry32: tiny, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Wave = 'sine' | 'square' | 'saw' | 'noise';

/** One tone/noise segment; segments are rendered back to back. */
interface Segment {
  wave: Wave;
  /** Seconds. */
  duration: number;
  freqStart: number;
  /** Exponential slide target; defaults to freqStart (no slide). */
  freqEnd?: number;
  /** Peak amplitude 0..1. */
  volume?: number;
  /** Decay curve exponent: 0 = flat, 1 = linear fade, >1 = faster fade. */
  decay?: number;
  /** For noise: samples to hold each random value (lower = brighter hiss). */
  noiseHold?: number;
}

/** Build the segment list for a preset. `rand` adds slight seeded variation. */
function presetSegments(preset: SoundPreset, rand: () => number): Segment[] {
  /** Small deterministic detune around 1.0 (+/- spread/2). */
  const jitter = (spread: number) => 1 + (rand() - 0.5) * spread;
  switch (preset) {
    case 'coin': {
      // Bright two-note square blip up (B5 -> E6), second note rings out.
      const j = jitter(0.06);
      return [
        { wave: 'square', duration: 0.07, freqStart: 987.77 * j, volume: 0.5, decay: 0 },
        { wave: 'square', duration: 0.3, freqStart: 1318.51 * j, volume: 0.5, decay: 1.6 },
      ];
    }
    case 'jump': {
      // Rising square sweep with a mild fade.
      const j = jitter(0.1);
      return [{ wave: 'square', duration: 0.28, freqStart: 160 * j, freqEnd: 640 * j, volume: 0.45, decay: 0.8 }];
    }
    case 'hit': {
      // Short bright noise burst with a hard decay.
      return [{ wave: 'noise', duration: 0.16, freqStart: 0, volume: 0.7, decay: 2.2, noiseHold: 2 + Math.floor(rand() * 2) }];
    }
    case 'laser': {
      // Fast saw down-sweep.
      const j = jitter(0.1);
      return [{ wave: 'saw', duration: 0.16, freqStart: 1760 * j, freqEnd: 220, volume: 0.5, decay: 1.1 }];
    }
    case 'powerup': {
      // Arpeggiated rise (major-chord steps), last note held.
      const base = 392 * jitter(0.08); // ~G4
      const ratios = [1, 1.26, 1.5, 2];
      return ratios.map((r, i) => ({
        wave: 'square' as Wave,
        duration: i === ratios.length - 1 ? 0.22 : 0.09,
        freqStart: base * r,
        volume: 0.45,
        decay: i === ratios.length - 1 ? 1.4 : 0.3,
      }));
    }
    case 'explosion': {
      // Long low rumbling noise burst with a slow decay.
      return [{ wave: 'noise', duration: 0.7, freqStart: 0, volume: 0.85, decay: 1.7, noiseHold: 7 + Math.floor(rand() * 4) }];
    }
    case 'blip': {
      // Tiny square tick.
      const j = jitter(0.1);
      return [{ wave: 'square', duration: 0.09, freqStart: 900 * j, volume: 0.4, decay: 1.2 }];
    }
  }
}

/** Render segments to mono float samples in [-1, 1]. */
function renderSegments(segments: Segment[], rand: () => number): Float64Array {
  const totalSamples = segments.reduce((n, s) => n + Math.round(s.duration * SOUND_SAMPLE_RATE), 0);
  const out = new Float64Array(totalSamples);
  let write = 0;
  const attackSamples = Math.round(0.002 * SOUND_SAMPLE_RATE); // declick

  for (const seg of segments) {
    const samples = Math.round(seg.duration * SOUND_SAMPLE_RATE);
    const volume = seg.volume ?? 0.5;
    const decay = seg.decay ?? 1;
    const freqEnd = seg.freqEnd ?? seg.freqStart;
    let phase = 0;
    let noiseValue = rand() * 2 - 1;
    let noiseNext = rand() * 2 - 1;
    let noiseCounter = 0;
    const noiseHold = Math.max(1, seg.noiseHold ?? 1);

    for (let i = 0; i < samples; i++) {
      const t = i / samples; // 0..1 through the segment
      // Exponential frequency slide.
      const freq = seg.freqStart > 0 ? seg.freqStart * Math.pow(freqEnd / seg.freqStart, t) : 0;
      phase += freq / SOUND_SAMPLE_RATE;
      if (phase >= 1) phase -= 1;

      let sample: number;
      switch (seg.wave) {
        case 'sine':
          sample = Math.sin(2 * Math.PI * phase);
          break;
        case 'square':
          sample = phase < 0.5 ? 1 : -1;
          break;
        case 'saw':
          sample = 2 * phase - 1;
          break;
        case 'noise': {
          if (noiseCounter <= 0) {
            noiseValue = noiseNext;
            noiseNext = rand() * 2 - 1;
            noiseCounter = noiseHold;
          }
          // Linear interpolation between held values: a cheap lowpass so
          // larger noiseHold values sound like a deeper rumble.
          sample = noiseValue + (noiseNext - noiseValue) * (1 - noiseCounter / noiseHold);
          noiseCounter--;
          break;
        }
      }

      let env = decay === 0 ? 1 : Math.pow(1 - t, decay);
      if (i < attackSamples) env *= i / attackSamples;
      out[write + i] = sample * env * volume;
    }
    write += samples;
  }
  return out;
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
function encodeWav(samples: Float64Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
}

/**
 * Generate a preset sound effect as a complete WAV file (16-bit PCM mono,
 * 44.1kHz). Deterministic: the same preset + seed always yields identical
 * bytes.
 */
export function generateSoundWav(preset: SoundPreset, seed = 0): Uint8Array {
  // Mix the preset name into the seed so e.g. coin(0) and jump(0) diverge
  // even where their PRNG draw counts happen to line up.
  let mixed = seed >>> 0;
  for (let i = 0; i < preset.length; i++) mixed = (Math.imul(mixed, 31) + preset.charCodeAt(i)) >>> 0;
  const rand = mulberry32(mixed);
  const samples = renderSegments(presetSegments(preset, rand), rand);
  return encodeWav(samples, SOUND_SAMPLE_RATE);
}
