/**
 * Screen-space UI helpers — anchor math, hit rects, and layout resolution
 * for UIElement entities. Shared by the headless runtime (sendPointer
 * hit-testing) and the pixi host (overlay positioning) so pointer behavior
 * is identical in playtests and the browser.
 *
 * Text bounds use a deterministic monospace approximation (the default
 * Text font is monospace) rather than real canvas measurement, so headless
 * and browser hit-testing agree. Rotation is ignored for hit rects; scale
 * applies.
 */
import type {
  ComponentMap,
  Entity,
  TextComponent,
  UIAnchor,
  UIElementComponent,
  Vec2,
} from '@hearth/core';

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

function unionRect(a: UiRect | null, b: UiRect): UiRect {
  if (!a) return b;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Screen rect of a UI element's visuals centered on `pos`: the
 * SpriteRenderer's width/height, measured Text bounds (x per text align, y
 * centered), a UISlider's `width x 24`, and a UIToggle's `size x size` —
 * unioned together. Returns null when there is nothing visible to hit.
 */
function rectAtPosition(components: ComponentMap, pos: Vec2): UiRect | null {
  const scale = components.Transform?.scale ?? { x: 1, y: 1 };
  const sx = Math.abs(scale.x);
  const sy = Math.abs(scale.y);

  let rect: UiRect | null = null;
  const sprite = components.SpriteRenderer;
  if (sprite && sprite.visible) {
    const hw = (sprite.width * sx) / 2;
    const hh = (sprite.height * sy) / 2;
    rect = unionRect(rect, { minX: pos.x - hw, minY: pos.y - hh, maxX: pos.x + hw, maxY: pos.y + hh });
  }
  const text = components.Text;
  if (text && text.visible) {
    const m = measureText(text);
    const w = m.width * sx;
    const h = m.height * sy;
    const alignFactor = text.align === 'center' ? 0.5 : text.align === 'right' ? 1 : 0;
    rect = unionRect(rect, {
      minX: pos.x - alignFactor * w,
      minY: pos.y - h / 2,
      maxX: pos.x + (1 - alignFactor) * w,
      maxY: pos.y + h / 2,
    });
  }
  const slider = components.UISlider;
  if (slider) {
    const hw = (slider.width * sx) / 2;
    const hh = (24 * sy) / 2;
    rect = unionRect(rect, { minX: pos.x - hw, minY: pos.y - hh, maxX: pos.x + hw, maxY: pos.y + hh });
  }
  const toggle = components.UIToggle;
  if (toggle) {
    const hw = (toggle.size * sx) / 2;
    const hh = (toggle.size * sy) / 2;
    rect = unionRect(rect, { minX: pos.x - hw, minY: pos.y - hh, maxX: pos.x + hw, maxY: pos.y + hh });
  }
  return rect;
}

/**
 * Screen rect of a UI element's visuals: the SpriteRenderer's width/height
 * (centered, like the rendered sprite) unioned with measured Text bounds
 * (x per text align, y centered), a UISlider's `width x 24`, and a
 * UIToggle's `size x size` (both centered, and both count as visuals even
 * with no Sprite/Text). Returns null when the entity has no UIElement or
 * nothing visible to hit.
 */
export function uiElementRect(
  components: ComponentMap,
  screenW: number,
  screenH: number,
): UiRect | null {
  const ui = components.UIElement;
  if (!ui) return null;
  const pos = uiScreenPosition(ui, screenW, screenH);
  return rectAtPosition(components, pos);
}

/** Local, un-positioned width/height of an entity's own visuals (see `rectAtPosition`). */
function elementExtent(components: ComponentMap): { width: number; height: number } | null {
  const rect = rectAtPosition(components, { x: 0, y: 0 });
  if (!rect) return null;
  return { width: rect.maxX - rect.minX, height: rect.maxY - rect.minY };
}

function isLayoutContainer(entity: Entity): boolean {
  return !!(entity.components.UILayout && entity.components.UIElement);
}

