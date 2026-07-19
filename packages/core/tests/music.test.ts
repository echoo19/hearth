import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  generateMusicWav,
  noteToFrequency,
  MusicSynthError,
  SOUND_SAMPLE_RATE,
} from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Music Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true);
}
function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}
function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

describe('note name to frequency', () => {
  it('uses equal temperament with A4 = 440', () => {
    expect(noteToFrequency('A4')).toBeCloseTo(440, 6);
    expect(noteToFrequency('A5')).toBeCloseTo(880, 6);
    expect(noteToFrequency('A3')).toBeCloseTo(220, 6);
    expect(noteToFrequency('C4')).toBeCloseTo(261.6256, 3);
    // Enharmonic equivalence: F#3 === Gb3
    expect(noteToFrequency('F#3')).toBeCloseTo(noteToFrequency('Gb3'), 6);
    // Bb2 one semitone below B2
    expect(noteToFrequency('Bb2')).toBeCloseTo(noteToFrequency('A#2'), 6);
  });

  it('rejects malformed note names', () => {
    expect(() => noteToFrequency('H4')).toThrow();
    expect(() => noteToFrequency('C')).toThrow();
    expect(() => noteToFrequency('xyz')).toThrow();
  });
});

describe('generateMusicWav', () => {
  const spec = {
    tempo: 120,
    tracks: [
      { wave: 'square' as const, volume: 0.6, notes: 'C4 E4 G4 . -' },
      { wave: 'triangle' as const, volume: 0.4, notes: 'C3 - C3 - C3 -' },
    ],
  };

  it('is deterministic: two runs are byte-identical', () => {
    const a = generateMusicWav(spec);
    const b = generateMusicWav(spec);
    expect(Buffer.from(a.wav).equals(Buffer.from(b.wav))).toBe(true);
  });

  it('is deterministic for noise tracks too', () => {
    const noiseSpec = { tempo: 90, tracks: [{ wave: 'noise' as const, volume: 0.5, notes: 'C4 - C4 -' }] };
    const a = generateMusicWav(noiseSpec);
    const b = generateMusicWav(noiseSpec);
    expect(Buffer.from(a.wav).equals(Buffer.from(b.wav))).toBe(true);
  });

  it('writes a 16-bit PCM mono WAV at the sound sample rate', () => {
    const { wav } = generateMusicWav(spec);
    expect(readAscii(wav, 0, 4)).toBe('RIFF');
    expect(readAscii(wav, 8, 4)).toBe('WAVE');
    expect(u16(wav, 20)).toBe(1); // PCM
    expect(u16(wav, 22)).toBe(1); // mono
    expect(u32(wav, 24)).toBe(SOUND_SAMPLE_RATE);
    expect(u16(wav, 34)).toBe(16); // bits per sample
  });

  it('duration = steps x sixteenth-note length (tempo math)', () => {
    // 6 tokens per track at 120 BPM. Sixteenth = (60/120)/4 = 0.125s.
    // 6 steps -> 0.75s.
    const { wav, trackSteps } = generateMusicWav(spec);
    // steps = number of sixteenth-note tokens: track 0 has 5, track 1 has 6.
    expect(trackSteps).toEqual([5, 6]);
    const samples = (wav.length - 44) / 2;
    const seconds = samples / SOUND_SAMPLE_RATE;
    expect(seconds).toBeCloseTo(0.75, 2);
  });

  it('mixed output never clips: peak <= full-scale 16-bit', () => {
    const loud = {
      tempo: 100,
      tracks: [
        { wave: 'square' as const, volume: 1, notes: 'C4 C4 C4 C4' },
        { wave: 'square' as const, volume: 1, notes: 'C4 C4 C4 C4' },
        { wave: 'square' as const, volume: 1, notes: 'C4 C4 C4 C4' },
        { wave: 'square' as const, volume: 1, notes: 'C4 C4 C4 C4' },
      ],
    };
    const { wav } = generateMusicWav(loud);
    const view = new DataView(wav.buffer, wav.byteOffset);
    const samples = (wav.length - 44) / 2;
    let peak = 0;
    for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)));
    expect(peak).toBeLessThanOrEqual(32767);
  });

  it('rejects a malformed token, naming the token and track index', () => {
    const bad = { tempo: 120, tracks: [{ wave: 'sine' as const, volume: 0.6, notes: 'C4 E4' }, { wave: 'sine' as const, volume: 0.6, notes: 'C4 Zx9' }] };
    let err: unknown;
    try {
      generateMusicWav(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MusicSynthError);
    expect((err as Error).message).toContain('Zx9');
    expect((err as Error).message).toContain('track 1');
  });

  it('rejects songs longer than the duration cap', () => {
    // 300+ steps at 40 BPM: sixteenth = (60/40)/4 = 0.375s -> way over 120s.
    const many = Array.from({ length: 400 }, () => 'C4').join(' ');
    const spec2 = { tempo: 40, tracks: [{ wave: 'sine' as const, volume: 0.6, notes: many }] };
    expect(() => generateMusicWav(spec2)).toThrow(MusicSynthError);
  });
});

