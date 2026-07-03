import { describe, it, expect } from 'vitest';
import { createZip, crc32 } from '../src/zip.js';

/** Minimal zip reader: parses the archive createZip produced. */
function parseZip(buf: Buffer) {
  // End of central directory record is the last 22 bytes (no comment).
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
    expect(buf.readUInt16LE(cursor + 10)).toBe(0); // STORE
    const crc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const size = buf.readUInt32LE(cursor + 24);
    expect(compSize).toBe(size); // STORE: no compression
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    // Follow the pointer to the local header and pull the stored bytes out.
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    expect(buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8')).toBe(name);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + size);

    entries.push({ name, crc, size, data: Buffer.from(data) });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe('crc32', () => {
  it('matches the standard check vector', () => {
    // CRC-32 of "123456789" is the canonical test vector.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('createZip', () => {
  it('produces a store-only archive with a correct central directory and CRCs', () => {
    const files = [
      { path: 'index.html', data: new TextEncoder().encode('<!DOCTYPE html><title>hi</title>') },
      { path: 'assets/sprites/coin.svg', data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') },
      { path: 'project.bundle.json', data: new TextEncoder().encode('{"project":{"name":"Zip Game"}}') },
    ];
    const zip = createZip(files);

    const entries = parseZip(zip);
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.path));
    for (let i = 0; i < files.length; i++) {
      expect(entries[i].size).toBe(files[i].data.length);
      expect(entries[i].crc).toBe(crc32(files[i].data));
      expect(entries[i].data.equals(Buffer.from(files[i].data))).toBe(true);
    }
  });

  it('handles binary data and an empty archive', () => {
    const binary = new Uint8Array(256);
    for (let i = 0; i < binary.length; i++) binary[i] = i;
    const zip = createZip([{ path: 'blob.bin', data: binary }]);
    const [entry] = parseZip(zip);
    expect(entry.data.equals(Buffer.from(binary))).toBe(true);

    const empty = createZip([]);
    expect(empty.length).toBe(22); // just the end-of-central-directory record
    expect(parseZip(empty)).toEqual([]);
  });

  it('is deterministic (fixed timestamps)', () => {
    const files = [{ path: 'a.txt', data: new TextEncoder().encode('same') }];
    expect(createZip(files).equals(createZip(files))).toBe(true);
  });
});
