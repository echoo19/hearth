/**
 * buildTextNode + syncTextNode — the Text display builder/updater split out of
 * PixiSceneView. Regression cover for the "Text.color mutation doesn't render
 * live" bug: a script mutating Text.color (or fontSize / fontFamily / align)
 * at runtime saw no visual change because updateNode only re-synced
 * content + visible. syncTextNode must push every mutable style field onto the
 * live Pixi Text node.
 */
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.navigator === 'undefined') {
    (globalThis as { navigator?: Navigator }).navigator = { userAgent: 'node' } as Navigator;
  }
});

import { TextSchema, type TextComponent } from '@hearth/core';
import { buildTextNode, syncTextNode, textAnchorX } from '../src/pixi/textRender.js';

function text(overrides: Partial<TextComponent> = {}): TextComponent {
  return TextSchema.parse(overrides);
}

describe('textAnchorX', () => {
  it('maps align to the horizontal anchor', () => {
    expect(textAnchorX('left')).toBe(0);
    expect(textAnchorX('center')).toBe(0.5);
    expect(textAnchorX('right')).toBe(1);
  });
});

describe('buildTextNode', () => {
  it('builds a Text carrying the component content and style', () => {
    const node = buildTextNode(text({ content: 'Hi', fontSize: 24, color: '#112233', align: 'center' }));
    expect(node.text).toBe('Hi');
    expect(node.style.fontSize).toBe(24);
    expect(node.style.fill).toBe('#112233');
    expect(node.anchor.x).toBe(0.5);
    expect(node.anchor.y).toBe(0.5);
  });
});

describe('syncTextNode', () => {
  it('live-updates color (the reported bug)', () => {
    const node = buildTextNode(text({ color: '#ffffff' }));
    syncTextNode(node, text({ color: '#ff0000' }));
    expect(node.style.fill).toBe('#ff0000');
  });

  it('live-updates fontSize, fontFamily and align+anchor', () => {
    const node = buildTextNode(text({ fontSize: 16, fontFamily: 'monospace', align: 'left' }));
    syncTextNode(node, text({ fontSize: 40, fontFamily: 'serif', align: 'right' }));
    expect(node.style.fontSize).toBe(40);
    expect(node.style.fontFamily).toBe('serif');
    expect(node.style.align).toBe('right');
    expect(node.anchor.x).toBe(1);
  });

  it('live-updates content and visibility', () => {
    const node = buildTextNode(text({ content: 'a', visible: true }));
    syncTextNode(node, text({ content: 'b', visible: false }));
    expect(node.text).toBe('b');
    expect(node.visible).toBe(false);
  });
});
