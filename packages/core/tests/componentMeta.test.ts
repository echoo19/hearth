import { describe, expect, it } from 'vitest';
import { COMPONENT_ENUMS } from '../src/schema/components.js';

describe('COMPONENT_ENUMS', () => {
  it('lists SpriteRenderer.shape options', () => {
    expect(COMPONENT_ENUMS.SpriteRenderer.shape).toEqual(['rectangle', 'circle', 'triangle', 'none']);
  });

  it('lists UILayout.direction options', () => {
    expect(COMPONENT_ENUMS.UILayout.direction).toEqual(['vertical', 'horizontal']);
  });

  it('lists Text.align, UIElement.anchor, and UILayout.align', () => {
    expect(COMPONENT_ENUMS.Text.align).toEqual(['left', 'center', 'right']);
    expect(COMPONENT_ENUMS.UIElement.anchor).toEqual([
      'top-left',
      'top',
      'top-right',
      'left',
      'center',
      'right',
      'bottom-left',
      'bottom',
      'bottom-right',
    ]);
    expect(COMPONENT_ENUMS.UILayout.align).toEqual(['start', 'center', 'end']);
  });

  it('omits non-enum fields and non-enum components', () => {
    expect(COMPONENT_ENUMS.SpriteRenderer.color).toBeUndefined();
    expect(COMPONENT_ENUMS.Transform).toBeUndefined();
  });
});
