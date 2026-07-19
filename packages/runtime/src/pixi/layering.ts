import type {
  LineRendererComponent,
  SpriteRendererComponent,
  TextComponent,
  TilemapComponent,
  UISliderComponent,
  UIToggleComponent,
} from '@hearth/core';

/** The renderable components that carry a `layer` and set an entity's zIndex. */
export interface LayeredComponents {
  SpriteRenderer?: SpriteRendererComponent;
  Text?: TextComponent;
  Tilemap?: TilemapComponent;
  LineRenderer?: LineRendererComponent;
  UISlider?: UISliderComponent;
  UIToggle?: UIToggleComponent;
}

/**
 * The zIndex for an entity's whole container: the max `layer` among the
 * renderable components it ACTUALLY has. Absent components contribute nothing.
 *
 * The earlier `Math.max(sprite?.layer ?? 0, text?.layer ?? 0, …)` folded a
 * phantom 0 in for every missing component, so any entity whose only renderer
 * sat at a negative layer (backgrounds/parallax authored at -2/-1) got clamped
 * up to 0 — collapsing intended fg/mg/bg depth to insertion order. Pixi's
 * `sortableChildren` honours negative zIndex, so we return the real (possibly
 * negative) layer and only fall back to 0 when the entity has no layered
 * renderable at all.
 */
export function resolveEntityZIndex(components: LayeredComponents): number {
  let z: number | undefined;
  const consider = (layer: number | undefined): void => {
    if (layer === undefined) return;
    z = z === undefined ? layer : Math.max(z, layer);
  };
  consider(components.SpriteRenderer?.layer);
  consider(components.Text?.layer);
  consider(components.Tilemap?.layer);
  consider(components.LineRenderer?.layer);
  consider(components.UISlider?.layer);
  consider(components.UIToggle?.layer);
  return z ?? 0;
}
