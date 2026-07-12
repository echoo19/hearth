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
// Blob47 autotile sheet renderer
// ---------------------------------------------------------------------------
// One BLOB_TILE-square tile per canonical blob47 shape (see
// packages/core/src/tilemap/autotile.ts — the bit layout below MUST match
// that file's canonical N/E/S/W/NE/SE/SW/NW order exactly, since
// setTileAutotile resolves a cell's frame by shape key at render time; this
// file intentionally does not import core, so the bits are re-declared here
// rather than shared). Each tile is warm-lit cave rock: a dark crevice
// border is painted along any side lacking a same-tile neighbour, and a
// diagonal notch is cut at "inner corner" shapes (both adjacent edges
// present, the corner neighbour itself absent) — the concave case that
// makes blob47 47 shapes instead of a plain 16-combination 4-edge set. A
// couple of fixed warm flecks give the rock an "embedded glow" read
// consistent with Glow Caves' torch-lit palette. Deterministic: no
// Math.random, no Date.

const BLOB_N = 1;
const BLOB_NE = 2;
const BLOB_E = 4;
const BLOB_SE = 8;
const BLOB_S = 16;
const BLOB_SW = 32;
const BLOB_W = 64;
const BLOB_NW = 128;

const ROCK_BASE = [74, 64, 54, 255]; // #4a4036 — same warm stone as the other examples' wall tiles
const ROCK_DARK = [26, 20, 16, 255]; // #1a1410 — unlit crevice
const ROCK_GLOW = [255, 179, 71, 255]; // #ffb347 — matches Glow Caves' torch-flame-a sprite

const BLOB_TILE = 16;
const BLOB_BORDER = 3;
const BLOB_NOTCH = 5;
const BLOB_FLECKS = [
  [4, 5],
  [11, 10],
];

function setBlobPixel(rgba, sheetWidth, x, y, color) {
  const idx = (y * sheetWidth + x) * 4;
  rgba[idx] = color[0];
  rgba[idx + 1] = color[1];
  rgba[idx + 2] = color[2];
  rgba[idx + 3] = color[3];
}

/** Paint one shape's tile into `rgba` (sheet-sized buffer) at offset (ox, oy). */
function drawBlobTile(rgba, sheetWidth, ox, oy, mask) {
  const hasN = (mask & BLOB_N) !== 0;
  const hasE = (mask & BLOB_E) !== 0;
  const hasS = (mask & BLOB_S) !== 0;
  const hasW = (mask & BLOB_W) !== 0;
  const hasNE = (mask & BLOB_NE) !== 0;
  const hasSE = (mask & BLOB_SE) !== 0;
  const hasSW = (mask & BLOB_SW) !== 0;
  const hasNW = (mask & BLOB_NW) !== 0;

  const dark = Array.from({ length: BLOB_TILE }, () => new Array(BLOB_TILE).fill(false));

  if (!hasN) for (let x = 0; x < BLOB_TILE; x++) for (let y = 0; y < BLOB_BORDER; y++) dark[y][x] = true;
  if (!hasS)
    for (let x = 0; x < BLOB_TILE; x++)
      for (let y = BLOB_TILE - BLOB_BORDER; y < BLOB_TILE; y++) dark[y][x] = true;
  if (!hasW) for (let y = 0; y < BLOB_TILE; y++) for (let x = 0; x < BLOB_BORDER; x++) dark[y][x] = true;
  if (!hasE)
    for (let y = 0; y < BLOB_TILE; y++)
      for (let x = BLOB_TILE - BLOB_BORDER; x < BLOB_TILE; x++) dark[y][x] = true;

  // Inner-corner notch: both adjacent edges present but the diagonal
  // neighbour is a different tile — carve a small triangle toward the
  // tile's center so the concave gap actually reads visually.
  const notch = (cornerX, cornerY, dx, dy) => {
    for (let i = 0; i < BLOB_NOTCH; i++) {
      for (let j = 0; j < BLOB_NOTCH - i; j++) {
        const x = cornerX + dx * i;
        const y = cornerY + dy * j;
        if (x >= 0 && x < BLOB_TILE && y >= 0 && y < BLOB_TILE) dark[y][x] = true;
      }
    }
  };
  if (hasN && hasE && !hasNE) notch(BLOB_TILE - 1, 0, -1, 1);
  if (hasS && hasE && !hasSE) notch(BLOB_TILE - 1, BLOB_TILE - 1, -1, -1);
  if (hasS && hasW && !hasSW) notch(0, BLOB_TILE - 1, 1, -1);
  if (hasN && hasW && !hasNW) notch(0, 0, 1, 1);

  for (let y = 0; y < BLOB_TILE; y++) {
    for (let x = 0; x < BLOB_TILE; x++) {
      setBlobPixel(rgba, sheetWidth, ox + x, oy + y, dark[y][x] ? ROCK_DARK : ROCK_BASE);
    }
  }
  for (const [fx, fy] of BLOB_FLECKS) {
    if (!dark[fy][fx]) setBlobPixel(rgba, sheetWidth, ox + fx, oy + fy, ROCK_GLOW);
  }
}

/**
 * Render a full blob47 sheet: one BLOB_TILE-square tile per entry of
 * `shapeKeys` (pass core's AUTOTILE_SHAPES — canonical mask values as
 * decimal strings), laid out row-major at `columns` per row. Returns the
 * sheet's pixel buffer plus frame metadata (`blob_<shapeKey>` names, in
 * `shapeKeys` order, with pixel x/y/width/height) ready to hand straight to
 * setAssetMetadata's `frames` field — see setTileAutotile's frame-naming
 * contract (packages/core/src/commands/tilemapCommands.ts).
 */
export function makeBlob47CaveSheetRgba(shapeKeys, columns = 8) {
  const rows = Math.ceil(shapeKeys.length / columns);
  const width = columns * BLOB_TILE;
  const height = rows * BLOB_TILE;
  const rgba = new Uint8Array(width * height * 4); // starts fully transparent
  const frames = shapeKeys.map((shape, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const ox = col * BLOB_TILE;
    const oy = row * BLOB_TILE;
    drawBlobTile(rgba, width, ox, oy, Number(shape));
    return { name: `blob_${shape}`, x: ox, y: oy, width: BLOB_TILE, height: BLOB_TILE };
  });
  return { width, height, rgba, frames };
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
