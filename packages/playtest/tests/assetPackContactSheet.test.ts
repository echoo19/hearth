import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  buildAssetPackContactSheetHtml,
  captureAssetPackContactSheet,
  assetPackContactSheetGrid,
  MAX_ASSET_PACK_REVIEW_IMAGES,
} from '../src/assetPackContactSheet.js';
import { canLaunchChromium } from '../src/screenshot.js';

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

describe('asset-pack contact sheets', () => {
  it('builds a deterministic, escaped, nearest-neighbor review grid', () => {
    const html = buildAssetPackContactSheetHtml('/packs/demo', [
      { path: 'tiles.png', width: 256, height: 256 },
      { path: 'characters/<hero>.png', width: 32, height: 48 },
    ]);

    expect(html).toContain('image-rendering: pixelated');
    expect(html.indexOf('characters/&lt;hero&gt;.png')).toBeLessThan(html.indexOf('tiles.png'));
    expect(html).toContain('32×48');
    expect(html).toContain('grid-template-columns: repeat(2, 320px)');
    expect(html).not.toContain('characters/<hero>.png');
    expect(html).not.toContain('<script src=');
  });

  it('caps images and sheet dimensions', () => {
    const images = Array.from({ length: MAX_ASSET_PACK_REVIEW_IMAGES + 5 }, (_, i) => ({
      path: `${i}.png`,
      width: 16,
      height: 16,
    }));
    const grid = assetPackContactSheetGrid(images.length);
    const html = buildAssetPackContactSheetHtml('/packs/demo', images);

    expect(grid.count).toBe(MAX_ASSET_PACK_REVIEW_IMAGES);
    expect(grid.width).toBeLessThanOrEqual(4096);
    expect(grid.height).toBeLessThanOrEqual(4096);
    expect(html.match(/<figure>/g)).toHaveLength(MAX_ASSET_PACK_REVIEW_IMAGES);
  });

  it('rejects output paths outside the project before launching a browser', async () => {
    await expect(
      captureAssetPackContactSheet({
        root: '/packs/demo',
        images: [],
        projectRoot: '/project',
        outPath: '../outside.png',
      }),
    ).rejects.toThrow(/project-relative/i);
  });

  it('rejects an empty review before launching a browser', async () => {
    await expect(
      captureAssetPackContactSheet({
        root: '/packs/demo',
        images: [],
        projectRoot: '/project',
        outPath: 'review.png',
      }),
    ).rejects.toThrow(/at least one review image/i);
  });

  it('rejects non-PNG output before launching a browser', async () => {
    await expect(
      captureAssetPackContactSheet({
        root: '/packs/demo',
        images: [],
        projectRoot: '/project',
        outPath: 'review.jpg',
      }),
    ).rejects.toThrow(/end in \.png/i);
  });

  it('rejects excessive decoded dimensions before launching a browser', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hearth-pack-sheet-limit-'));
    const pack = path.join(root, 'pack');
    const project = path.join(root, 'project');
    await Promise.all([mkdir(pack), mkdir(project)]);
    try {
      await writeFile(path.join(pack, 'huge.png'), pngHeader(10000, 10000));
      await expect(
        captureAssetPackContactSheet({
          root: pack,
          images: [{ path: 'huge.png', width: 10000, height: 10000 }],
          projectRoot: project,
          outPath: 'review.png',
        }),
      ).rejects.toThrow(/unsafe or unreadable/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked output parents without creating outside directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hearth-pack-sheet-out-'));
    const pack = path.join(root, 'pack');
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    await Promise.all([mkdir(pack), mkdir(project), mkdir(outside)]);
    try {
      await writeFile(path.join(pack, 'tile.png'), pngHeader(16, 16));
      await symlink(outside, path.join(project, 'reviews'));
      await expect(
        captureAssetPackContactSheet({
          root: pack,
          images: [{ path: 'tile.png', width: 16, height: 16 }],
          projectRoot: project,
          outPath: 'reviews/nested/review.png',
        }),
      ).rejects.toThrow(/symlink/i);
      await expect(access(path.join(outside, 'nested'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never writes a contact sheet into the inspected vendor pack', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'hearth-pack-sheet-vendor-'));
    const pack = path.join(project, 'downloads', 'pack');
    await mkdir(pack, { recursive: true });
    const vendorImage = path.join(pack, 'tile.png');
    const original = pngHeader(16, 16);
    try {
      await writeFile(vendorImage, original);
      await expect(
        captureAssetPackContactSheet({
          root: pack,
          images: [{ path: 'tile.png', width: 16, height: 16 }],
          projectRoot: project,
          outPath: 'downloads/pack/tile.png',
        }),
      ).rejects.toThrow(/vendor pack/i);
      expect(await readFile(vendorImage)).toEqual(Buffer.from(original));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('rejects case-variant aliases of a vendor pack on case-insensitive filesystems', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'hearth-pack-sheet-case-'));
    const pack = path.join(project, 'downloads', 'pack');
    await mkdir(pack, { recursive: true });
    const vendorImage = path.join(pack, 'tile.png');
    const original = pngHeader(16, 16);
    try {
      await writeFile(vendorImage, original);
      const caseVariantPack = path.join(project, 'DOWNLOADS', 'PACK');
      const caseInsensitive = await realpath(caseVariantPack)
        .then(() => true)
        .catch(() => false);
      if (!caseInsensitive) return;

      await expect(
        captureAssetPackContactSheet({
          root: pack,
          images: [{ path: 'tile.png', width: 16, height: 16 }],
          projectRoot: project,
          outPath: 'DOWNLOADS/PACK/tile.png',
        }),
      ).rejects.toThrow(/vendor pack/i);
      expect(await readFile(vendorImage)).toEqual(Buffer.from(original));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

const hasChromium = await canLaunchChromium();

describe('asset-pack contact-sheet capture', () => {
  it.skipIf(!hasChromium)('captures the computed multi-column grid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hearth-pack-sheet-'));
    const pack = path.join(root, 'pack');
    const project = path.join(root, 'project');
    await Promise.all([mkdir(pack, { recursive: true }), mkdir(project, { recursive: true })]);
    try {
      const images = Array.from({ length: 4 }, (_, index) => ({
        path: `${index}.svg`,
        width: 16,
        height: 16,
      }));
      await Promise.all(
        images.map((image, index) =>
          writeFile(
            path.join(pack, image.path),
            `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="rgb(${index},0,0)"/></svg>`,
          ),
        ),
      );

      const result = await captureAssetPackContactSheet({
        root: pack,
        images,
        projectRoot: project,
        outPath: 'reviews/pack.png',
      });
      const png = await readFile(result.path);
      expect(result).toMatchObject({ images: 4, cols: 2, rows: 2 });
      expect(png.readUInt32BE(16)).toBe(640);
      expect(png.readUInt32BE(20)).toBe(600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
