import { Text } from 'pixi.js';
import type { TextComponent } from '@hearth/core';

/** Horizontal anchor for a Text align (vertical anchor is always centered). */
export function textAnchorX(align: TextComponent['align']): number {
  return align === 'center' ? 0.5 : align === 'right' ? 1 : 0;
}

/** Builds the Pixi Text node for a Text component (used once, in buildNode). */
export function buildTextNode(text: TextComponent): Text {
  const node = new Text({
    text: text.content,
    style: {
      fontFamily: text.fontFamily,
      fontSize: text.fontSize,
      fill: text.color,
      align: text.align,
    },
  });
  node.anchor.set(textAnchorX(text.align), 0.5);
  node.label = 'text';
  return node;
}

/**
 * Pushes the current component state onto an existing Text node every sync.
 *
 * Previously updateNode only re-synced `content` and `visible`, so a script
 * mutating Text.color (or fontSize / fontFamily / align) at runtime saw no
 * visual change — unlike Transform.scale and Text.content, which did update.
 * Every mutable style field is now written through (guarded so an unchanged
 * value doesn't churn Pixi's style-dirty machinery). Assigning an individual
 * `style.*` property marks the TextStyle dirty and re-renders on the next
 * frame, which is exactly the live update scripts expected.
 */
export function syncTextNode(node: Text, text: TextComponent): void {
  node.visible = text.visible;
  if (node.text !== text.content) node.text = text.content;
  const style = node.style;
  if (style.fill !== text.color) style.fill = text.color;
  if (style.fontSize !== text.fontSize) style.fontSize = text.fontSize;
  if (style.fontFamily !== text.fontFamily) style.fontFamily = text.fontFamily;
  if (style.align !== text.align) style.align = text.align;
  const anchorX = textAnchorX(text.align);
  if (node.anchor.x !== anchorX) node.anchor.set(anchorX, 0.5);
}
