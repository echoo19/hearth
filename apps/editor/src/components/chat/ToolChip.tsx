/**
 * A tool call, inline in the conversation.
 *
 * One quiet line by default — what ran and what it touched — because a turn
 * that edits nine files should read as nine lines, not nine cards. Clicking
 * expands the detail for the one line the reader actually cares about.
 */
import React, { useState } from 'react';
import type { ChatToolPart } from '../../types';
import { useApp } from '../../store';
import { Icon } from '../ui';

/**
 * Plain-language verb for a tool name. The agent's tool vocabulary is its
 * own; this maps the common ones onto something a game maker reads without
 * translating, and passes anything else through unchanged.
 */
export function toolVerb(name: string): string {
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return 'Read';
    case 'Write':
      return 'Wrote';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'Edited';
    case 'Bash':
    case 'BashOutput':
      return 'Ran';
    case 'Glob':
    case 'Grep':
      return 'Searched';
    case 'WebFetch':
    case 'WebSearch':
      return 'Looked up';
    case 'TodoWrite':
      return 'Planned';
    case 'Task':
      return 'Delegated';
    default:
      return name;
  }
}

/** Does this tool's detail name a file the code peek can open? */
export function detailIsFile(detail: string | undefined): boolean {
  if (!detail) return false;
  if (detail.includes(' ') || detail.includes('\n')) return false;
  return /\.[a-z0-9]{1,8}$/i.test(detail);
}

export function ToolChip({ part }: { part: ChatToolPart }) {
  const [open, setOpen] = useState(false);
  const openCodePeek = useApp((s) => s.openCodePeek);
  const projectPath = useApp((s) => s.projectPath);
  const detail = part.detail;
  const isFile = detailIsFile(detail);

  return (
    <div className={`tool-chip state-${part.state}`} data-open={open}>
      <button
        type="button"
        className="tool-chip-line"
        // A chip with no detail has nothing to open, so it must not announce
        // itself as a disclosure. It stays a button for the focus ring and the
        // hover the rest of the family has, and does nothing when pressed.
        aria-expanded={detail ? open : undefined}
        onClick={() => detail && setOpen((v) => !v)}
      >
        {/* The mark is drawn only when there is something behind it, but the
            column it sits in is always there, so a chip with no detail still
            lines its verb up with every other row in the turn. */}
        <span className="tool-chip-chevron" aria-hidden="true">
          {detail ? <Icon name="chevron" size={9} /> : null}
        </span>
        <span className="tool-dot" aria-hidden="true" />
        <span className="tool-verb">{toolVerb(part.name)}</span>
        {detail && <span className="tool-detail">{shortenPath(detail, projectPath)}</span>}
      </button>
      {open && detail && (
        <div className="tool-chip-body">
          <span className="tool-body-name">{part.name}</span>
          <span className="tool-body-detail">{detail}</span>
          {isFile && (
            <button type="button" className="tool-open" onClick={() => openCodePeek(relativeTo(detail, projectPath))}>
              Open file
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Drop the folder prefix so a chip reads `src/game.js`, not the full path. */
export function relativeTo(value: string, root: string | null): string {
  if (!root) return value;
  if (value === root) return '.';
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Relative path, then clipped from the left so the filename always survives. */
export function shortenPath(value: string, root: string | null, max = 48): string {
  const rel = relativeTo(value, root);
  return rel.length <= max ? rel : `…${rel.slice(rel.length - (max - 1))}`;
}
