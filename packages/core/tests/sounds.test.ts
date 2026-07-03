import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  generateSoundWav,
  SOUND_PRESETS,
  SOUND_SAMPLE_RATE,
} from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Sound Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true);
}

describe('procedural sound synthesis', () => {
  it('is deterministic: same preset + seed produces byte-identical WAVs', () => {
    for (const preset of SOUND_PRESETS) {
      const a = generateSoundWav(preset, 42);
      const b = generateSoundWav(preset, 42);
      expect(Buffer.from(a).equals(Buffer.from(b)), `preset ${preset}`).toBe(true);
    }
  });

  it('different seeds and different presets produce different audio', () => {
    const a = generateSoundWav('coin', 1);
    const b = generateSoundWav('coin', 2);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    const jump = generateSoundWav('jump', 1);
    expect(Buffer.from(a).equals(Buffer.from(jump))).toBe(false);
  });

  it('writes a sane 16-bit PCM mono 44.1kHz RIFF/WAVE header', () => {
    for (const preset of SOUND_PRESETS) {
      const wav = generateSoundWav(preset, 7);
      expect(readAscii(wav, 0, 4)).toBe('RIFF');
      expect(readAscii(wav, 8, 4)).toBe('WAVE');
      expect(readAscii(wav, 12, 4)).toBe('fmt ');
      expect(readAscii(wav, 36, 4)).toBe('data');
      expect(u32(wav, 4)).toBe(wav.length - 8); // RIFF chunk size
      expect(u16(wav, 20)).toBe(1); // PCM
      expect(u16(wav, 22)).toBe(1); // mono
      expect(u32(wav, 24)).toBe(SOUND_SAMPLE_RATE);
      expect(u16(wav, 34)).toBe(16); // bits per sample
      expect(u32(wav, 40)).toBe(wav.length - 44); // data chunk size
    }
  });

  it('presets are short SFX (~0.05-1.0s) and actually contain audio', () => {
    for (const preset of SOUND_PRESETS) {
      const wav = generateSoundWav(preset, 0);
      const samples = (wav.length - 44) / 2;
      const seconds = samples / SOUND_SAMPLE_RATE;
      expect(seconds, `preset ${preset}`).toBeGreaterThanOrEqual(0.05);
      expect(seconds, `preset ${preset}`).toBeLessThanOrEqual(1.0);

      const view = new DataView(wav.buffer, wav.byteOffset);
      let peak = 0;
      for (let i = 0; i < samples; i++) {
        peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)));
      }
      expect(peak, `preset ${preset} should not be silence`).toBeGreaterThan(1000);
    }
  });
});

describe('createSound command', () => {
  it('writes assets/sounds/<slug>.wav and registers an audio asset', async () => {
    const { session, fs } = await makeSession();
    const result = await session.execute<any>('createSound', { name: 'Pickup Coin', preset: 'coin', seed: 5 });
    expect(result.success).toBe(true);
    expect(result.data.asset.type).toBe('audio');
    expect(result.data.asset.path).toBe('assets/sounds/pickup_coin.wav');
    expect(result.data.asset.metadata).toMatchObject({ procedural: true, preset: 'coin', seed: 5 });

    const bytes = await fs.readFileBinary('/proj/assets/sounds/pickup_coin.wav');
    expect(Buffer.from(bytes).equals(Buffer.from(generateSoundWav('coin', 5)))).toBe(true);

    // The registered asset passes validation (file exists on disk).
    const validation = await session.execute<any>('validateProject');
    expect(validation.data.errors).toEqual([]);
  });

  it('defaults the seed to 0 and rejects duplicate names/files', async () => {
    const { session } = await makeSession();
    const first = await session.execute<any>('createSound', { name: 'blip', preset: 'blip' });
    expect(first.success).toBe(true);
    expect(first.data.asset.metadata.seed).toBe(0);

    const dup = await session.execute('createSound', { name: 'blip', preset: 'blip' });
    expect(dup.success).toBe(false);
    expect(dup.errors[0].code).toBe('CONFLICT');
  });

  it('requires asset-edit permission and a known preset', async () => {
    const { session } = await makeSession();
    const bad = await session.execute('createSound', { name: 'x', preset: 'kazoo' });
    expect(bad.success).toBe(false);
    expect(bad.errors[0].code).toBe('INVALID_PARAMS');

    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/p2', { name: 'RO' });
    const ro = HearthSession.fromStore(store, { granted: ['read-only'] });
    const denied = await ro.execute('createSound', { name: 'x', preset: 'coin' });
    expect(denied.success).toBe(false);
    expect(denied.errors[0].code).toBe('PERMISSION_DENIED');
  });
});
