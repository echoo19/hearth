/**
 * Screen-space UI helpers — anchor math and hit rects for UIElement
 * entities. Shared by the headless runtime (sendPointer hit-testing) and
 * the pixi host (overlay positioning) so pointer behavior is identical in
 * playtests and the browser.
 *
 * Text bounds use a deterministic monospace approximation (the default
 * Text font is monospace) rather than real canvas measurement, so headless
 * and browser hit-testing agree. Rotation is ignored for hit rects; scale
 * applies.
 */
import type { ComponentMap, TextComponent, UIAnchor, UIElementComponent, Vec2 } from '@hearth/core';

/** Screen point of a UI anchor for a given screen size. */
export function anchorPoint(anchor: UIAnchor, screenW: number, screenH: number): Vec2 {
  const x = anchor.includes('left') ? 0 : anchor.includes('right') ? screenW : screenW / 2;
  const y = anchor.includes('top') ? 0 : anchor.includes('bottom') ? screenH : screenH / 2;
  return { x, y };
}

/** Screen position of a UI element (anchor point plus offset). */
export function uiScreenPosition(ui: UIElementComponent, screenW: number, screenH: number): Vec2 {
  const a = anchorPoint(ui.anchor, screenW, screenH);
  return { x: a.x + ui.offset.x, y: a.y + ui.offset.y };
}

/** Approximate text bounds: 0.6em advance per character, 1.2em line height. */
export function measureText(text: TextComponent): { width: number; height: number } {
  const lines = text.content.split('\n');
  const maxLen = Math.max(0, ...lines.map((l) => l.length));
  return { width: maxLen * text.fontSize * 0.6, height: lines.length * text.fontSize * 1.2 };
}

/** Axis-aligned screen rect. */
export interface UiRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Screen rect of a UI element's visuals: the SpriteRenderer's width/height
 * (centered, like the rendered sprite) unioned with measured Text bounds
 * (x per text align, y centered). Returns null when the entity has no
 * UIElement or nothing visible to hit.
 */
export function uiElementRect(
  components: ComponentMap,
  screenW: number,
  screenH: number,
): UiRect | null {
  const ui = components.UIElement;
  if (!ui) return null;
  const pos = uiScreenPosition(ui, screenW, screenH);
  const scale = components.Transform?.scale ?? { x: 1, y: 1 };
  const sx = Math.abs(scale.x);
  const sy = Math.abs(scale.y);

  let rect: UiRect | null = null;
  const sprite = components.SpriteRenderer;
  if (sprite && sprite.visible) {
    const hw = (sprite.width * sx) / 2;
    const hh = (sprite.height * sy) / 2;
    rect = { minX: pos.x - hw, minY: pos.y - hh, maxX: pos.x + hw, maxY: pos.y + hh };
  }
  const text = components.Text;
  if (text && text.visible) {
    const m = measureText(text);
    const w = m.width * sx;
    const h = m.height * sy;
    const alignFactor = text.align === 'center' ? 0.5 : text.align === 'right' ? 1 : 0;
    const tRect: UiRect = {
      minX: pos.x - alignFactor * w,
      minY: pos.y - h / 2,
      maxX: pos.x + (1 - alignFactor) * w,
      maxY: pos.y + h / 2,
    };
    rect = rect
      ? {
          minX: Math.min(rect.minX, tRect.minX),
          minY: Math.min(rect.minY, tRect.minY),
          maxX: Math.max(rect.maxX, tRect.maxX),
          maxY: Math.max(rect.maxY, tRect.maxY),
        }
      : tRect;
  }
  return rect;
}
