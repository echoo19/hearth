/**
 * Web player loading-layer helpers (pure, headless). The player entry itself
 * assigns window.HearthPlayer at module scope and only runs in a browser.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LOADING_BACKGROUND,
  assetNeedsRawContent,
  loadingForegroundColor,
  normalizeLoadingSettings,
  parseHexColor,
  resolveBundleAssetUrl,
} from '../src/player/loading.js';

describe('normalizeLoadingSettings', () => {
  it('defaults to a plain black background, no image, no spinner', () => {
    for (const project of [undefined, null, {}, { buildSettings: {} }]) {
      expect(normalizeLoadingSettings(project)).toEqual({
        backgroundColor: DEFAULT_LOADING_BACKGROUND,
        image: null,
        spinner: false,
      });
    }
  });

  it('passes through user-configured loading settings', () => {
    const project = {
      buildSettings: {
        loading: { backgroundColor: '#1b2b3c', image: 'ast_logo1', spinner: true },
      },
    };
    expect(normalizeLoadingSettings(project)).toEqual({
      backgroundColor: '#1b2b3c',
      image: 'ast_logo1',
      spinner: true,
    });
  });

  it('treats null/empty image and malformed fields as defaults', () => {
    const project = {
      buildSettings: { loading: { backgroundColor: '', image: null, spinner: 'yes' } },
    };
    expect(normalizeLoadingSettings(project)).toEqual({
      backgroundColor: DEFAULT_LOADING_BACKGROUND,
      image: null,
      spinner: false,
    });
  });
});

describe('loadingForegroundColor', () => {
  it('is white on dark backgrounds, black on light ones', () => {
    expect(loadingForegroundColor('#000000')).toBe('#ffffff');
    expect(loadingForegroundColor('#123456')).toBe('#ffffff');
    expect(loadingForegroundColor('#ffffff')).toBe('#000000');
    expect(loadingForegroundColor('#fff')).toBe('#000000');
    expect(loadingForegroundColor('#ffee88')).toBe('#000000');
  });

  it('falls back to white for unparseable colors (default bg is black)', () => {
    expect(loadingForegroundColor('papayawhip')).toBe('#ffffff');
    expect(loadingForegroundColor('')).toBe('#ffffff');
  });
});

describe('parseHexColor', () => {
  it('parses #rrggbb and #rgb', () => {
    expect(parseHexColor('#102030')).toEqual({ r: 16, g: 32, b: 48 });
    expect(parseHexColor('#fa0')).toEqual({ r: 255, g: 170, b: 0 });
    expect(parseHexColor(' #FFFFFF ')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('rejects everything else', () => {
    expect(parseHexColor('red')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull();
    expect(parseHexColor('rgb(1,2,3)')).toBeNull();
  });
});

describe('assetNeedsRawContent', () => {
  it('flags the asset types the runtime reads off the store fs', () => {
    // Multi-file exports fetch these into the player's in-memory fs so
    // loadAnimations / loadPrefabs can read them; missing one silently
    // freezes that feature (the Wave A regression class).
    expect(assetNeedsRawContent('animation')).toBe(true);
    expect(assetNeedsRawContent('prefab')).toBe(true);
    expect(assetNeedsRawContent('stateMachine')).toBe(true);
  });

  it('does not flag URL-loaded asset types', () => {
    for (const type of ['sprite', 'audio', 'font', 'image', 'unknown']) {
      expect(assetNeedsRawContent(type)).toBe(false);
    }
  });
});

describe('resolveBundleAssetUrl', () => {
  const assets = [
    { id: 'ast_data1', path: 'assets/logo.png', dataUri: 'data:image/png;base64,AAAA' },
    { id: 'ast_path1', path: 'assets/title.svg' },
    { id: 'ast_bare1' },
  ];

  it('prefers the inline dataUri, then the relative path', () => {
    expect(resolveBundleAssetUrl(assets, 'ast_data1')).toBe('data:image/png;base64,AAAA');
    expect(resolveBundleAssetUrl(assets, 'ast_path1')).toBe('assets/title.svg');
  });

  it('returns null for unknown ids, null ids, and url-less assets', () => {
    expect(resolveBundleAssetUrl(assets, 'ast_nope')).toBeNull();
    expect(resolveBundleAssetUrl(assets, null)).toBeNull();
    expect(resolveBundleAssetUrl(assets, 'ast_bare1')).toBeNull();
  });
});
