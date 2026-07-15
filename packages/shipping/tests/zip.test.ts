import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipDirectory } from '../src/zip.js';

/** Minimal zip reader: parses the archive zipDirectory produced. */
function parseZip(buf: Buffer) {
  const eocdOffset = buf.length - 22;
  expect(buf.readUInt32LE(eocdOffset)).toBe(0x06054b50);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralSize = buf.readUInt32LE(eocdOffset + 12);
  const centralOffset = buf.readUInt32LE(eocdOffset + 16);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const entries: {
    name: string;
    crc: number;
    size: number;
    data: Buffer;
    madeByHigh: number;
    externalAttrs: number;
  }[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    expect(buf.readUInt32LE(cursor)).toBe(0x02014b50);
    const madeBy = buf.readUInt16LE(cursor + 4);
    const crc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const size = buf.readUInt32LE(cursor + 24);
    expect(compSize).toBe(size); // STORE: no compression
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const externalAttrs = buf.readUInt32LE(cursor + 38);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + size);

    entries.push({ name, crc, size, data: Buffer.from(data), madeByHigh: madeBy >> 8, externalAttrs });
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

  // UNIX-only: asserts exact st_mode bits and uses symlinks/chmod that have no
  // faithful Windows equivalent (Windows lacks per-file exec bits). The
  // production zip code still runs on Windows; only these mode assertions are
  // platform-specific.
  it.skipIf(process.platform === 'win32')('encodes UNIX modes in the central directory for symlinks AND regular files', async () => {
    // Byte-layout regression test. Every entry is now UNIX "made by" (high
    // byte 3) and carries an st_mode in the high 16 bits of external
    // attributes: symlinks keep S_IFLNK|0777, regular files carry their real
    // permission bits (so the +x on a packaged .app's binaries survives the
    // zip round-trip — D-1). Modes are chmod'd explicitly here so the byte
    // assertions are deterministic regardless of the test host's umask.
    const symDir = path.join(tmpRoot, 'symtest');
    await fsp.mkdir(symDir, { recursive: true });
    await fsp.writeFile(path.join(symDir, 'real.txt'), 'hello');
    await fsp.chmod(path.join(symDir, 'real.txt'), 0o644);
    await fsp.writeFile(path.join(symDir, 'run.sh'), '#!/bin/sh\n');
    await fsp.chmod(path.join(symDir, 'run.sh'), 0o755);
    await fsp.symlink('real.txt', path.join(symDir, 'link.txt'));

    const zipPath = path.join(tmpRoot, 'sym.zip');
    await zipDirectory(symDir, zipPath);

    const entries = parseZip(await fsp.readFile(zipPath));
    const byName = new Map(entries.map((e) => [e.name, e]));

    const link = byName.get('link.txt')!;
    expect(link.madeByHigh).toBe(3); // UNIX
    expect(link.externalAttrs).toBe((0o120777 << 16) >>> 0); // S_IFLNK | 0777
    expect(link.data.toString('utf8')).toBe('real.txt'); // content is the link target

    const real = byName.get('real.txt')!;
    expect(real.madeByHigh).toBe(3); // UNIX for every entry now
    expect(real.externalAttrs).toBe((0o100644 << 16) >>> 0); // S_IFREG | 0644
    expect(real.data.toString('utf8')).toBe('hello');

    const exe = byName.get('run.sh')!;
    expect(exe.madeByHigh).toBe(3);
    expect(exe.externalAttrs).toBe((0o100755 << 16) >>> 0); // S_IFREG | 0755 — exec bit preserved
  });

  // UNIX-only: relies on the system `unzip` restoring the +x bit, which Windows
  // has no equivalent for.
  it.skipIf(process.platform === 'win32')('preserves the executable bit through a real system-unzip round-trip', async () => {
    // The exact user journey that was broken (D-1): a packaged .app is zipped,
    // downloaded, and unzipped with the SYSTEM unzip — its Mach-O binary must
    // still be executable or the app cannot launch. Drive it end-to-end with
    // the real `unzip`, not by reading the buffer.
    const src = path.join(tmpRoot, 'bundle');
    await fsp.mkdir(src, { recursive: true });
    await fsp.writeFile(path.join(src, 'game-binary'), '#!/bin/sh\necho hi\n');
    await fsp.chmod(path.join(src, 'game-binary'), 0o755);
    await fsp.writeFile(path.join(src, 'data.txt'), 'not executable');
    await fsp.chmod(path.join(src, 'data.txt'), 0o644);

    const zipPath = path.join(tmpRoot, 'bundle.zip');
    await zipDirectory(src, zipPath);

    const outDir = path.join(tmpRoot, 'unzipped');
    await fsp.mkdir(outDir, { recursive: true });
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', outDir]);

    const binMode = (await fsp.stat(path.join(outDir, 'game-binary'))).mode;
    const dataMode = (await fsp.stat(path.join(outDir, 'data.txt'))).mode;
    expect(binMode & 0o111).not.toBe(0); // at least one exec bit set — launchable
    expect(binMode & 0o100).toBe(0o100); // owner-exec specifically
    expect(dataMode & 0o111).toBe(0); // plain data stays non-executable
  });

  it('leaves no partial file behind on a nonexistent srcDir', async () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    const zipPath = path.join(tmpRoot, 'never.zip');
    await expect(zipDirectory(missing, zipPath)).rejects.toThrow();
    expect(fs.existsSync(zipPath)).toBe(false);
  });
});
