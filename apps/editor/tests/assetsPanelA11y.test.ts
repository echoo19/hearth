import { describe, expect, it } from 'vitest';
import { assignTarget, isActivationKey, matchesAssetQuery, unsupportedExtensionReason } from '../src/components/AssetsPanel';

describe('isActivationKey (AssetsPanel asset-card keyboard activation)', () => {
  it('treats Enter as an activation key', () => {
    expect(isActivationKey('Enter')).toBe(true);
  });

  it('treats Space as an activation key', () => {
    expect(isActivationKey(' ')).toBe(true);
  });

  it('does not treat other keys as activation keys', () => {
    expect(isActivationKey('Tab')).toBe(false);
    expect(isActivationKey('Escape')).toBe(false);
    expect(isActivationKey('a')).toBe(false);
  });
});

describe('matchesAssetQuery (ASSETS-4 name/type filter)', () => {
  const sheet = { name: 'courier-sheet', type: 'sprite' as const };
  const walk = { name: 'courier-walk', type: 'animation' as const };

  it('matches everything for an empty/whitespace query', () => {
    expect(matchesAssetQuery(sheet, '')).toBe(true);
    expect(matchesAssetQuery(sheet, '   ')).toBe(true);
  });

  it('matches a substring of the name, case-insensitively', () => {
    expect(matchesAssetQuery(sheet, 'Courier')).toBe(true);
    expect(matchesAssetQuery(sheet, 'SHEET')).toBe(true);
    expect(matchesAssetQuery(sheet, 'walk')).toBe(false);
  });

  it('matches a substring of the type label', () => {
    expect(matchesAssetQuery(sheet, 'sprite')).toBe(true);
    expect(matchesAssetQuery(walk, 'anim')).toBe(true);
    expect(matchesAssetQuery(sheet, 'animation')).toBe(false);
  });
});

describe('unsupportedExtensionReason (ASSETS-8 skip-reason copy)', () => {
  it('leads with the actual problem instead of the full capability list', () => {
    expect(unsupportedExtensionReason('unsupported.xyz')).toBe('".xyz" files aren\'t supported');
  });

  it('is case-insensitive on the extension', () => {
    expect(unsupportedExtensionReason('sprite.PSD')).toBe('".psd" files aren\'t supported');
  });

  it('handles a file with no extension (extensionOf returns "" for a trailing dot / empty name)', () => {
    expect(unsupportedExtensionReason('file.')).toBe("files without an extension aren't supported");
  });
});

describe('assignTarget (Assign compatibility rule shared by button/dblclick/context-menu)', () => {
  it('targets SpriteRenderer.assetId for a sprite onto an entity with SpriteRenderer', () => {
    expect(assignTarget({ type: 'sprite' as const }, { components: { SpriteRenderer: {} } })).toEqual({
      property: 'SpriteRenderer.assetId',
    });
  });

  it('targets SpriteRenderer.assetId for a tile too', () => {
    expect(assignTarget({ type: 'tile' as const }, { components: { SpriteRenderer: {} } })).toEqual({
      property: 'SpriteRenderer.assetId',
    });
  });

  it('targets AudioSource.assetId for audio onto an entity with AudioSource', () => {
    expect(assignTarget({ type: 'audio' as const }, { components: { AudioSource: {} } })).toEqual({
      property: 'AudioSource.assetId',
    });
  });

  it('is null when the asset type and entity component are incompatible', () => {
    expect(assignTarget({ type: 'sprite' as const }, { components: { AudioSource: {} } })).toBeNull();
    expect(assignTarget({ type: 'audio' as const }, { components: { SpriteRenderer: {} } })).toBeNull();
  });

  it('is null for asset types that are never assignable (prefab, stateMachine)', () => {
    expect(assignTarget({ type: 'prefab' as const }, { components: { SpriteRenderer: {} } })).toBeNull();
    expect(assignTarget({ type: 'stateMachine' as const }, { components: { SpriteRenderer: {} } })).toBeNull();
  });

  it('is null with no asset or no entity', () => {
    expect(assignTarget(null, { components: {} })).toBeNull();
    expect(assignTarget({ type: 'sprite' as const }, null)).toBeNull();
    expect(assignTarget({ type: 'sprite' as const }, undefined)).toBeNull();
  });
});
