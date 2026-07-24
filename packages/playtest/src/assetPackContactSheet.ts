import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isSafeOut,
  probeImage,
  type AssetPackReport,
  type CommandResult,
} from '@hearth/core';
import { launchChromium } from './screenshot.js';

export const MAX_ASSET_PACK_REVIEW_IMAGES = 64;
export const MAX_ASSET_PACK_REVIEW_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_ASSET_PACK_REVIEW_PIXELS = 16 * 1024 * 1024;
const MAX_ASSET_PACK_REVIEW_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_PACK_REVIEW_TOTAL_PIXELS = 64 * 1024 * 1024;
const CELL_WIDTH = 320;
const CELL_HEIGHT = 300;

export interface AssetPackReviewImage {
  path: string;
  width?: number;
  height?: number;
}

export interface AssetPackContactSheetOptions {
  root: string;
  images: AssetPackReviewImage[];
  projectRoot: string;
  outPath: string;
}

export function assetPackContactSheetGrid(total: number): {
  count: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
} {
  const count = Math.min(Math.max(0, total), MAX_ASSET_PACK_REVIEW_IMAGES);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return {
    count,
    cols,
    rows,
    width: cols * CELL_WIDTH,
    height: rows * CELL_HEIGHT,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function reviewImages(root: string, images: AssetPackReviewImage[]): AssetPackReviewImage[] {
  const absoluteRoot = path.resolve(root);
  return [...images]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MAX_ASSET_PACK_REVIEW_IMAGES)
    .map((image) => {
      const absolute = path.resolve(absoluteRoot, image.path);
      if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
        throw new Error(`asset-pack contact sheet: image path escapes pack root: ${image.path}`);
      }
      return image;
    });
}

export function buildAssetPackContactSheetHtml(
  root: string,
  images: AssetPackReviewImage[],
): string {
  return renderAssetPackContactSheetHtml(
    root,
    images,
    (image) => pathToFileURL(path.resolve(root, image.path)).href,
  );
}

function renderAssetPackContactSheetHtml(
  root: string,
  images: AssetPackReviewImage[],
  sourceFor: (image: AssetPackReviewImage) => string,
): string {
  const reviewed = reviewImages(root, images);
  const grid = assetPackContactSheetGrid(reviewed.length);
  const cards = reviewed
    .map((image) => {
      const source = sourceFor(image);
      const dimensions =
        image.width !== undefined && image.height !== undefined
          ? `${image.width}×${image.height}`
          : 'dimensions unknown';
      return `<figure>
        <div class="preview"><img src="${escapeHtml(source)}" alt=""></div>
        <figcaption><strong>${escapeHtml(image.path)}</strong><span>${escapeHtml(dimensions)}</span></figcaption>
      </figure>`;
    })
    .join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; background: #15171c; color: #f1f3f5; font: 13px system-ui, sans-serif; }
#asset-pack-sheet { display: grid; grid-template-columns: repeat(${grid.cols}, ${CELL_WIDTH}px);
  width: ${grid.width}px; min-height: ${grid.height}px; }
