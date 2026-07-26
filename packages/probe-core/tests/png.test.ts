/**
 * The PNG codec and the two statistics the probe reads out of a frame.
 *
 * The decoder is the risky half: real screenshots arrive filtered and in
 * whatever color type the source felt like, so every filter type and every
 * supported color type is exercised against a hand-built file rather than only
 * against our own encoder's output (which always writes filter 0).
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  averageHash,
  blankImage,
  decodePng,
  downsampleGray,
  encodePng,
  fillRect,
  hammingDistance,
  luminanceStats,
  type RgbaImage,
} from '@hearth/probe-core';

/** Build a PNG by hand so the decoder meets filters our encoder never writes. */
function handmadePng(
  width: number,
  height: number,
  colorType: number,
  channels: number,
  rows: number[][],
  filters: number[],
): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  // Apply the requested filter to each row, given the raw (unfiltered) bytes.
  const previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const line = Uint8Array.from(rows[y]);
    const filter = filters[y];
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value: number;
      switch (filter) {
        case 1:
          value = line[x] - left;
          break;
        case 2:
          value = line[x] - up;
          break;
        case 3:
          value = line[x] - ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          value = line[x] - pred;
          break;
        }
        default:
          value = line[x];
      }
      raw[y * (stride + 1) + 1 + x] = value & 0xff;
    }
    previous.set(line);
  }

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('encodePng / decodePng', () => {
  it('round-trips RGBA pixels exactly', () => {
    const img = blankImage(9, 5, [10, 20, 30, 255]);
    fillRect(img, 2, 1, 4, 3, [200, 100, 50, 255]);
    const decoded = decodePng(encodePng(img));
    expect(decoded.width).toBe(9);
    expect(decoded.height).toBe(5);
    expect([...decoded.data]).toEqual([...img.data]);
  });

  it('decodes every filter type', () => {
    const width = 4;
    const height = 5;
    const rows: number[][] = [];
    for (let y = 0; y < height; y++) {
      const row: number[] = [];
      for (let x = 0; x < width; x++) row.push(x * 17 + y * 5, 40 + x, 200 - y * 9, 255);
      rows.push(row);
    }
    const png = handmadePng(width, height, 6, 4, rows, [0, 1, 2, 3, 4]);
    const decoded = decodePng(png);
    expect([...decoded.data]).toEqual(rows.flat());
  });

  it('expands RGB and grayscale sources to RGBA', () => {
    const rgb = handmadePng(2, 1, 2, 3, [[1, 2, 3, 4, 5, 6]], [0]);
    expect([...decodePng(rgb).data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);

    const gray = handmadePng(2, 2, 0, 1, [[8, 9], [10, 11]], [0, 4]);
    expect([...decodePng(gray).data]).toEqual([8, 8, 8, 255, 9, 9, 9, 255, 10, 10, 10, 255, 11, 11, 11, 255]);

    const grayAlpha = handmadePng(2, 1, 4, 2, [[12, 128, 13, 64]], [0]);
    expect([...decodePng(grayAlpha).data]).toEqual([12, 12, 12, 128, 13, 13, 13, 64]);
  });

  it('refuses what it cannot honestly decode', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PNG/);
    const png = encodePng(blankImage(2, 2, [0, 0, 0, 255]));
    const interlaced = png.slice();
    interlaced[8 + 8 + 12] = 1; // IHDR interlace byte
    expect(() => decodePng(interlaced)).toThrow(/interlaced/);
    const paletted = png.slice();
    paletted[8 + 8 + 9] = 3; // IHDR color type byte
    expect(() => decodePng(paletted)).toThrow(/color type/);
  });
});

describe('frame statistics', () => {
  it('reports near-zero luminance and variance for a blank screen', () => {
    const { mean, variance } = luminanceStats(blankImage(16, 16, [0, 0, 0, 255]));
    expect(mean).toBeLessThan(0.04);
    expect(variance).toBeLessThan(0.0001);
  });

  it('reports high variance for a frame with content', () => {
    const img = blankImage(16, 16, [0, 0, 0, 255]);
    fillRect(img, 0, 0, 16, 8, [255, 255, 255, 255]);
    const { mean, variance } = luminanceStats(img);
    expect(mean).toBeCloseTo(0.5, 1);
    expect(variance).toBeGreaterThan(0.2);
  });

  it('hashes similar frames close together and different frames far apart', () => {
    const base = blankImage(32, 32, [30, 30, 30, 255]);
    fillRect(base, 0, 0, 16, 32, [220, 220, 220, 255]);
    const jittered = blankImage(32, 32, [32, 28, 31, 255]);
    fillRect(jittered, 0, 0, 16, 32, [218, 222, 219, 255]);
    const different = blankImage(32, 32, [30, 30, 30, 255]);
    fillRect(different, 0, 16, 32, 16, [220, 220, 220, 255]);

    const a = averageHash(base);
    expect(a).toHaveLength(16);
    expect(hammingDistance(a, averageHash(jittered))).toBeLessThanOrEqual(2);
    expect(hammingDistance(a, averageHash(different))).toBeGreaterThan(4);
    expect(hammingDistance(a, a)).toBe(0);
  });

  it('treats mismatched hash lengths as maximally distant', () => {
    expect(hammingDistance('ffff', 'ff')).toBe(16);
  });

  it('downsamples to the requested grid', () => {
    const img: RgbaImage = blankImage(8, 8, [255, 255, 255, 255]);
    fillRect(img, 0, 0, 4, 8, [0, 0, 0, 255]);
    const cells = downsampleGray(img, 2);
    expect(cells).toHaveLength(4);
    expect(cells[0]).toBeCloseTo(0, 5);
    expect(cells[1]).toBeCloseTo(1, 5);
  });
});
