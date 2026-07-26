/**
 * A minimal PNG codec — just enough to look at a screenshot.
 *
 * The probe treats pixels as a *sense*, not a rendering target: it needs mean
 * luminance (black-screen) and an 8x8 average hash (novelty) out of whatever
 * PNG an adapter hands it, and it needs to synthesize PNGs for the in-memory
 * fixture game. Both directions are a few hundred lines over node:zlib, which
 * beats taking a dependency for two numbers per frame.
 *
 * Supported on decode: bit depth 8, non-interlaced, color types 0 (gray),
 * 2 (RGB), 4 (gray+alpha), 6 (RGBA) — what every screenshot pipeline emits.
 * Palette (type 3) and 16-bit images throw a named error rather than guessing.
 * Encode always writes 8-bit RGBA, non-interlaced, one IDAT.
 */
import { deflateSync, inflateSync } from 'node:zlib';

/** Decoded pixels: RGBA, 4 bytes per pixel, row-major, top-left origin. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per pixel for each supported PNG color type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

function crc32(bytes: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Encode RGBA pixels as an 8-bit non-interlaced PNG. */
export function encodePng(img: RgbaImage): Uint8Array {
  const { width, height, data } = img;
  const stride = width * 4;
  if (data.length < stride * height) {
    throw new Error(`encodePng: expected ${stride * height} bytes, got ${data.length}`);
  }
  // Filter type 0 (None) on every row: the fixture images are flat blocks, so
  // the deflate stage already collapses them and per-row filters buy nothing.
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = new Uint8Array(deflateSync(raw));
  return concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit non-interlaced PNG to RGBA pixels. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('decodePng: not a PNG (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idats: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const depth = bytes[pos + 16];
      colorType = bytes[pos + 17];
      const interlace = bytes[pos + 20];
      if (depth !== 8) throw new Error(`decodePng: unsupported bit depth ${depth} (only 8)`);
      if (interlace !== 0) throw new Error('decodePng: interlaced PNGs are not supported');
      if (!(colorType in CHANNELS)) {
        throw new Error(`decodePng: unsupported color type ${colorType} (0, 2, 4, 6 only)`);
      }
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (width <= 0 || height <= 0) throw new Error('decodePng: missing or empty IHDR');
  if (idats.length === 0) throw new Error('decodePng: no IDAT data');

  const channels = CHANNELS[colorType];
  const raw = new Uint8Array(inflateSync(concat(idats)));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new Error(`decodePng: truncated image data (${raw.length} bytes)`);
  }

  // Un-filter in place into a contiguous scanline buffer.
  const lines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const left = x >= channels ? lines[dst + x - channels] : 0;
      const above = y > 0 ? lines[up + x] : 0;
      const upLeft = y > 0 && x >= channels ? lines[up + x - channels] : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + above;
          break;
        case 3:
          out = value + ((left + above) >> 1);
          break;
        case 4:
          out = value + paeth(left, above, upLeft);
          break;
        default:
          throw new Error(`decodePng: unknown filter type ${filter} on row ${y}`);
      }
      lines[dst + x] = out & 0xff;
    }
  }

  if (channels === 4) return { width, height, data: lines };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const o = i * 4;
    if (channels === 3) {
      data[o] = lines[p];
      data[o + 1] = lines[p + 1];
      data[o + 2] = lines[p + 2];
      data[o + 3] = 255;
    } else {
      // Grayscale (1) or gray+alpha (2).
      const g = lines[p];
      data[o] = g;
      data[o + 1] = g;
      data[o + 2] = g;
      data[o + 3] = channels === 2 ? lines[p + 1] : 255;
    }
  }
  return { width, height, data };
}

/** A solid-color RGBA image — the starting canvas for synthesized frames. */
export function blankImage(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

/** Fill an axis-aligned rectangle (clipped to the image). */
export function fillRect(
  img: RgbaImage,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgba: [number, number, number, number],
): void {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(img.width, Math.floor(x0 + w));
  const bottom = Math.min(img.height, Math.floor(y0 + h));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = rgba[0];
      img.data[o + 1] = rgba[1];
      img.data[o + 2] = rgba[2];
      img.data[o + 3] = rgba[3];
    }
  }
}
