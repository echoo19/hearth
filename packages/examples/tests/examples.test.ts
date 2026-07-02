import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore, validateProject } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';

const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = ['mini-platformer', 'top-down-room', 'visual-novel'];

describe('example projects', () => {
  for (const name of EXAMPLES) {
    it(`${name} loads and validates with zero errors`, async () => {
      const store = await ProjectStore.load(new NodeFileSystem(), path.join(examplesDir, name));
      expect(store.project.initialScene).toBeTruthy();
      expect(store.scenes.size).toBeGreaterThan(0);
      const report = await validateProject(store);
      expect(report.errors).toEqual([]);
    });
  }

  it('mini-platformer has the expected cast', async () => {
    const store = await ProjectStore.load(
      new NodeFileSystem(),
      path.join(examplesDir, 'mini-platformer'),
    );
    const scene = store.getScene('Level 1')!;
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Player');
    expect(names).toContain('Enemy');
    expect(names).toContain('Score');
    expect(names.filter((n) => n.startsWith('Coin')).length).toBe(3);
    expect(store.playtests.size).toBe(3);
  });
});
