/**
 * Procedural chiptune music generation.
 *
 * A tiny, deterministic multi-track sequencer that renders a short looping
 * tune to a real 16-bit PCM mono WAV file, reusing the WAV/PCM infrastructure
 * in ./sounds.ts. The point is to give agent-built games actual background
 * music instead of silence or a single looping SFX blip — the loudest
 * "programmer art" tell there is.
 *
 * Determinism is a hard requirement: the same params must produce
 * byte-identical output on every machine. All randomness (the `noise` wave)
 * comes from a seeded PRNG — Date.now() and Math.random() are forbidden here.
 */

import { SOUND_SAMPLE_RATE, mulberry32, encodeWav } from './sounds.js';

export type MusicWave = 'sine' | 'square' | 'saw' | 'triangle' | 'noise';

export interface MusicTrack {
  wave: MusicWave;
  /** Peak amplitude 0..1. */
  volume: number;
  /** Whitespace-separated tokens: note names (`C4`, `F#3`, `Bb2`), `-` rest, `.` extend previous. */
  notes: string;
}

export interface MusicSpec {
  /** Beats per minute. One token = one sixteenth-note step = (60/tempo)/4 seconds. */
  tempo: number;
  tracks: MusicTrack[];
}

/** Absolute cap on rendered song length (seconds). */
export const MUSIC_MAX_DURATION_SECONDS = 120;

/** Thrown for musical (not schema) input problems: bad tokens, over-length songs. */
export class MusicSynthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MusicSynthError';
  }
}

/** Semitone offset of each natural note from C (within an octave). */
const LETTER_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Convert a note name (`C4`, `F#3`, `Bb2`) to a frequency in Hz using equal
 * temperament with A4 = 440. Throws on a malformed name.
 */
export function noteToFrequency(note: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(note);
  if (!m) throw new MusicSynthError(`Invalid note name "${note}"`);
  const letter = m[1].toUpperCase();
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = parseInt(m[3], 10);
  const semitone = LETTER_SEMITONES[letter] + accidental;
  // MIDI note number; A4 (octave 4, semitone 9) = 69.
  const midi = (octave + 1) * 12 + semitone;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** A run of consecutive steps at one pitch (or a rest when freq is null). */
interface NoteSegment {
  /** Frequency in Hz, or null for a rest. */
  freq: number | null;
  /** Number of sixteenth-note steps this segment lasts. */
  steps: number;
}

/**
 * Parse one track's note string into segments. `.` extends the previous
 * segment by a step (so a note or rest sustains without re-attacking).
 * Returns segments plus the total step count. Throws MusicSynthError, tagged
 * with the 0-based track index, on any malformed token.
 */
function parseTrack(notes: string, trackIndex: number): { segments: NoteSegment[]; totalSteps: number } {
  const tokens = notes.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new MusicSynthError(`Track ${trackIndex} has no notes (empty note string)`);
  }
  const segments: NoteSegment[] = [];
  let totalSteps = 0;
  for (const token of tokens) {
    totalSteps += 1;
    if (token === '.') {
      const last = segments[segments.length - 1];
      if (!last) {
        throw new MusicSynthError(`Bad token "." in track ${trackIndex}: nothing to extend at the start of a track`);
      }
      last.steps += 1;
      continue;
    }
    if (token === '-') {
      segments.push({ freq: null, steps: 1 });
      continue;
    }
    let freq: number;
    try {
      freq = noteToFrequency(token);
    } catch {
      throw new MusicSynthError(`Bad token "${token}" in track ${trackIndex}: expected a note name (C4, F#3, Bb2), "-" rest, or "." extend`);
    }
    segments.push({ freq, steps: 1 });
  }
  return { segments, totalSteps };
}

/** One oscillator sample for the given wave at phase 0..1. rand is only used for noise. */
function oscillator(wave: MusicWave, phase: number, rand: () => number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'square':
      return phase < 0.5 ? 1 : -1;
    case 'saw':
      return 2 * phase - 1;
    case 'triangle':
      return 2 * Math.abs(2 * phase - 1) - 1;
    case 'noise':
      return rand() * 2 - 1;
  }
}

/** Render one parsed track to a mono float buffer of `totalSamples` length. */
function renderTrack(
  segments: NoteSegment[],
  wave: MusicWave,
  volume: number,
  stepSamples: number,
  totalSamples: number,
  seed: number,
): Float64Array {
  const out = new Float64Array(totalSamples);
  const rand = mulberry32(seed);
  // Short per-note attack/release ramps to avoid clicks at segment edges.
  const attack = Math.max(1, Math.round(0.004 * SOUND_SAMPLE_RATE));
  const release = Math.max(1, Math.round(0.008 * SOUND_SAMPLE_RATE));

  let write = 0;
  for (const seg of segments) {
    const samples = seg.steps * stepSamples;
    if (seg.freq === null) {
      write += samples;
      continue; // rest: silence
    }
    let phase = 0;
    const inc = seg.freq / SOUND_SAMPLE_RATE;
    for (let i = 0; i < samples; i++) {
      phase += inc;
      if (phase >= 1) phase -= 1;
      let env = 1;
      if (i < attack) env = i / attack;
      else if (i >= samples - release) env = Math.max(0, (samples - i) / release);
      out[write + i] = oscillator(wave, phase, rand) * env * volume;
    }
    write += samples;
  }
  return out;
}

/**
 * Render a multi-track tune to a complete WAV file (16-bit PCM mono, at
 * SOUND_SAMPLE_RATE). Deterministic: the same spec always yields identical
 * bytes. Returns the WAV plus the per-track step counts (for metadata).
 *
 * Throws MusicSynthError on a malformed token or a song longer than
 * MUSIC_MAX_DURATION_SECONDS.
 */
export function generateMusicWav(spec: MusicSpec): { wav: Uint8Array; trackSteps: number[] } {
  const stepDuration = 60 / spec.tempo / 4; // sixteenth note, seconds
  const parsed = spec.tracks.map((t, i) => parseTrack(t.notes, i));
  const trackSteps = parsed.map((p) => p.totalSteps);
  const maxSteps = Math.max(...trackSteps);
  const totalDuration = maxSteps * stepDuration;
  if (totalDuration > MUSIC_MAX_DURATION_SECONDS) {
    throw new MusicSynthError(
      `Song is ${totalDuration.toFixed(1)}s long, over the ${MUSIC_MAX_DURATION_SECONDS}s cap. Shorten the tracks or raise the tempo.`,
    );
  }

  const stepSamples = Math.round(stepDuration * SOUND_SAMPLE_RATE);
  const totalSamples = maxSteps * stepSamples;
  const mix = new Float64Array(totalSamples);
  for (let t = 0; t < spec.tracks.length; t++) {
    // Seed varies by track index so 'noise' tracks diverge deterministically.
    const rendered = renderTrack(parsed[t].segments, spec.tracks[t].wave, spec.tracks[t].volume, stepSamples, totalSamples, t + 1);
    for (let i = 0; i < totalSamples; i++) mix[i] += rendered[i];
  }

  // Normalize only when the summed mix would clip; quiet mixes pass through
  // unchanged. encodeWav also hard-clamps, but normalizing preserves the
  // waveform instead of squaring it off.
  let peak = 0;
  for (let i = 0; i < totalSamples; i++) peak = Math.max(peak, Math.abs(mix[i]));
  if (peak > 1) {
    for (let i = 0; i < totalSamples; i++) mix[i] /= peak;
  }

  return { wav: encodeWav(mix, SOUND_SAMPLE_RATE), trackSteps };
}
