/**
 * What the agent changed on disk.
 *
 * This is the one kind of tool activity that earns a container: a command
 * scrolls past, but an edit to the game is the thing the reader came for, and
 * it needs to be findable while scanning back through a long turn.
 *
 * One card per report, one row per file — path (clipped from the left so the
 * filename always survives), the shape of the change as +n / −n, and the patch
 * itself one click away.
 */
import React, { useState } from 'react';
import { useApp } from '../../store';
import type { ChatFileChangePart, FileChangeEntry, FileChangeKind } from '../../types';
import { Icon } from '../ui';
import { relativeTo, shortenPath } from './ToolChip';

/** Plain-language verb for what happened to a file. */
export function fileChangeVerb(kind: FileChangeKind): string {
  switch (kind) {
    case 'create':
      return 'Added';
    case 'delete':
      return 'Deleted';
    default:
      return 'Edited';
  }
}

/**
 * Added / removed line counts from a unified diff. The `+++`/`---` file
 * headers are not content and must not be counted; a report with no diff
 * reports nothing rather than guessing a size.
 */
export function diffCounts(diff: string | undefined): { added: number; removed: number } | null {
  if (!diff) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** Which colour a diff line reads in: an addition, a removal, or context. */
export function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'diff-meta';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return 'diff-ctx';
}

function FileRow({ file }: { file: FileChangeEntry }) {
  const [open, setOpen] = useState(false);
  const projectPath = useApp((s) => s.projectPath);
  const openCodePeek = useApp((s) => s.openCodePeek);
  const counts = diffCounts(file.diff);

  return (
    <li className="filechange-row" data-open={open}>
      <button
        type="button"
        className="filechange-line"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="filechange-chevron" aria-hidden="true">
          <Icon name="chevron" size={9} />
        </span>
        <span className="filechange-verb">{fileChangeVerb(file.kind)}</span>
        <span className="filechange-path">{shortenPath(file.path, projectPath)}</span>
        {counts && (
          <span className="filechange-counts">
            {counts.added > 0 && <span className="count-add">+{counts.added}</span>}
            {counts.removed > 0 && <span className="count-del">−{counts.removed}</span>}
          </span>
        )}
      </button>
      {open && (
        <div className="filechange-body">
          {file.diff ? (
            <pre className="filechange-diff">
              {file.diff.split('\n').map((line, index) => (
                <span key={index} className={diffLineClass(line)}>
                  {line || ' '}
                </span>
              ))}
            </pre>
          ) : (
            <p className="filechange-empty">No patch was reported for this change.</p>
          )}
          {file.kind !== 'delete' && (
            <button
              type="button"
              className="tool-open"
              onClick={() => openCodePeek(relativeTo(file.path, projectPath))}
            >
              Open file
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function FileChangeCard({ part }: { part: ChatFileChangePart }) {
  return (
    <div className="filechange-card">
      <ul className="filechange-rows">
        {part.files.map((file) => (
          <FileRow key={file.path} file={file} />
        ))}
      </ul>
    </div>
  );
}