describe('createMusic command', () => {
  it('writes assets/sounds/<slug>.wav, registers an audio asset with music metadata', async () => {
    const { session, fs } = await makeSession();
    const result = await session.execute<any>('createMusic', {
      name: 'Overworld Theme',
      tempo: 120,
      loop: true,
      tracks: [
        { wave: 'square', volume: 0.6, notes: 'C4 E4 G4 . -' },
        { wave: 'triangle', notes: 'C3 - C3 - C3 -' },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data.asset.type).toBe('audio');
    expect(result.data.asset.path).toBe('assets/sounds/overworld_theme.wav');
    expect(result.data.asset.metadata.music).toMatchObject({ tempo: 120, loop: true });
    expect(result.data.asset.metadata.music.tracks[0]).toMatchObject({ wave: 'square', steps: 5 });

    const bytes = await fs.readFileBinary('/proj/assets/sounds/overworld_theme.wav');
    const { wav } = generateMusicWav({
      tempo: 120,
      tracks: [
        { wave: 'square', volume: 0.6, notes: 'C4 E4 G4 . -' },
        { wave: 'triangle', volume: 0.6, notes: 'C3 - C3 - C3 -' },
      ],
    });
    expect(Buffer.from(bytes).equals(Buffer.from(wav))).toBe(true);

    const validation = await session.execute<any>('validateProject');
    expect(validation.data.errors).toEqual([]);
  });

  it('is deterministic through the command: same params -> byte-identical file', async () => {
    const params = {
      tempo: 140,
      tracks: [{ wave: 'saw', volume: 0.5, notes: 'A4 B4 C5 D5' }],
    };
    const { session: s1, fs: f1 } = await makeSession();
    await s1.execute('createMusic', { name: 'Tune', ...params });
    const { session: s2, fs: f2 } = await makeSession();
    await s2.execute('createMusic', { name: 'Tune', ...params });
    const a = await f1.readFileBinary('/proj/assets/sounds/tune.wav');
    const b = await f2.readFileBinary('/proj/assets/sounds/tune.wav');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('rejects a malformed note token with INVALID_INPUT naming the token', async () => {
    const { session } = await makeSession();
    const bad = await session.execute<any>('createMusic', {
      name: 'Broken',
      tempo: 120,
      tracks: [{ wave: 'sine', notes: 'C4 Q9 E4' }],
    });
    expect(bad.success).toBe(false);
    expect(bad.errors[0].code).toBe('INVALID_INPUT');
    expect(bad.errors[0].message).toContain('Q9');
  });

  it('rejects out-of-bounds tempo and >4 tracks via schema', async () => {
    const { session } = await makeSession();
    const fast = await session.execute<any>('createMusic', { name: 'x', tempo: 999, tracks: [{ wave: 'sine', notes: 'C4' }] });
    expect(fast.success).toBe(false);
    expect(fast.errors[0].code).toBe('INVALID_PARAMS');

    const tooMany = await session.execute<any>('createMusic', {
      name: 'y',
      tempo: 120,
      tracks: Array.from({ length: 5 }, () => ({ wave: 'sine', notes: 'C4' })),
    });
    expect(tooMany.success).toBe(false);
    expect(tooMany.errors[0].code).toBe('INVALID_PARAMS');
  });

  it('requires asset-edit permission', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/p2', { name: 'RO' });
    const ro = HearthSession.fromStore(store, { granted: ['read-only'] });
    const denied = await ro.execute<any>('createMusic', { name: 'x', tempo: 120, tracks: [{ wave: 'sine', notes: 'C4' }] });
    expect(denied.success).toBe(false);
    expect(denied.errors[0].code).toBe('PERMISSION_DENIED');
  });
});