/**
 * Resolves the screen position of every UIElement entity, honoring
 * UILayout containers.
 *
 * Plain UIElement entities (no parent, or a parent that isn't a layout
 * container) resolve exactly like `uiScreenPosition` today.
 *
 * A UILayout + UIElement entity is a *container*: its own resolved position
 * is the top-left corner of its padding box (unlike a plain UIElement,
 * whose position is the center of its visual rect). Its UIElement children
 * (in child order, i.e. entities array order) are stacked along
 * `direction`, spaced by their measured rect extents + `gap`, inset from
 * the container's top-left by `padding`, and positioned on the cross axis
 * per `align`. A child's own `anchor` is ignored — the layout owns its
 * position — but its `offset` still applies as a relative nudge on top of
 * the computed stack slot. Nested layouts (a container whose parent is
 * also a container) resolve parent-first, naturally, via recursion.
 */
export function resolveUiPositions(
  entities: Entity[],
  screenW: number,
  screenH: number,
): Map<string, Vec2> {
  const positions = new Map<string, Vec2>();
  const byId = new Map(entities.map((e) => [e.id, e]));
  const childrenOf = (id: string): Entity[] =>
    entities.filter((e) => e.parentId === id && e.components.UIElement);

  /** Box size this entity occupies in a parent stack: its own visual rect, or (for a container) the union of its laid-out children + padding. */
  function extentOf(entity: Entity): { width: number; height: number } {
    if (isLayoutContainer(entity)) {
      const layout = entity.components.UILayout!;
      const kids = childrenOf(entity.id);
      const kidExtents = kids.map(extentOf);
      const vertical = layout.direction === 'vertical';
      const mainTotal = kidExtents.reduce(
        (sum, ext, i) => sum + (vertical ? ext.height : ext.width) + (i > 0 ? layout.gap : 0),
        0,
      );
      const crossMax = kidExtents.reduce(
        (m, ext) => Math.max(m, vertical ? ext.width : ext.height),
        0,
      );
      return vertical
        ? { width: crossMax + layout.padding * 2, height: mainTotal + layout.padding * 2 }
        : { width: mainTotal + layout.padding * 2, height: crossMax + layout.padding * 2 };
    }
    return elementExtent(entity.components) ?? { width: 0, height: 0 };
  }

  /** Places `entity` at `pos` (its own reference point) and, if it's a container, recursively lays out and places its children. */
  function place(entity: Entity, pos: Vec2): void {
    positions.set(entity.id, pos);
    if (!isLayoutContainer(entity)) return;

    const layout = entity.components.UILayout!;
    const kids = childrenOf(entity.id);
    if (kids.length === 0) return;
    const kidExtents = kids.map(extentOf);
    const vertical = layout.direction === 'vertical';
    const crossMax = kidExtents.reduce(
      (m, ext) => Math.max(m, vertical ? ext.width : ext.height),
      0,
    );

    // `pos` is the top-left of this container's padding box.
    const contentX = pos.x + layout.padding;
    const contentY = pos.y + layout.padding;
    let mainCursor = vertical ? contentY : contentX;

    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      const ext = kidExtents[i];
      const mainSize = vertical ? ext.height : ext.width;
      const crossSize = vertical ? ext.width : ext.height;
      const crossStart = vertical ? contentX : contentY;

      let crossCenter: number;
      if (layout.align === 'center') crossCenter = crossStart + crossMax / 2;
      else if (layout.align === 'end') crossCenter = crossStart + crossMax - crossSize / 2;
      else crossCenter = crossStart + crossSize / 2;

      const mainCenter = mainCursor + mainSize / 2;
      const slotCenter: Vec2 = vertical
        ? { x: crossCenter, y: mainCenter }
        : { x: mainCenter, y: crossCenter };

      // Containers report their top-left, not their center; leaves report their center.
      const basePos = isLayoutContainer(child)
        ? { x: slotCenter.x - ext.width / 2, y: slotCenter.y - ext.height / 2 }
        : slotCenter;

      const nudge = child.components.UIElement!.offset;
      place(child, { x: basePos.x + nudge.x, y: basePos.y + nudge.y });

      mainCursor += mainSize + layout.gap;
    }
  }

  for (const entity of entities) {
    if (!entity.components.UIElement) continue;
    if (positions.has(entity.id)) continue;
    const parent = entity.parentId ? byId.get(entity.parentId) : undefined;
    if (parent && isLayoutContainer(parent)) continue; // placed via the parent's recursive layout instead
    place(entity, uiScreenPosition(entity.components.UIElement, screenW, screenH));
  }

  return positions;
}
