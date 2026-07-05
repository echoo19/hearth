// Deterministic PNG + WAV encoders for hand-authored binary example assets.
// No Math.random, no Date — every byte here must be reproducible run to run
// (see the double-generation diff check in generate.mjs's Sky Courier).
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode an RGBA buffer (w*h*4 bytes) as a PNG. Deterministic. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Chiptune WAV renderer
// ---------------------------------------------------------------------------
// Two-voice, deterministic, ~8s loopable chiptune: a square-wave melody (16
// steps of 0.5s) over a triangle-wave bass (8 steps of 1s). Every note has a
// 10ms linear attack/release, so the waveform sits at ~0 amplitude at every
// note boundary (including the very start and end of the clip) — that's what
// makes the loop click-free. The melody and bass also both start and end on
// the same note/frequency, so the clip resolves onto the same chord it opens
// on when it loops.

const WAV_SAMPLE_RATE = 22050;
const CLIP_SECONDS = 8;
const MELODY_STEP_SECONDS = 0.5; // 16 steps across 8s
const BASS_STEP_SECONDS = 1; // 8 steps across 8s
const ATTACK_SECONDS = 0.01;
const RELEASE_SECONDS = 0.01;
const MELODY_GAIN = 0.25;
const BASS_GAIN = 0.2;

// C major, one octave up (square-wave melody). First and last step match.
const MELODY_HZ = [
  261.63, 329.63, 392.0, 440.0,
  523.25, 440.0, 392.0, 329.63,
  261.63, 329.63, 392.0, 440.0,
  523.25, 440.0, 392.0, 261.63,
];

// C major arpeggio, two octaves down (triangle-wave bass). First and last
// step match, same as the melody, so the loop resolves onto a C-major chord.
const BASS_HZ = [130.81, 164.81, 196.0, 164.81, 130.81, 164.81, 196.0, 130.81];

function squareWave(freqHz, t) {
  return Math.sin(2 * Math.PI * freqHz * t) >= 0 ? 1 : -1;
}

function triangleWave(freqHz, t) {
  return (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * freqHz * t));
}

/** Linear 10ms attack/release envelope within a note of `stepSeconds`. */
function noteEnvelope(localT, stepSeconds) {
  if (localT < ATTACK_SECONDS) return localT / ATTACK_SECONDS;
  if (localT > stepSeconds - RELEASE_SECONDS) return Math.max(0, (stepSeconds - localT) / RELEASE_SECONDS);
  return 1;
}

function encodeWav(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

/** Render the ~8s two-voice rooftop-loop chiptune as a 16-bit PCM mono WAV. */
export function renderChiptuneWav() {
  const sampleCount = WAV_SAMPLE_RATE * CLIP_SECONDS;
  const samples = new Float64Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / WAV_SAMPLE_RATE;

    const melodyIndex = Math.min(MELODY_HZ.length - 1, Math.floor(t / MELODY_STEP_SECONDS));
    const melodyLocalT = t - melodyIndex * MELODY_STEP_SECONDS;
    const melody =
      squareWave(MELODY_HZ[melodyIndex], t) * noteEnvelope(melodyLocalT, MELODY_STEP_SECONDS) * MELODY_GAIN;

    const bassIndex = Math.min(BASS_HZ.length - 1, Math.floor(t / BASS_STEP_SECONDS));
    const bassLocalT = t - bassIndex * BASS_STEP_SECONDS;
    const bass = triangleWave(BASS_HZ[bassIndex], t) * noteEnvelope(bassLocalT, BASS_STEP_SECONDS) * BASS_GAIN;

    samples[i] = melody + bass;
  }
  return encodeWav(samples, WAV_SAMPLE_RATE);
}
