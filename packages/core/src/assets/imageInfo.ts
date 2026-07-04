/** Byte-level image dimension probing. No dependencies, never throws. */
export interface ImageInfo {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'svg';
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function ascii(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function probeJpeg(b: Uint8Array): ImageInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = b[i + 1];
    }
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { width: u16be(b, i + 7), height: u16be(b, i + 5), format: 'jpeg' };
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function probeWebp(b: Uint8Array): ImageInfo | null {
  const kind = ascii(b, 12, 16);
  if (kind === 'VP8 ' && b.length >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, format: 'webp' };
  }
  if (kind === 'VP8L' && b.length >= 25) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
  }
  if (kind === 'VP8X' && b.length >= 30) {
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width: w, height: h, format: 'webp' };
  }
  return null;
}

function probeSvg(b: Uint8Array): ImageInfo | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(b.slice(0, 4096));
  } catch {
    return null;
  }
  const open = text.match(/<svg\b[^>]*>/i);
  if (!open) return null;
  const tag = open[0];
  const dim = (attr: string): number | null => {
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, 'i'));
    if (!m) return null;
    const v = Math.round(parseFloat(m[1]));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const w = dim('width');
  const h = dim('height');
  if (w && h) return { width: w, height: h, format: 'svg' };
  const vb = tag.match(/\bviewBox\s*=\s*["']\s*([-0-9.]+)[\s,]+([-0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i);
  if (vb) {
    const vw = Math.round(parseFloat(vb[3]));
    const vh = Math.round(parseFloat(vb[4]));
    if (vw > 0 && vh > 0) return { width: vw, height: vh, format: 'svg' };
  }
  return null;
}

/** Probe width/height/format from image bytes. Null when unrecognized or dimensionless. */
export function probeImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20), format: 'png' };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: u16le(bytes, 6), height: u16le(bytes, 8), format: 'gif' };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return probeJpeg(bytes);
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return probeWebp(bytes);
  }
  return probeSvg(bytes);
}
