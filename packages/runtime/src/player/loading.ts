/**
 * Pure helpers for the web player's loading layer. Kept DOM-free so they can
 * be unit-tested headlessly (the player entry itself touches window at
 * module scope and cannot be imported under Node).
 *
 * Everything the loading layer shows is user-controlled via
 * buildSettings.loading — no engine branding, no text, no logo.
 */

export interface NormalizedLoadingSettings {
  backgroundColor: string;
  /** Asset id shown centered while loading, or null. */
  image: string | null;
  /** Show a minimal neutral spinner. */
  spinner: boolean;
}

export const DEFAULT_LOADING_BACKGROUND = '#000000';

/**
 * Extract buildSettings.loading from the raw bundled project JSON,
 * tolerating older bundles where the field is missing.
 */
export function normalizeLoadingSettings(project: unknown): NormalizedLoadingSettings {
  const loading =
    (project as { buildSettings?: { loading?: unknown } } | null)?.buildSettings?.loading ?? {};
  const raw = loading as { backgroundColor?: unknown; image?: unknown; spinner?: unknown };
  return {
    backgroundColor:
      typeof raw.backgroundColor === 'string' && raw.backgroundColor.length > 0
        ? raw.backgroundColor
        : DEFAULT_LOADING_BACKGROUND,
    image: typeof raw.image === 'string' && raw.image.length > 0 ? raw.image : null,
    spinner: raw.spinner === true,
  };
}

/**
 * Neutral monochrome foreground (spinner ring) that stays visible on the
 * user's loading background: white on dark, black on light. Unparseable
 * colors fall back to white (the default background is black).
 */
export function loadingForegroundColor(backgroundColor: string): '#ffffff' | '#000000' {
  const rgb = parseHexColor(backgroundColor);
  if (!rgb) return '#ffffff';
  // Perceived luminance (ITU-R BT.601), 0..255.
  const luminance = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  return luminance > 150 ? '#000000' : '#ffffff';
}

/** #rgb or #rrggbb → {r,g,b}, else null. */
export function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const hex = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) {
    return {
      r: parseInt(short[1] + short[1], 16),
      g: parseInt(short[2] + short[2], 16),
      b: parseInt(short[3] + short[3], 16),
    };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (long) {
    return { r: parseInt(long[1], 16), g: parseInt(long[2], 16), b: parseInt(long[3], 16) };
  }
  return null;
}

/**
 * Asset types whose raw JSON content the runtime reads straight off the
 * store's fs (SceneRuntime.loadAnimations for 'animation', loadPrefabs for
 * 'prefab', loadStateMachines for 'stateMachine') rather than by URL through
 * resolveAssetUrl. Multi-file exports
 * must materialize these into the player's in-memory fs (see the loadStore
 * fetch loop in ./index.ts); single-file exports already inline every asset
 * as a dataUri, so this gate only guards the multi-file fetch path. Missing a
 * type here silently freezes the feature that reads it (animations froze on
 * their first frame before this existed — the Wave A regression class).
 */
export function assetNeedsRawContent(type: string): boolean {
  return type === 'animation' || type === 'prefab' || type === 'stateMachine';
}

/** Minimal bundle-asset shape needed to resolve a displayable URL. */
export interface BundleAssetLike {
  id: string;
  path?: string;
  dataUri?: string;
}

/** URL for a bundle asset id (inline dataUri wins), or null when unknown. */
export function resolveBundleAssetUrl(
  assets: readonly BundleAssetLike[],
  assetId: string | null,
): string | null {
  if (!assetId) return null;
  const asset = assets.find((a) => a.id === assetId);
  if (!asset) return null;
  return asset.dataUri ?? asset.path ?? null;
}
