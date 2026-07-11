import { describe, expect, it } from 'vitest';
import { collectDropEntries, entriesFromDataTransferItems, type DropEntry } from '../src/dropEntries';

function fileEntry(name: string): DropEntry {
  return {
    isFile: true,
    isDirectory: false,
    file(success: (f: File) => void) {
      success({ name } as unknown as File);
    },
  } as unknown as DropEntry;
}

/** A directory entry whose `readEntries` hands back `batches` one call at a time, then an empty array — mirrors the real API's "call until empty" contract. */
function dirEntry(name: string, batches: DropEntry[][]): DropEntry {
  let call = 0;
  return {
    isFile: false,
    isDirectory: true,
    createReader() {
      return {
        readEntries(success: (entries: DropEntry[]) => void) {
          const batch = call < batches.length ? batches[call] : [];
          call++;
          success(batch);
        },
      };
    },
  } as unknown as DropEntry;
}

describe('collectDropEntries', () => {
  it('resolves plain file entries to their File objects', async () => {
    const files = await collectDropEntries([fileEntry('a.png'), fileEntry('b.wav')]);
    expect(files.map((f) => f.name)).toEqual(['a.png', 'b.wav']);
  });

  it('descends into a directory entry and collects its files', async () => {
    const dir = dirEntry('sprites', [[fileEntry('coin.png'), fileEntry('gem.png')]]);
    const files = await collectDropEntries([dir]);
    expect(files.map((f) => f.name).sort()).toEqual(['coin.png', 'gem.png']);
  });

  it('recurses into nested subdirectories', async () => {
    const nested = dirEntry('nested', [[fileEntry('deep.png')]]);
    const top = dirEntry('top', [[fileEntry('shallow.png'), nested]]);
    const files = await collectDropEntries([top]);
    expect(files.map((f) => f.name).sort()).toEqual(['deep.png', 'shallow.png']);
  });

  it('calls readEntries repeatedly until an empty batch, per the File and Directory Entries API contract', async () => {
    const dir = dirEntry('big', [[fileEntry('one.png')], [fileEntry('two.png')], []]);
    const files = await collectDropEntries([dir]);
    expect(files.map((f) => f.name).sort()).toEqual(['one.png', 'two.png']);
  });

  it('mixes top-level files and directories in one drop', async () => {
    const dir = dirEntry('folder', [[fileEntry('inside.png')]]);
    const files = await collectDropEntries([fileEntry('loose.png'), dir]);
    expect(files.map((f) => f.name).sort()).toEqual(['inside.png', 'loose.png']);
  });

  it('returns an empty array for no entries', async () => {
    expect(await collectDropEntries([])).toEqual([]);
  });
});

describe('entriesFromDataTransferItems', () => {
  function itemWithEntry(entry: DropEntry | null): DataTransferItem {
    return { webkitGetAsEntry: () => entry } as unknown as DataTransferItem;
  }

  it('collects webkitGetAsEntry() results, in order', () => {
    const a = fileEntry('a.png');
    const b = fileEntry('b.png');
    const list = [itemWithEntry(a), itemWithEntry(b)] as unknown as DataTransferItemList;
    Object.defineProperty(list, 'length', { value: 2 });
    expect(entriesFromDataTransferItems(list)).toEqual([a, b]);
  });

  it('skips items with no entry (e.g. dragged plain text) and items missing webkitGetAsEntry', () => {
    const a = fileEntry('a.png');
    const list = [
      itemWithEntry(a),
      itemWithEntry(null),
      {} as unknown as DataTransferItem,
    ] as unknown as DataTransferItemList;
    Object.defineProperty(list, 'length', { value: 3 });
    expect(entriesFromDataTransferItems(list)).toEqual([a]);
  });
});
