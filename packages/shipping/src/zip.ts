/**
 * Minimal STORE-only (no compression) ZIP writer, lifted from the CLI's
 * `zipExportedDir` (packages/cli/src/program.ts) so shipping can produce
 * Electron/itch.io-style archives without depending on the CLI package.
 * Node-only; deliberately tiny — no compression, no zip64, no streaming.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface ZipInputEntry {
  /** Forward-slash path inside the archive, e.g. "assets/sprites/coin.svg". */
  path: string;
  data: Uint8Array;
  /**
   * When true, this entry is a symbolic link whose `data` is the (UTF-8) link
   * target. macOS `.app` bundles rely on relative symlinks inside their
   * frameworks, so they must be preserved as links, not dereferenced.
   */
  symlink?: boolean;
}

/** Unix `st_mode` for a symlink with 0777 perms (S_IFLNK | rwxrwxrwx). */
const SYMLINK_MODE = 0o120777;
/** "Version made by": low byte = zip spec 2.0, high byte = 3 (UNIX) for symlinks. */
const MADE_BY_UNIX = (3 << 8) | 20;

// --- CRC-32 (IEEE 802.3) ----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Archive building --------------------------------------------------------

/** Fixed MS-DOS timestamp (2026-01-01 00:00:00) so archives are deterministic. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** Build a complete STORE-only zip archive from in-memory entries. */
export function createZip(entries: ZipInputEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(entry.data);

    // Local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: STORE
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size (== raw for STORE)
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, name, data);

    // Central directory header
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(entry.symlink ? MADE_BY_UNIX : 20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    central.writeUInt16LE(0, 10); // method: STORE
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    // External attrs: high 16 bits carry the unix mode for symlinks so that
    // unzip/ditto recreate them as links rather than plain files.
    central.writeUInt32LE(entry.symlink ? (SYMLINK_MODE << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);

  // End of central directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// --- Directory zipping -------------------------------------------------------

/**
 * Zip every file under `srcDir` into `zipPath`, STORE-only, with entries
 * relative to `srcDir` (so e.g. `srcDir/index.html` sits at the zip root —
 * what Electron's `loadFile` and itch.io both expect). Entries are sorted by
 * path for deterministic output. Throws (and leaves no zip file behind) if
 * `srcDir` does not exist.
 */
export async function zipDirectory(srcDir: string, zipPath: string): Promise<void> {
  const srcAbs = path.resolve(srcDir);
  const entries: ZipInputEntry[] = [];

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(srcAbs, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        // Preserve links (do not follow) — dereferencing would bloat the
        // archive and could loop on the cyclic symlinks in macOS frameworks.
        entries.push({ path: rel, data: Buffer.from(await fsp.readlink(abs), 'utf8'), symlink: true });
      } else if (entry.isDirectory()) {
        await walk(abs);
      } else {
        entries.push({ path: rel, data: await fsp.readFile(abs) });
      }
    }
  };
  await walk(srcAbs);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  await fsp.writeFile(zipPath, createZip(entries));
}
