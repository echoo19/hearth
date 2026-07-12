import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipDirectory } from '../src/zip.js';

/** Minimal zip reader: parses the archive zipDirectory produced. */
function parseZip(buf: Buffer) {
  const eocdOffset = buf.length - 22;
  expect(buf.readUInt32LE(eocdOffset)).toBe(0x06054b50);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralSize = buf.readUInt32LE(eocdOffset + 12);
  const centralOffset = buf.readUInt32LE(eocdOffset + 16);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const entries: { name: string; crc: number; size: number; data: Buffer }[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    expect(buf.readUInt32LE(cursor)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const size = buf.readUInt32LE(cursor + 24);
    expect(compSize).toBe(size); // STORE: no compression
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + size);

    entries.push({ name, crc, size, data: Buffer.from(data) });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe('zipDirectory', () => {
  let tmpRoot: string;
  let srcDir: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-shipping-zip-'));
    srcDir = path.join(tmpRoot, 'export');
    await fsp.mkdir(path.join(srcDir, 'assets', 'sprites'), { recursive: true });
    await fsp.writeFile(path.join(srcDir, 'index.html'), '<!DOCTYPE html><title>hi</title>');
    await fsp.writeFile(path.join(srcDir, 'project.bundle.json'), '{"project":{"name":"Zip Game"}}');
    await fsp.writeFile(
      path.join(srcDir, 'assets', 'sprites', 'coin.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('places entries at the srcDir root (index.html at zip root)', async () => {
    const zipPath = path.join(tmpRoot, 'out.zip');
    await zipDirectory(srcDir, zipPath);

    const buf = await fsp.readFile(zipPath);
    const entries = parseZip(buf);
    const names = entries.map((e) => e.name);
    expect(names).toContain('index.html');
    expect(names).not.toContain('export/index.html');
  });

  it('orders entries deterministically (sorted by path)', async () => {
    const zipPath = path.join(tmpRoot, 'out.zip');
    await zipDirectory(srcDir, zipPath);

    const entries = parseZip(await fsp.readFile(zipPath));
    const names = entries.map((e) => e.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
    expect(names).toEqual(['assets/sprites/coin.svg', 'index.html', 'project.bundle.json']);
  });

  it('round-trips file contents exactly', async () => {
    const zipPath = path.join(tmpRoot, 'out.zip');
    await zipDirectory(srcDir, zipPath);

    const entries = parseZip(await fsp.readFile(zipPath));
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('index.html')!.data.toString('utf8')).toBe('<!DOCTYPE html><title>hi</title>');
    expect(byName.get('assets/sprites/coin.svg')!.data.toString('utf8')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
  });

  it('is deterministic across repeated runs', async () => {
    const zipPathA = path.join(tmpRoot, 'a.zip');
    const zipPathB = path.join(tmpRoot, 'b.zip');
    await zipDirectory(srcDir, zipPathA);
    await zipDirectory(srcDir, zipPathB);

    const bufA = await fsp.readFile(zipPathA);
    const bufB = await fsp.readFile(zipPathB);
    expect(bufA.equals(bufB)).toBe(true);
  });

  it('handles an empty directory', async () => {
    const emptyDir = path.join(tmpRoot, 'empty');
    await fsp.mkdir(emptyDir, { recursive: true });
    const zipPath = path.join(tmpRoot, 'empty.zip');
    await zipDirectory(emptyDir, zipPath);

    const entries = parseZip(await fsp.readFile(zipPath));
    expect(entries).toEqual([]);
  });

  it('leaves no partial file behind on a nonexistent srcDir', async () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    const zipPath = path.join(tmpRoot, 'never.zip');
    await expect(zipDirectory(missing, zipPath)).rejects.toThrow();
    expect(fs.existsSync(zipPath)).toBe(false);
  });
});
