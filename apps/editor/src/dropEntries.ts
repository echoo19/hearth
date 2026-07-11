/**
 * Recursive folder-drop traversal for the Assets panel's drag-and-drop
 * import. Browsers hand a drop event's `DataTransferItem`s a
 * `webkitGetAsEntry()` — a `FileSystemFileEntry` or `FileSystemDirectoryEntry`
 * — which is the only way to tell a dropped folder apart from a dropped file
 * and to walk what's inside it. Kept as a pure function over entries (not a
 * DragEvent) so it's unit-testable with plain object doubles instead of a
 * real DOM/drag simulation.
 */

/** Structural subset of the two dropped-entry shapes this helper needs — real `FileSystemFileEntry`/`FileSystemDirectoryEntry` instances satisfy it, and so do plain test doubles. */
export type DropEntry = FileSystemFileEntry | FileSystemDirectoryEntry;

/**
 * Recursively walk dropped filesystem entries into a flat `File[]`,
 * descending into every directory. Directory reads are repeated until
 * `readEntries` reports empty — per the File and Directory Entries API spec,
 * a single call is not guaranteed to return every child, only a batch.
 */
export async function collectDropEntries(entries: readonly DropEntry[]): Promise<File[]> {
  const out: File[] = [];

  async function walk(entry: DropEntry): Promise<void> {
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let children: FileSystemEntry[];
      do {
        // eslint-disable-next-line no-await-in-loop -- directory reads are inherently sequential (each call continues where the last left off).
        children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of children) {
          // eslint-disable-next-line no-await-in-loop
          await walk(child as DropEntry);
        }
      } while (children.length > 0);
    } else {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      out.push(file);
    }
  }

  for (const entry of entries) await walk(entry);
  return out;
}

/** Pull `webkitGetAsEntry()` results out of a drop's DataTransferItemList, skipping items that aren't files/directories (e.g. dragged text). */
export function entriesFromDataTransferItems(items: DataTransferItemList): DropEntry[] {
  const entries: DropEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const getEntry = items[i]?.webkitGetAsEntry;
    const entry = typeof getEntry === 'function' ? getEntry.call(items[i]) : null;
    if (entry) entries.push(entry as DropEntry);
  }
  return entries;
}
