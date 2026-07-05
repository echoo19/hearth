/**
 * Font-asset loading for the pixi host.
 *
 * Font-type assets (ttf/otf/woff/woff2, see assetCommands.ts's EXT_TO_TYPE)
 * are registered with the document via the FontFace API so a Text
 * component's `fontFamily` can reference one by asset name instead of
 * falling back to whatever system fonts happen to be installed. Pulled out
 * of pixi/index.ts (mirrors audio.ts) so the load/guard/failure logic is
 * unit-testable directly, without a real browser — PixiSceneView itself
 * needs a real canvas/WebGL context and is only exercised end to end via
 * the Chromium-gated playtest suite (packages/playtest/tests/screenshot.test.ts).
 */
import type { Asset } from '@hearth/core';

// TypeScript's lib.dom.d.ts models `FontFaceSet` without `add`/`delete`/
// `has`/`clear`, even though the real DOM interface extends `Set<FontFace>`
// (https://drafts.csswg.org/css-font-loading/#fontfaceset) and every
// browser implements them. Augment the ambient type rather than casting at
// every call site.
declare global {
  interface FontFaceSet {
    add(font: FontFace): FontFaceSet;
  }
}

/**
 * Loads every given font asset via `new FontFace(asset.name, url(...))` and
 * registers it with `document.fonts` under EXACTLY the asset's name (Text's
 * `fontFamily` schema field is expected to match a font asset's name
 * verbatim). Silently does nothing when `FontFace`/`document` aren't
 * present — headless Node hosts never touch this at all (PixiSceneView only
 * exists in a real DOM), but the guard keeps this function safe to call
 * from anywhere. A single font's load failure is reported via `onWarn` and
 * does not stop the remaining fonts from loading or block the caller.
 */
export async function loadFontFaces(
  fonts: readonly Asset[],
  resolveAssetUrl: (asset: Asset) => string,
  onWarn?: (message: string) => void,
): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return;
  for (const asset of fonts) {
    try {
      const face = new FontFace(asset.name, `url(${resolveAssetUrl(asset)})`);
      await face.load();
      document.fonts.add(face);
    } catch (err) {
      onWarn?.(`font: failed to load asset ${asset.name}: ${(err as Error).message}`);
    }
  }
}
