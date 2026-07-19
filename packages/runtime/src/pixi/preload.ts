import type { Asset } from '@hearth/core';

/** The component fields a preload scan reads off each entity. */
export interface PreloadComponents {
  SpriteRenderer?: { assetId?: string | null };
  Tilemap?: { tileAssets: Record<string, string | { sheet: string }> };
  SpriteAnimator?: { assetId?: string };
}

/**
 * The sheet/sprite asset id a single animation frame entry references. An
 * entry is either a plain sprite-asset id or a sheet ref
 * `<sheetAssetId>#<frameName>` (split on the FIRST '#') — either way the
 * sheet's own asset id is what needs a texture loaded.
 */
export function frameTextureAssetId(frameAssetId: string): string {
  const hashIndex = frameAssetId.indexOf('#');
  return hashIndex === -1 ? frameAssetId : frameAssetId.slice(0, hashIndex);
}

export interface PreloadDeps {
  /** Components of every entity across all scenes plus the live runtime. */
  componentSets: Iterable<PreloadComponents>;
  /** Every asset in the project (animation-type ones are filtered here). */
  assets: readonly Asset[];
  /** Reads + parses an animation asset's frame list (may reject on error). */
  readAnimationFrames: (asset: Asset) => Promise<string[]>;
  onWarn?: (message: string) => void;
}

/**
 * The full set of texture asset ids to preload up front: sprite/tilemap
 * textures directly referenced by components, PLUS the frame textures of
 * EVERY animation asset in the project — not only those a SpriteAnimator
 * statically references.
 *
 * Preloading every animation (rather than just referenced clips) is what makes
 * a clip switched at runtime via `ctx.animate(...)` safe: its sheet is already
 * loaded, so it never renders solid white in headless/export builds, and the
 * old invisible preload-anchor-entity workaround is unnecessary. Projects are
 * small, so loading a handful of unreferenced sheets is a cheap price for
 * correctness. All reads/loads are awaited before the first render, so there's
 * no window where the first frames render white — matching how the referenced
 * preloads already behaved.
 */
export async function collectPreloadAssetIds(deps: PreloadDeps): Promise<Set<string>> {
  const assetIds = new Set<string>();
  for (const components of deps.componentSets) {
    if (components.SpriteRenderer?.assetId) assetIds.add(components.SpriteRenderer.assetId);
    if (components.Tilemap) {
      // A tile source is a plain asset id (string) or an autotile rule whose
      // `sheet` is the spritesheet asset id — preload whichever it references.
      for (const tile of Object.values(components.Tilemap.tileAssets)) {
        assetIds.add(typeof tile === 'string' ? tile : tile.sheet);
      }
    }
    // SpriteAnimator.assetId is intentionally NOT special-cased: every
    // animation asset is folded in below regardless of whether a component
    // references it, which is exactly what closes the runtime-switch gap.
  }
  for (const asset of deps.assets) {
    if (asset.type !== 'animation') continue;
    try {
      const frames = await deps.readAnimationFrames(asset);
      for (const frame of frames) assetIds.add(frameTextureAssetId(frame));
    } catch (err) {
      deps.onWarn?.(`Failed to load animation asset ${asset.name}: ${(err as Error).message}`);
    }
  }
  return assetIds;
}
