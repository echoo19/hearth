import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  generateSpriteSvg,
  generateTileSvg,
  SPRITE_SHAPES,
} from '@hearth/core';

const golden: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/proceduralFlat.golden.json', import.meta.url)), 'utf8'),
);

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Art Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

describe('procedural shading — flat default is byte-identical to today', () => {
  it('every shape (and the tile) matches the pre-change golden output', () => {
    for (const shape of SPRITE_SHAPES) {
      expect(generateSpriteSvg({ shape, color: '#3498db', width: 32, height: 32 }), `shape ${shape}`).toBe(
        golden[`sprite:${shape}`],
      );
    }
    expect(generateSpriteSvg({ shape: 'rectangle', color: '#e74c3c', width: 48, height: 24, cornerRadius: 4 })).toBe(golden['sprite:rect48x24']);
    expect(generateSpriteSvg({ shape: 'polygon', color: '#f1c40f', sides: 7 })).toBe(golden['sprite:polygon7']);
    expect(generateSpriteSvg({ shape: 'circle', color: '#2ecc71', strokeColor: '#000000', strokeWidth: 3 })).toBe(golden['sprite:stroked']);
    expect(generateSpriteSvg({ shape: 'coin', color: '#f1c40f', accentColor: '#e67e22' })).toBe(golden['sprite:withAccent']);
    expect(generateTileSvg('#2ecc71', 32)).toBe(golden['tile:default']);
    expect(generateTileSvg('#9b59b6', 16)).toBe(golden['tile:16']);
  });

  it("explicit shading:'flat' is identical to omitting it", () => {
    for (const shape of SPRITE_SHAPES) {
      const omitted = generateSpriteSvg({ shape, color: '#3498db' });
      const flat = generateSpriteSvg({ shape, color: '#3498db', shading: 'flat' });
      expect(flat, `shape ${shape}`).toBe(omitted);
      expect(flat).not.toContain('linearGradient');
    }
  });
});

describe('procedural shading — gradient variant', () => {
  it('renders a two-stop top-to-bottom linear gradient and fills the body with it', () => {
    const svg = generateSpriteSvg({ shape: 'rectangle', color: '#3498db', shading: 'gradient' });
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('x1="0" y1="0" x2="0" y2="1"'); // top -> bottom
    expect(svg.match(/<stop /g)?.length).toBe(2);
    expect(svg).toContain('fill="url(#hearthGrad)"');
    // Deterministic: same spec -> same SVG.
    expect(generateSpriteSvg({ shape: 'rectangle', color: '#3498db', shading: 'gradient' })).toBe(svg);
  });

  it('gradient works for every shape and stays valid SVG', () => {
    for (const shape of SPRITE_SHAPES) {
      const svg = generateSpriteSvg({ shape, color: '#e74c3c', shading: 'gradient' });
      expect(svg, `shape ${shape}`).toContain('linearGradient');
      expect(svg).toContain('fill="url(#hearthGrad)"');
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    }
  });

  it('defaults the second stop to a deterministic darken of the primary', () => {
    const svg = generateSpriteSvg({ shape: 'circle', color: '#3498db', shading: 'gradient' });
    // darken('#3498db', 0.6) => primary scaled to 60%.
    expect(svg).toContain('stop-color="#3498db"'); // light stop = primary
    expect(svg).toContain('stop-color="#1f5b83"'); // dark stop = darken(primary)
  });

  it('respects an explicit secondaryColor as the dark stop', () => {
    const svg = generateSpriteSvg({ shape: 'diamond', color: '#3498db', shading: 'gradient', secondaryColor: '#001122' });
    expect(svg).toContain('stop-color="#001122"');
    expect(svg).not.toContain('stop-color="#1f5b83"');
  });

  it('tiles support gradient shading too', () => {
    const flat = generateTileSvg('#2ecc71', 32);
    const grad = generateTileSvg('#2ecc71', 32, { shading: 'gradient' });
    expect(flat).not.toContain('linearGradient');
    expect(grad).toContain('linearGradient');
    expect(grad).toContain('fill="url(#hearthGrad)"');
  });
});

describe('createSpriteAsset / createTileAsset shading params', () => {
  it('createSpriteAsset default writes the flat SVG (metadata has no shading key)', async () => {
    const { session, fs } = await makeSession();
    const res = await session.execute<any>('createSpriteAsset', { name: 'Hero', shape: 'character', color: 'blue' });
    expect(res.success).toBe(true);
    const svg = await fs.readFile('/proj/' + res.data.asset.path);
    expect(svg).not.toContain('linearGradient');
    expect(res.data.asset.metadata.shading).toBeUndefined();
    expect(res.data.asset.metadata.secondaryColor).toBeUndefined();
  });

  it('createSpriteAsset shading=gradient writes a gradient SVG and records it in metadata', async () => {
    const { session, fs } = await makeSession();
    const res = await session.execute<any>('createSpriteAsset', {
      name: 'Shiny',
      shape: 'coin',
      color: '#f1c40f',
      shading: 'gradient',
      secondaryColor: '#b8860b',
    });
    expect(res.success).toBe(true);
    const svg = await fs.readFile('/proj/' + res.data.asset.path);
    expect(svg).toContain('linearGradient');
    expect(svg).toContain('stop-color="#b8860b"');
    expect(res.data.asset.metadata.shading).toBe('gradient');
    expect(res.data.asset.metadata.secondaryColor).toBe('#b8860b');
  });

  it('createTileAsset supports gradient shading', async () => {
    const { session, fs } = await makeSession();
    const res = await session.execute<any>('createTileAsset', { name: 'Grass', color: 'green', shading: 'gradient' });
    expect(res.success).toBe(true);
    const svg = await fs.readFile('/proj/' + res.data.asset.path);
    expect(svg).toContain('linearGradient');
  });
});
