/**
 * Game settings panel. This repo has no jsdom/RTL, so GameSettings'
 * edit-shaping logic is pulled to module scope and unit-tested directly (same
 * pattern as inputSettingsEdit.test.ts / consoleLinkClick.test.ts).
 *
 * Covers the brief's contract: every edit dispatches updateSettings with ONLY
 * the changed field; the icon/loading-image picker lists sprite assets plus a
 * "None"; and an invalid width/height is rejected client-side.
 */
import { describe, expect, it } from 'vitest';
import type { AssetItem } from '../src/types';
import {
  loadingPatch,
  parsePositiveInt,
  pickerValueToAssetId,
  spriteAssets,
  topPatch,
} from '../src/components/GameSettings';

function asset(id: string, type: AssetItem['type']): AssetItem {
  return { id, name: id, type, path: `assets/${id}`, metadata: {} };
}

describe('topPatch — one top-level buildSettings field per edit', () => {
  it('wraps a single field, nothing else', () => {
    expect(topPatch('title', 'My Game')).toEqual({ buildSettings: { title: 'My Game' } });
    expect(topPatch('width', 640)).toEqual({ buildSettings: { width: 640 } });
    expect(topPatch('backgroundColor', '#101020')).toEqual({ buildSettings: { backgroundColor: '#101020' } });
  });

  it('only the changed field is present in buildSettings', () => {
    const patch = topPatch('targetFps', 30);
    expect(Object.keys(patch.buildSettings)).toEqual(['targetFps']);
  });

  it('clears the icon with null (None)', () => {
    expect(topPatch('icon', null)).toEqual({ buildSettings: { icon: null } });
  });
});

describe('loadingPatch — one loading field per edit, deep-merged', () => {
  it('nests a single loading field so the rest of loading is untouched', () => {
    expect(loadingPatch('image', 'sprite-1')).toEqual({ buildSettings: { loading: { image: 'sprite-1' } } });
    expect(loadingPatch('spinner', true)).toEqual({ buildSettings: { loading: { spinner: true } } });
    expect(loadingPatch('backgroundColor', '#000000')).toEqual({
      buildSettings: { loading: { backgroundColor: '#000000' } },
    });
  });

  it('only the changed loading field is present', () => {
    const patch = loadingPatch('image', null);
    expect(Object.keys(patch.buildSettings)).toEqual(['loading']);
    expect(Object.keys(patch.buildSettings.loading)).toEqual(['image']);
    expect(patch.buildSettings.loading.image).toBeNull();
  });
});

describe('parsePositiveInt — client-side width/height rejection', () => {
  it('accepts positive whole numbers', () => {
    expect(parsePositiveInt('800')).toBe(800);
    expect(parsePositiveInt('1')).toBe(1);
    expect(parsePositiveInt('  60 ')).toBe(60);
  });

  it('rejects zero, negatives, and below-min values', () => {
    expect(parsePositiveInt('0')).toBeNull();
    expect(parsePositiveInt('-5')).toBeNull();
    expect(parsePositiveInt('0', 1)).toBeNull();
  });

  it('rejects non-integers and non-numbers', () => {
    expect(parsePositiveInt('1.5')).toBeNull();
    expect(parsePositiveInt('abc')).toBeNull();
    expect(parsePositiveInt('')).toBeNull();
    expect(parsePositiveInt('   ')).toBeNull();
    expect(parsePositiveInt('12px')).toBeNull();
  });

  it('honors a custom minimum', () => {
    expect(parsePositiveInt('5', 10)).toBeNull();
    expect(parsePositiveInt('10', 10)).toBe(10);
  });
});

describe('sprite picker — lists sprite AND tile assets plus None (GAMESETTINGS-2 / L-074)', () => {
  const assets: AssetItem[] = [
    asset('hero', 'sprite'),
    asset('theme', 'audio'),
    asset('ground', 'tile'),
    asset('title-font', 'font'),
    asset('logo', 'sprite'),
  ];

  it('offers sprite AND tile assets as options — parity with the Inspector\'s assetId pickers', () => {
    expect(spriteAssets(assets).map((a) => a.id)).toEqual(['hero', 'ground', 'logo']);
  });

  it('excludes non-image asset kinds (audio, font)', () => {
    const ids = spriteAssets(assets).map((a) => a.id);
    expect(ids).not.toContain('theme');
    expect(ids).not.toContain('title-font');
  });

  it('preserves the incoming order', () => {
    const ordered = [asset('b', 'sprite'), asset('a', 'tile')];
    expect(spriteAssets(ordered).map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('maps the empty "None" option to null and a real id to itself', () => {
    expect(pickerValueToAssetId('')).toBeNull();
    expect(pickerValueToAssetId('hero')).toBe('hero');
  });
});
