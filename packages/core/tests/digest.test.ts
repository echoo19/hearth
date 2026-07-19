/**
 * The engine-generated project digest (`.hearth/digest.md`): a compact,
 * always-current markdown snapshot of project state. The agent reads this
 * instead of re-running `inspect` every turn, so it never re-derives what it
 * already had. Generated synchronously from the in-memory store, so it is
 * exactly as accurate as an inspect.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  generateDigest,
  writeDigest,
  DIGEST_FILE,
} from '../src/index.js';

async function freshSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Coin Quest' });
  const session = HearthSession.fromStore(store);
  return { fs, store, session };
}

describe('generateDigest', () => {
  it('renders project identity, initial scene, and the default scene', async () => {
    const { store } = await freshSession();
    const md = generateDigest(store);
    expect(md).toContain('Coin Quest');
    expect(md).toMatch(/initial scene/i);
    expect(md).toContain('Main'); // the default scene + camera
  });

  it('lists an entity with its component types and tags after it is created', async () => {
    const { store, session } = await freshSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Coin',
      tags: ['pickup'],
      components: { SpriteRenderer: { shape: 'circle', color: '#f1c40f' }, Collider: { isTrigger: true } },
    });
    const md = generateDigest(store);
    expect(md).toContain('Coin');
    expect(md).toContain('SpriteRenderer');
    expect(md).toContain('Collider');
    expect(md).toContain('pickup');
  });

  it('shows the script path for an entity with a Script component', async () => {
    const { store, session } = await freshSession();
    await session.execute('createEntity', { scene: 'Main', name: 'Hero', components: {} });
    await session.execute('createScript', { name: 'hero-move' });
    await session.execute('attachScript', { scene: 'Main', entity: 'Hero', script: 'scripts/hero-move.lua' });
    const md = generateDigest(store);
    expect(md).toContain('Hero');
    expect(md).toContain('scripts/hero-move.lua');
  });

  it('summarizes assets by type', async () => {
    const { store, session } = await freshSession();
    await session.execute('createSound', { name: 'pickup', preset: 'coin' });
    const md = generateDigest(store);
    expect(md).toMatch(/asset/i);
    expect(md).toContain('pickup');
  });
});

describe('writeDigest', () => {
  it('writes the digest to .hearth/digest.md', async () => {
    const { fs, store } = await freshSession();
    await writeDigest(fs, '/proj', store);
    const written = await fs.readFile('/proj/' + DIGEST_FILE);
    expect(written).toContain('Coin Quest');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('never throws on a write failure (best-effort; must not block a command)', async () => {
    const { store } = await freshSession();
    const brokenFs = {
      ...store.fs,
      writeFile: () => Promise.reject(new Error('disk full')),
      mkdir: () => Promise.resolve(),
    } as unknown as MemoryFileSystem;
    await expect(writeDigest(brokenFs, '/proj', store)).resolves.toBeUndefined();
  });
});
