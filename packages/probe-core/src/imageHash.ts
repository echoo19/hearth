/**
 * Pixel statistics: the two numbers the probe reads out of a frame.
 *
 * `averageHash` is the classic 8x8 aHash — downsample to a small grayscale
 * grid, threshold at the mean, read the bits as hex. Two frames that differ
 * only by noise (a flickering particle, an antialiased edge, a compression
 * artifact) land within a couple of bits of each other, which is exactly the
 * property the novelty detector needs: it counts a bucket as new only when its
 * Hamming distance from every bucket seen so far exceeds a threshold, so a
 * jittering game cannot manufacture endless "progress".
 *
 * `luminanceStats` is the black-screen sense: a frame that is both very dark
 * and very flat is a blank canvas, not a dark level.
 */
import type { RgbaImage } from './png.js';

/** Rec. 601 luma of one pixel, 0..1. */
function luma(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Box-downsample to size x size grayscale cells, each 0..1. */
export function downsampleGray(img: RgbaImage, size: number): Float64Array {
  const out = new Float64Array(size * size);
  const counts = new Float64Array(size * size);
  const { width, height, data } = img;
  if (width === 0 || height === 0) return out;
  for (let y = 0; y < height; y++) {
    const cy = Math.min(size - 1, Math.floor((y * size) / height));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(size - 1, Math.floor((x * size) / width));
      const o = (y * width + x) * 4;
      const cell = cy * size + cx;
      out[cell] += luma(data[o], data[o + 1], data[o + 2]);
      counts[cell] += 1;
    }
  }
  for (let i = 0; i < out.length; i++) if (counts[i] > 0) out[i] /= counts[i];
  return out;
}

/**
 * 8x8 average hash as lowercase hex (16 chars / 64 bits). Bit i (MSB first) is
 * 1 when cell i is at or above the frame's mean brightness.
 */
export function averageHash(img: RgbaImage, size = 8): string {
  const cells = downsampleGray(img, size);
  let mean = 0;
  for (const v of cells) mean += v;
  mean /= cells.length || 1;
  let hex = '';
  for (let i = 0; i < cells.length; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) {
      nibble = (nibble << 1) | (cells[i + b] >= mean ? 1 : 0);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

const POPCOUNT = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));

/** Bit distance between two equal-length hex hashes. Unequal lengths count as maximally distant. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length) * 4;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    d += POPCOUNT[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf];
  }
  return d;
}

/** Mean and variance of per-pixel luminance, both in 0..1 units. */
export function luminanceStats(img: RgbaImage): { mean: number; variance: number } {
  const { width, height, data } = img;
  const n = width * height;
  if (n === 0) return { mean: 0, variance: 0 };
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const l = luma(data[o], data[o + 1], data[o + 2]);
    sum += l;
    sumSq += l * l;
  }
  const mean = sum / n;
  return { mean, variance: Math.max(0, sumSq / n - mean * mean) };
}
