import { useEffect, useState } from 'react';
import { useEditor } from './store';
import type { HistoryList } from './types';

/**
 * Shared Undo/Redo history state used by both the Toolbar and the DiffPanel.
 * Reloads listHistory whenever a mutation lands (commandSeq) or the diff is
 * (re)loaded (diff), and derives undo/redo availability from the history
 * cursor. Each caller gets its own independent state/effect (no shared
 * subscription or cache) — the point is one source of truth for the logic,
 * not a single shared fetch.
 */
export function useHistoryList() {
  const diff = useEditor((s) => s.diff);
  const commandSeq = useEditor((s) => s.commandSeq);
  const exec = useEditor((s) => s.exec);
  const [history, setHistory] = useState<HistoryList | null>(null);

  async function reload() {
    const result = await exec<HistoryList>('listHistory', {}, { quiet: true });
    setHistory(result.success ? (result.data ?? null) : null);
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, commandSeq]);

  const cursor = history?.cursor ?? 0;
  const entries = history?.entries ?? [];
  const undoTarget = cursor > 0 ? entries[cursor - 1] : null;
  const redoTarget = cursor < entries.length ? entries[cursor] : null;

  return { history, undoTarget, redoTarget, reload };
}
