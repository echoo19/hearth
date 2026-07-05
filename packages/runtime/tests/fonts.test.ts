/**
 * loadFontFaces: pure load/guard/failure logic, exercised without a real
 * browser. The full PixiSceneView.mount() integration (Text actually
 * rendering with a loaded font) is Chromium-gated in
 * packages/playtest/tests/screenshot.test.ts, since PixiSceneView needs a
 * real canvas/WebGL context this suite's plain-node environment doesn't have.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@hearth/core';
import { loadFontFaces } from '../src/pixi/fonts.js';

function fontAsset(name: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id: `ast_${name}`,
    name,
    type: 'font',
    path: `assets/font/${name}.ttf`,
    metadata: {},
    ...overrides,
  } as Asset;
}

describe('loadFontFaces: headless guard', () => {
  it('skips silently (no resolveAssetUrl/onWarn calls) when FontFace/document are undefined', async () => {
    // This suite's vitest environment is plain "node" — no FontFace, no
    // document — so this exercises the real guard, not a stub.
    expect(typeof FontFace).toBe('undefined');
    const resolveAssetUrl = vi.fn(() => 'blob:should-not-be-called');
    const onWarn = vi.fn();

    await expect(loadFontFaces([fontAsset('Pixel')], resolveAssetUrl, onWarn)).resolves.toBeUndefined();

    expect(resolveAssetUrl).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('loadFontFaces: load/register/failure (stubbed FontFace + document)', () => {
  class FakeFontFace {
    static instances: FakeFontFace[] = [];
    constructor(
      public family: string,
      public source: string,
    ) {
      FakeFontFace.instances.push(this);
    }
    load(): Promise<this> {
      if (this.family === 'Bad') return Promise.reject(new Error('parse error'));
      return Promise.resolve(this);
    }
  }

  const added: FakeFontFace[] = [];
  const fakeDocument = { fonts: { add: (f: FakeFontFace) => added.push(f) } };

  afterEach(() => {
    FakeFontFace.instances = [];
    added.length = 0;
    vi.unstubAllGlobals();
  });

  it('constructs a FontFace named EXACTLY the asset name, from resolveAssetUrl(asset) as a QUOTED url(), and registers it', async () => {
    vi.stubGlobal('FontFace', FakeFontFace);
    vi.stubGlobal('document', fakeDocument);

    const asset = fontAsset('PressStart2P');
    const resolveAssetUrl = vi.fn(() => 'data:font/ttf;base64,AAAA');
    const onWarn = vi.fn();

    await loadFontFaces([asset], resolveAssetUrl, onWarn);

    expect(resolveAssetUrl).toHaveBeenCalledWith(asset);
    expect(FakeFontFace.instances).toHaveLength(1);
    expect(FakeFontFace.instances[0].family).toBe('PressStart2P');
    expect(FakeFontFace.instances[0].source).toBe('url("data:font/ttf;base64,AAAA")');
    expect(added).toEqual(FakeFontFace.instances);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('quotes a URL containing a space (multi-file exports keep the original filename verbatim)', async () => {
    vi.stubGlobal('FontFace', FakeFontFace);
    vi.stubGlobal('document', fakeDocument);

    // importAsset keeps the source file's basename, so an asset imported
    // from "My Font.ttf" resolves (in a multi-file export, where
    // resolveAssetUrl returns asset.path as-is) to a URL with a space —
    // invalid inside an UNQUOTED url() token, fine when quoted.
    await loadFontFaces([fontAsset('MyFont')], () => 'assets/font/My Font.ttf');

    expect(FakeFontFace.instances[0].source).toBe('url("assets/font/My Font.ttf")');
  });

  it('escapes double quotes and backslashes inside the quoted URL', async () => {
    vi.stubGlobal('FontFace', FakeFontFace);
    vi.stubGlobal('document', fakeDocument);

    await loadFontFaces([fontAsset('Odd')], () => 'assets/font/say-"hi"\\now.ttf');

    expect(FakeFontFace.instances[0].source).toBe('url("assets/font/say-\\"hi\\"\\\\now.ttf")');
  });

  it('warns and continues past a single font whose load() rejects, still loading the rest', async () => {
    vi.stubGlobal('FontFace', FakeFontFace);
    vi.stubGlobal('document', fakeDocument);

    const bad = fontAsset('Bad');
    const good = fontAsset('Good');
    const onWarn = vi.fn();

    await expect(
      loadFontFaces([bad, good], () => 'data:font/ttf;base64,AAAA', onWarn),
    ).resolves.toBeUndefined();

    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith('font: failed to load asset Bad: parse error');
    // The failure didn't stop the next font from loading and registering.
    expect(added.map((f) => f.family)).toEqual(['Good']);
  });
});