figure { width: ${CELL_WIDTH}px; height: ${CELL_HEIGHT}px; margin: 0; padding: 14px; border: 1px solid #343a40; overflow: hidden; }
.preview { width: 290px; height: 238px; display: flex; align-items: center; justify-content: center;
  background-color: #fff; background-image: linear-gradient(45deg,#ddd 25%,transparent 25%),
  linear-gradient(-45deg,#ddd 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ddd 75%),
  linear-gradient(-45deg,transparent 75%,#ddd 75%); background-size: 16px 16px;
  background-position: 0 0,0 8px,8px -8px,-8px 0; }
img { max-width: 290px; max-height: 238px; object-fit: contain; image-rendering: pixelated; }
figcaption { display: flex; justify-content: space-between; gap: 8px; padding-top: 9px; }
strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
span { color: #adb5bd; white-space: nowrap; }
</style></head><body><main id="asset-pack-sheet">${cards}</main></body></html>`;
}

async function prepareOutputPath(
  projectRoot: string,
  outPath: string,
  canonicalPackRoot: string,
): Promise<string> {
  if (path.extname(outPath).toLowerCase() !== '.png') {
    throw new Error('asset-pack contact sheet: outPath must end in .png');
  }
  const absoluteProject = path.resolve(projectRoot);
  const absoluteOut = path.resolve(absoluteProject, outPath);
  const canonicalProject = await realpath(projectRoot);
  const canonicalCandidate = path.resolve(canonicalProject, outPath);
  const isInVendorPack = (candidate: string) =>
    candidate === canonicalPackRoot ||
    candidate.startsWith(`${canonicalPackRoot}${path.sep}`);
  if (isInVendorPack(canonicalCandidate)) {
    throw new Error(
      'asset-pack contact sheet: output path must not modify the inspected vendor pack',
    );
  }
  const parentRelative = path.relative(absoluteProject, path.dirname(absoluteOut));
  let cursor = absoluteProject;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await lstat(cursor).catch(() => undefined);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error('asset-pack contact sheet: output path must not traverse a symlink');
    }
    if (!stat.isDirectory()) {
      throw new Error('asset-pack contact sheet: output parent must be a directory');
    }
    if (isInVendorPack(await realpath(cursor))) {
      throw new Error(
        'asset-pack contact sheet: output path must not modify the inspected vendor pack',
      );
    }
  }
  const existingOut = await lstat(absoluteOut).catch(() => undefined);
  if (existingOut?.isSymbolicLink()) {
    throw new Error('asset-pack contact sheet: output path must not be a symlink');
  }
  await mkdir(path.dirname(absoluteOut), { recursive: true });
  const canonicalOutParent = await realpath(path.dirname(absoluteOut));
  if (isInVendorPack(canonicalOutParent)) {
    throw new Error(
      'asset-pack contact sheet: output path must not modify the inspected vendor pack',
    );
  }
  if (
    canonicalOutParent !== canonicalProject &&
    !canonicalOutParent.startsWith(`${canonicalProject}${path.sep}`)
  ) {
    throw new Error('asset-pack contact sheet: output path escapes project root through a symlink');
  }
  return absoluteOut;
}

export async function captureAssetPackContactSheet(
  opts: AssetPackContactSheetOptions,
): Promise<{ path: string; images: number; cols: number; rows: number }> {
  if (!isSafeOut(opts.outPath)) {
    throw new Error(
      `asset-pack contact sheet: outPath must be project-relative (no absolute paths or "..") (got: ${opts.outPath})`,
    );
  }
  if (path.extname(opts.outPath).toLowerCase() !== '.png') {
    throw new Error('asset-pack contact sheet: outPath must end in .png');
  }

  const images = reviewImages(opts.root, opts.images);
  if (images.length === 0) {
    throw new Error('asset-pack contact sheet: at least one review image is required');
  }
  const canonicalRoot = await realpath(opts.root);
  const canonicalSources = new Map<string, string>();
  let totalBytes = 0;
  let totalPixels = 0;
  for (const image of images) {
    const canonicalImage = await realpath(path.resolve(opts.root, image.path));
    if (
      canonicalImage !== canonicalRoot &&
      !canonicalImage.startsWith(`${canonicalRoot}${path.sep}`)
    ) {
      throw new Error(`asset-pack contact sheet: image path escapes pack root: ${image.path}`);
    }
    const stat = await lstat(canonicalImage);
    if (!stat.isFile() || stat.size > MAX_ASSET_PACK_REVIEW_FILE_BYTES) {
      throw new Error(`asset-pack contact sheet: review image exceeds the file limit: ${image.path}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_ASSET_PACK_REVIEW_TOTAL_BYTES) {
      throw new Error('asset-pack contact sheet: review images exceed the aggregate file limit');
    }
    const info = probeImage(await readFile(canonicalImage));
    const pixels = info ? info.width * info.height : 0;
    if (
      !info ||
      !Number.isSafeInteger(pixels) ||
      pixels <= 0 ||
      pixels > MAX_ASSET_PACK_REVIEW_PIXELS
    ) {
      throw new Error(`asset-pack contact sheet: unsafe or unreadable review image: ${image.path}`);
    }
    totalPixels += pixels;
    if (totalPixels > MAX_ASSET_PACK_REVIEW_TOTAL_PIXELS) {
      throw new Error('asset-pack contact sheet: review images exceed the aggregate pixel limit');
    }
    canonicalSources.set(image.path, pathToFileURL(canonicalImage).href);
  }
  const outPath = await prepareOutputPath(
    opts.projectRoot,
    opts.outPath,
    canonicalRoot,
  );
  const grid = assetPackContactSheetGrid(images.length);
  const scratch = await mkdtemp(path.join(tmpdir(), 'hearth-asset-pack-'));
  try {
    const htmlPath = path.join(scratch, 'index.html');
    await writeFile(
      htmlPath,
      renderAssetPackContactSheetHtml(
        opts.root,
        images,
        (image) => canonicalSources.get(image.path)!,
      ),
      'utf8',
    );
    const browser = await launchChromium();
    try {
      const page = await browser.newPage({
        viewport: { width: grid.width, height: grid.height },
        deviceScaleFactor: 1,
      });
      const htmlUrl = pathToFileURL(htmlPath).href;
      const allowedUrls = new Set([htmlUrl, ...canonicalSources.values()]);
      if (!page.route) {
        throw new Error('asset-pack contact sheet: browser request interception is unavailable');
      }
      await page.route('**/*', async (route) => {
        if (allowedUrls.has(route.request().url())) await route.continue();
        else await route.abort();
      });
      await page.goto(htmlUrl);
      await page.waitForFunction(() => {
        const doc = (globalThis as unknown as {
          document: { querySelectorAll(selector: string): ArrayLike<{ complete: boolean }> };
        }).document;
        return Array.from(doc.querySelectorAll('img')).every((image) => image.complete);
      });
      const brokenImages = (await page.evaluate(() => {
        const doc = (globalThis as unknown as {
          document: {
            querySelectorAll(
              selector: string,
            ): ArrayLike<{ naturalWidth: number; getAttribute(name: string): string | null }>;
          };
        }).document;
        return Array.from(doc.querySelectorAll('img'))
          .filter((image) => image.naturalWidth === 0)
          .map((image) => image.getAttribute('src') ?? '(unknown)');
      })) as string[];
      if (brokenImages.length > 0) {
        throw new Error(
          `asset-pack contact sheet: could not load ${brokenImages.length} review image(s)`,
        );
      }
      await page.locator('#asset-pack-sheet').screenshot({ path: outPath });
      return { path: outPath, images: images.length, cols: grid.cols, rows: grid.rows };
    } finally {
      await browser.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function attachAssetPackContactSheet(
  result: CommandResult<AssetPackReport>,
  projectRoot: string,
  outPath: string,
): Promise<void> {
  if (!result.success || !result.data) return;
  try {
    const imagesByPath = new Map(result.data.images.map((image) => [image.path, image]));
    const images = result.data.reviewImages.map(
      (imagePath) => imagesByPath.get(imagePath) ?? { path: imagePath },
    );
    await captureAssetPackContactSheet({
      root: result.data.root,
      images,
      projectRoot,
      outPath,
    });
    result.data.contactSheet = outPath;
    result.files.push(outPath);
  } catch (err) {
    result.warnings.push({
      code: 'CONTACT_SHEET_FAILED',
      message: `Pack inspection succeeded, but contact-sheet capture failed: ${(err as Error).message}`,
    });
  }
}
