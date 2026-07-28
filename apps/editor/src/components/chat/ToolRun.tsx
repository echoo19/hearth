/**
 * A run of machinery rows, folded into one line.
 *
 * One turn routinely fires eight shell rows in a row: two seds, a read, a pwd,
 * a find that exits 1, an rg that exits 1, a git status that exits 128. At
 * ~42px each that is ~340px of transcript carrying almost nothing, several
 * times per turn, and the conversation reads as a wall. Folding a consecutive
 * run into "Ran 7 commands" gives the reader one line to skip past and one
 * click to get all of it back.
 *
 * Three rules keep the fold honest, and each is here because the tidier
 * version of this feature loses something specific:
 *
 *  1. Work still in flight is never folded. A collapsed spinner cannot be told
 *     apart from a hang, and this app has already had one turn stop silently;
 *     hiding the row that is running right now would be shipping that failure
 *     back deliberately.
 *  2. A failure survives the fold. "Ran 7 commands" laid over three non-zero
 *     exits buries the one thing in the run worth reading, so the summary
 *     states how many failed on its face and colours it.
 *  3. Only noise folds. Commands and plain tool calls are noise; a file
 *     change, an approval, a plan, a delegated agent, a skill, an image and a
 *     notice are the substance of the turn, and several of them are things the
 *     reader has to act on. A fold that swallowed an unanswered approval would
 *     be hiding the reason nothing is happening.
 *
 * Prose ends a run for the same reason: two commands, a paragraph, then three
 * more commands is two runs, because the paragraph is the agent saying why the
 * next three happened.
 *
 * The grouping itself is a pure transform over the turn's flat part list, so
 * every rule above is testable without rendering anything.
 */
import React, { useState } from 'react';
import type { ChatCommandPart, ChatPart, ChatToolPart } from '../../types';
import { CommandRow } from './CommandRow';
import { ToolChip } from './ToolChip';
import { Icon } from '../ui';

/**
 * The two kinds quiet enough to fold. Both are a single line that states what
 * ran and how it came out, and both are evidence rather than content.
 *
 * Kept as a union rather than a string set so the renderer below has to handle
 * every member: widening this type without teaching the group to draw the new
 * kind is a type error, not a blank row.
 */
export type GroupablePart = ChatCommandPart | ChatToolPart;

export function isGroupable(part: ChatPart): part is GroupablePart {
  return part.kind === 'command' || part.kind === 'tool';
}

/**
 * One thing the transcript draws: a part on its own, or a run of them folded
 * together. A flat list in, a flat list out, so the caller still maps once.
 */
export type TranscriptItem =
  | { type: 'part'; key: string; index: number; part: ChatPart }
  | { type: 'run'; key: string; startIndex: number; parts: GroupablePart[] };

/**
 * Below this a fold costs more than it saves. "Ran 1 command" is strictly
 * worse than the command it hides: same height, less information, plus a click
 * to undo it.
 */
const RUN_MIN = 2;

/**
 * A stable key for a part. Text, reasoning and notices coalesce in place and
 * have no id of their own, so position is their identity; everything else
 * keeps the id the driver gave it, which survives the parts around it
 * changing.
 */
export function partKey(part: ChatPart, index: number): string {
  return part.kind === 'text' || part.kind === 'reasoning' || part.kind === 'notice' ? `p${index}` : part.id;
}

/**
 * Fold every maximal run of consecutive groupable parts, leaving everything
 * else exactly where it was.
 *
 * A run's key is its FIRST member's id rather than its position or its length,
 * because a run grows a row at a time while the turn streams: keyed by
 * anything that changes as it grows, React would remount the group on every
 * new row and throw away whatever the reader had opened mid-turn.
 */
export function groupTranscriptParts(parts: ChatPart[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: GroupablePart[] = [];
  let start = 0;

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length < RUN_MIN) {
      run.forEach((part, offset) => {
        const index = start + offset;
        items.push({ type: 'part', key: partKey(part, index), index, part });
      });
    } else {
      items.push({ type: 'run', key: `run:${run[0].id}`, startIndex: start, parts: run });
    }
    run = [];
  };

  parts.forEach((part, index) => {
    if (isGroupable(part)) {
      if (run.length === 0) start = index;
      run.push(part);
      return;
    }
    flush();
    items.push({ type: 'part', key: partKey(part, index), index, part });
  });
  flush();

  return items;
}

/** What a folded run says on its face: the count, and how much of it failed. */
export interface RunSummary {
  label: string;
  failed: number;
}

/**
 * The one line the reader gets instead of the run.
 *
 * "Ran 7 commands" only when every row really was a command, because a run
 * that also read three files did not run ten commands and a summary that says
 * so is a small lie the reader cannot check without opening it. A mixed run
 * counts steps instead, which is true of anything in this family.
 */
export function summarizeRun(parts: readonly GroupablePart[]): RunSummary {
  const noun = parts.every((part) => part.kind === 'command') ? 'command' : 'step';
  const plural = parts.length === 1 ? '' : 's';
  return {
    label: `${noun === 'command' ? 'Ran ' : ''}${parts.length} ${noun}${plural}`,
    failed: parts.filter((part) => part.state === 'error').length,
  };
}

/**
 * Whether this run is still happening, and so must stay open.
 *
 * Only a streaming turn can have work in flight, which is what keeps an old
 * transcript foldable: a turn that was interrupted mid-command keeps that row
 * at `running` on disk forever, and treating that as live would leave one run
 * in the history permanently expanded for a command that stopped days ago.
 *
 * Within a streaming turn it is not enough to check the tail. Parallel tool
 * calls open several rows before any of them closes, so a run can sit behind
 * fresh prose with two commands still going.
 */
export function runIsLive(parts: readonly GroupablePart[], streaming: boolean, isTail: boolean): boolean {
  if (!streaming) return false;
  return isTail || parts.some((part) => part.state === 'running');
}

/** Each member drawn exactly as it draws on its own. A fold hides rows, not detail. */
function RunRow({ part }: { part: GroupablePart }) {
  switch (part.kind) {
    case 'command':
      return <CommandRow part={part} />;
    case 'tool':
      return <ToolChip part={part} />;
  }
}

/**
 * The fold. Collapsed by default once the run is over, and never collapsed
 * while it is running: a live run draws its rows with no summary at all, which
 * is exactly what the transcript did before this existed.
 *
 * `open` is deliberately not seeded from `live`. The moment the turn ends the
 * run collapses on its own, which is the whole point of the feature, and a
 * reader who wants it back has the row sitting where the rows were.
 */
export function ToolRunGroup({ parts, live }: { parts: GroupablePart[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = live || open;
  const { label, failed } = summarizeRun(parts);

  return (
    <div className="run-group" data-open={expanded} data-failed={failed > 0}>
      {!live && (
        <button type="button" className="run-summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="run-chevron" aria-hidden="true">
            <Icon name="chevron" size={9} />
          </span>
          {/* The comma belongs to the label's own text node so the whole line
              reads as one sentence to a screen reader ("Ran 7 commands, 2
              failed"), rather than as a label and a stray fragment. */}
          <span className="run-label">
            {failed > 0 ? `${label}, ` : label}
            {/* Stated, not implied by a colour: "2 failed" survives being read
                aloud, greyscaled, or skimmed at arm's length, and the exit
                codes themselves are still one click down. */}
            {failed > 0 && <span className="run-failed">{failed} failed</span>}
          </span>
        </button>
      )}
      {expanded && (
        <div className="run-rows">
          {parts.map((part) => (
            <RunRow key={part.id} part={part} />
          ))}
        </div>
      )}
    </div>
  );
}
