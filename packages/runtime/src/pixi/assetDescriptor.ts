import type { Asset } from '@hearth/core';

type PixiTextureAssetDescriptor = string | { src: string; parser: 'texture' | 'svg' };

const TEXTURE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function assetExtension(path: string): string {
  const cleanPath = path.split(/[?#]/, 1)[0];
  const name = cleanPath.slice(cleanPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function pixiTextureAssetDescriptor(asset: Asset, url: string): PixiTextureAssetDescriptor {
  const ext = assetExtension(asset.path);
  if (ext === 'svg') return { src: url, parser: 'svg' };
  if (TEXTURE_EXTENSIONS.has(ext)) return { src: url, parser: 'texture' };
  return url;
}
