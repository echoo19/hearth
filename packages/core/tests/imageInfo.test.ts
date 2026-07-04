import { describe, it, expect, beforeEach } from 'vitest';
import { probeImage, type ImageInfo, MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

describe('probeImage', () => {
  describe('PNG', () => {
    it('probes PNG signature and IHDR dimensions', () => {
      // PNG header: 89 50 4E 47 0D 0A 1A 0A
      // IHDR chunk: 00 00 00 0D (length 13) 49 48 44 52 (IHDR)
      // width (u32be): 00 00 00 82 (130)
      // height (u32be): 00 00 00 40 (64)
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x82, // width = 130
        0x00, 0x00, 0x00, 0x40, // height = 64
        0x08, 0x02, 0x00, 0x00, 0x00, // color type, compression, filter
        0x12, 0x34, 0x56, 0x78, // CRC
      ]);
      const info = probeImage(pngBytes);
      expect(info).toEqual({ width: 130, height: 64, format: 'png' });
    });
  });

  describe('GIF', () => {
    it('probes GIF logical screen dimensions', () => {
      // GIF89a
      // Logical Screen Descriptor: width (u16le) at offset 6, height at offset 8
      const gifBytes = new Uint8Array([
        0x47, 0x49, 0x46, // 'GIF'
        0x38, 0x39, 0x61, // '89a'
        0x28, 0x00, // width = 40 (little-endian)
        0x1e, 0x00, // height = 30 (little-endian)
        0xf0, 0x00, 0x00, // packed byte, global color table flag
      ]);
      const info = probeImage(gifBytes);
      expect(info).toEqual({ width: 40, height: 30, format: 'gif' });
    });
  });

  describe('JPEG', () => {
    it('probes JPEG with SOF0 marker after APP0 segment', () => {
      // JPEG: FF D8 (SOI)
      // APP0 segment: FF E0 (marker) 00 10 (length 16) JFIF...
      // SOF0 segment: FF C0 (marker) 00 11 (length 17) 08 (precision) 00 18 (height 24 be) 00 20 (width 32 be)
      const jpegBytes = new Uint8Array([
        0xff, 0xd8, // SOI
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
        0xff, 0xc0, // SOF0 marker
        0x00, 0x11, // length
        0x08, // precision
        0x00, 0x18, // height = 24
        0x00, 0x20, // width = 32
        0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // components
        0xFF, 0xD9, // EOI
      ]);
      const info = probeImage(jpegBytes);
      expect(info).toEqual({ width: 32, height: 24, format: 'jpeg' });
    });

    it('probes JPEG with multiple padding FF bytes before SOF0', () => {
      const jpegBytes = new Uint8Array([
        0xff, 0xd8, // SOI
        0xff, 0xff, 0xc0, // padding FF before SOF0
        0x00, 0x11, // length
        0x08, // precision
        0x00, 0x20, // height = 32
        0x00, 0x28, // width = 40
        0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        0xFF, 0xD9, // EOI
      ]);
      const info = probeImage(jpegBytes);
      expect(info).toEqual({ width: 40, height: 32, format: 'jpeg' });
    });
  });

  describe('WebP lossy (VP8)', () => {
    it('probes WebP VP8 with dimensions', () => {
      // RIFF....WEBPVP8 at offsets 0,8,12
      // VP8 payload starts at byte 20
      // Sync code at chunk payload offset 3 = byte 23
      // Dimensions (14-bit LE u16) at byte 26-27 (width), 28-29 (height) with & 0x3fff
      const webpBytes = new Uint8Array([
        // RIFF header
        0x52, 0x49, 0x46, 0x46, // 'RIFF' at 0-3
        0x24, 0x00, 0x00, 0x00, // file size - 8 = 36 bytes at 4-7
        0x57, 0x45, 0x42, 0x50, // 'WEBP' at 8-11
        0x56, 0x50, 0x38, 0x20, // 'VP8 ' at 12-15
        0x18, 0x00, 0x00, 0x00, // chunk size = 24 at 16-19
        // VP8 bitstream at 20+
        0x00, 0x00, 0x00, // frame tag padding (3 bytes) at 20-22
        0x9d, 0x01, 0x2a, // sync code at 23-25
        0x10, 0x00, // width = 16 at 26-27
        0x08, 0x00, // height = 8 at 28-29
        0x00, 0x00, 0x00, 0x00, 0x00, // padding
      ]);
      const info = probeImage(webpBytes);
      expect(info).toEqual({ width: 16, height: 8, format: 'webp' });
    });
  });

  describe('WebP lossless (VP8L)', () => {
    it('probes WebP VP8L with packed dimensions', () => {
      // RIFF....WEBPVP8L
      // VP8L signature byte at offset 20: 0x2F
      // Packed 28-bit dims at offset 21-24 (u32le)
      // width-1 in bits 0-13, height-1 in bits 14-27
      // For 17×9: width-1=16 (0x10), height-1=8 (0x8)
      // bits = 0x10 | (0x08 << 14) = 0x10 | 0x20000 = 0x20010
      // As u32le bytes: 0x10, 0x00, 0x02, 0x00
      const webpBytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // 'RIFF' at 0-3
        0x1e, 0x00, 0x00, 0x00, // file size - 8 at 4-7
        0x57, 0x45, 0x42, 0x50, // 'WEBP' at 8-11
        0x56, 0x50, 0x38, 0x4c, // 'VP8L' at 12-15
        0x11, 0x00, 0x00, 0x00, // chunk size at 16-19
        0x2f, // signature at 20
        0x10, 0x00, 0x02, 0x00, // packed dims: 0x20010 as u32le
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const info = probeImage(webpBytes);
      expect(info).toEqual({ width: 17, height: 9, format: 'webp' });
    });
  });

  describe('SVG', () => {
    it('extracts dimensions from width and height attributes', () => {
      const svgText = '<svg width="64" height="32"><circle r="16"/></svg>';
      const svgBytes = new TextEncoder().encode(svgText);
      const info = probeImage(svgBytes);
      expect(info).toEqual({ width: 64, height: 32, format: 'svg' });
    });

    it('extracts dimensions from viewBox when width/height missing', () => {
      const svgText = '<svg viewBox="0 0 48 24"><rect/></svg>';
      const svgBytes = new TextEncoder().encode(svgText);
      const info = probeImage(svgBytes);
      expect(info).toEqual({ width: 48, height: 24, format: 'svg' });
    });

    it('returns null when neither width/height nor viewBox present', () => {
      const svgText = '<svg><circle r="16"/></svg>';
      const svgBytes = new TextEncoder().encode(svgText);
      const info = probeImage(svgBytes);
      expect(info).toBeNull();
    });

    it('handles SVG with px units in width/height', () => {
      const svgText = '<svg width="128px" height="96px"/>';
      const svgBytes = new TextEncoder().encode(svgText);
      const info = probeImage(svgBytes);
      expect(info).toEqual({ width: 128, height: 96, format: 'svg' });
    });
  });

  describe('Edge cases', () => {
    it('returns null for empty array', () => {
      const info = probeImage(new Uint8Array([]));
      expect(info).toBeNull();
    });

    it('returns null for garbage bytes', () => {
      const info = probeImage(new Uint8Array([0xab, 0xcd, 0xef, 0x12]));
      expect(info).toBeNull();
    });

    it('returns null for truncated PNG (8 bytes)', () => {
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const info = probeImage(pngBytes);
      expect(info).toBeNull();
    });
  });

  describe('importAsset integration', () => {
    it('probes image metadata on sprite import', async () => {
      const fs = new MemoryFileSystem();
      const { store } = await createProject(fs, '/proj', { name: 'Test' });
      const session = HearthSession.fromStore(store, {
        granted: ['asset-edit'],
      });

      // Create a minimal PNG file (130×64)
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x82, // width = 130
        0x00, 0x00, 0x00, 0x40, // height = 64
        0x08, 0x02, 0x00, 0x00, 0x00, // color type, compression, filter
        0x12, 0x34, 0x56, 0x78, // CRC
      ]);

      // Write PNG to temp location
      await fs.writeFile('/tmp/sprite.png', pngBytes);

      // Import asset
      const result = await session.execute('importAsset', {
        sourcePath: '/tmp/sprite.png',
        name: 'TestSprite',
        type: 'sprite',
      });

      expect(result.success).toBe(true);
      const asset = result.data!.asset;
      expect(asset.name).toBe('TestSprite');
      expect(asset.type).toBe('sprite');
      expect(asset.metadata.importedFrom).toBe('sprite.png');
      expect(asset.metadata.width).toBe(130);
      expect(asset.metadata.height).toBe(64);
      expect(asset.metadata.format).toBe('png');
    });
  });
});
