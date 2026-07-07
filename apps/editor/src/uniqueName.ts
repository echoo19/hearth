/**
 * Pure name-collision helper shared by the Hierarchy's "new/duplicate entity"
 * defaults and the Toolbar scene menu's "duplicate scene" default — both need
 * a client-side guess at a name that won't collide before the command even
 * runs (scene names are enforced unique server-side; entity names aren't, but
 * a repeated "X copy" is still confusing in the tree).
 */

/** `base` if free, otherwise `base 2`, `base 3`, ... until one isn't in `existing`. */
export function uniqueName(existing: Iterable<string>, base: string): string {
  const taken = existing instanceof Set ? existing : new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
