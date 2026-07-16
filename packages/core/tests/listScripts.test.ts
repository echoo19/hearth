import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createProject } from '@hearth/core';

async function makeStore() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, store };
}

describe('ProjectStore.listScripts', () => {
  it('finds scripts in subdirectories, sorted, project-relative', async () => {
    const { fs, store } = await makeStore();
    await fs.writeFile('/proj/scripts/player.lua', 'return {}');
    await fs.writeFile('/proj/scripts/lib/noise.lua', 'return {}');

    expect(await store.listScripts()).toEqual(['scripts/lib/noise.lua', 'scripts/player.lua']);
  });

  it('ignores non-script files in subdirectories', async () => {
    const { fs, store } = await makeStore();
    await fs.writeFile('/proj/scripts/player.lua', 'return {}');
    await fs.writeFile('/proj/scripts/lib/README.md', '# Notes');

    expect(await store.listScripts()).toEqual(['scripts/player.lua']);
  });
});
