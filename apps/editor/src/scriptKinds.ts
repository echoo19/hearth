/**
 * Script kind classification: which of the project's scripts are LIBRARIES —
 * scripts with no lifecycle hooks, meant to be require()d by behaviors rather
 * than attached to entities (spec decision 6: a
 * library is just a hookless script, never a new asset type). The Code
 * panel's script tree labels them and the Inspector's Script picker keeps
 * them out of the attachable list, because attaching a hookless script
 * silently does nothing.
 *
 * Detection is a STATIC text check, done server-side by the existing
 * read-only `searchScripts` command in ONE round trip: any script matching a
 * lifecycle-hook declaration pattern is a behavior; the rest are libraries.
 * Deliberately cheap and fail-safe rather than clever:
 *  - a hook name in a comment counts as a hook, so a false positive only ever
 *    mislabels a library as a behavior (the picker keeps offering it — the
 *    pre-existing trap, no worse), never hides a real behavior;
 *  - a capped search (500+ matches) means classification is unknown, so
 *    NOTHING is labeled a library that pass (same fail-safe direction);
 *  - scripts are never executed to find out.
 */
import { useEffect, useState } from 'react';
import { useEditor } from './store';
import { toExternalChangeEntries } from './components/code/buffers';
import type { JournalEntry } from './types';

/**
 * The lifecycle hooks a script may export (runtime's ScriptHooks), as a
 * server-side `searchScripts` regex: the hook name declared/assigned/called —
 * `function script.onUpdate(` (Lua), `onUpdate = function` (Lua table),
 * `onUpdate(ctx) {` / `onUpdate: (ctx) =>` (JS). Case-sensitive on purpose;
 * hook names are exact.
 */
export const HOOK_SEARCH_PATTERN = '\\bon(Start|Update|Collision|UiEvent|Event)\\s*[=:(]';

/**
 * Pure classification step: given every script path and the paths that
 * matched HOOK_SEARCH_PATTERN, the libraries are the rest. `capped` means the
 * search result was truncated server-side, so absence from `matchedPaths`
 * proves nothing — classify nothing as a library rather than guess.
 */
export function librariesFrom(
  scripts: readonly string[],
  matchedPaths: Iterable<string>,
  capped: boolean,
): ReadonlySet<string> {
  if (capped) return new Set();
  const hooked = new Set(matchedPaths);
  return new Set(scripts.filter((path) => !hooked.has(path)));
}

/**
 * The newest journal seq that touched a script's CONTENT — the reclassify
 * trigger (a human adding an onUpdate to a library, an agent stripping hooks
 * from a behavior). Uses the same command→script mapping as the Code panel's
 * external-change follow (toExternalChangeEntries), and like it, skips failed
 * entries. Script create/delete need no entry here: they change the scripts
 * LIST, which is its own recompute key in useLibraryScripts.
 */
export function lastScriptChangeSeq(feed: readonly JournalEntry[]): number {
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i];
    if (!entry.ok) continue;
    if (toExternalChangeEntries(entry).some((e) => e.kind === 'script')) return entry.seq;
  }
  return 0;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** searchScripts response fields this module reads. */
interface HookSearchResult {
  matches: Array<{ path: string }>;
  capped: boolean;
}

// One in-flight/settled classification shared across every hook consumer
// (CodePanel and Inspector both call useLibraryScripts): keyed by
// project + script list + last script-change seq, so both panels reuse a
// single searchScripts round trip per invalidation instead of racing two.
let sharedClassification: { key: string; promise: Promise<ReadonlySet<string>> } | null = null;

function classifyOnce(key: string, run: () => Promise<ReadonlySet<string>>): Promise<ReadonlySet<string>> {
  if (sharedClassification?.key !== key) sharedClassification = { key, promise: run() };
  return sharedClassification.promise;
}

/** Test-only: drops the shared classification so tests are order-independent. */
export function resetScriptKindCache(): void {
  sharedClassification = null;
}

/**
 * The project's library scripts, as a live set. Empty until the first
 * classification lands (and on a failed/offline query) — the fail-safe
 * direction again: an unclassified script is presented as a behavior.
 */
export function useLibraryScripts(): ReadonlySet<string> {
  const projectPath = useEditor((s) => s.projectPath);
  const scripts = useEditor((s) => s.info?.scripts);
  const query = useEditor((s) => s.query);
  const scriptChangeSeq = useEditor((s) => lastScriptChangeSeq(s.journalFeed));
  const [libraries, setLibraries] = useState<ReadonlySet<string>>(EMPTY_SET);

  const scriptsKey = scripts?.join('\n') ?? '';
  useEffect(() => {
    if (!projectPath || !scripts || scripts.length === 0) {
      setLibraries(EMPTY_SET);
      return;
    }
    let cancelled = false;
    const key = `${projectPath}\x00${scriptChangeSeq}\x00${scriptsKey}`;
    const paths = scripts;
    void classifyOnce(key, async () => {
      const result = await query<HookSearchResult>('searchScripts', {
        query: HOOK_SEARCH_PATTERN,
        regex: true,
        caseSensitive: true,
      });
      if (!result) return EMPTY_SET; // offline/failed → label nothing
      return librariesFrom(
        paths,
        result.matches.map((m) => m.path),
        result.capped,
      );
    }).then((set) => {
      if (!cancelled) setLibraries(set);
    });
    return () => {
      cancelled = true;
    };
    // scriptsKey stands in for the scripts array's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, scriptsKey, scriptChangeSeq, query]);

  return libraries;
}
