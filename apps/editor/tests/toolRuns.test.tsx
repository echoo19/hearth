// @vitest-environment jsdom
/**
 * Folding a run of machinery rows into one line.
 *
 * A turn that shells out eight times in a row prints ~340px of transcript
 * saying almost nothing, several times over, and the conversation stops being
 * readable. Folding fixes that, and the way folding usually goes wrong is by
 * being too tidy: it hides the command that is still running (a collapsed
 * spinner and a hang look identical), or it reports "Ran 7 commands" over
 * three non-zero exits, or it swallows an approval that was blocking the whole
 * turn.
 *
 * So what is pinned here is mostly the REFUSALS. What folds, what never folds,
 * what a fold has to keep saying out loud, and the fact that a run of one is
 * left exactly as it was.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  groupTranscriptParts,
  isGroupable,
  runIsLive,
  summarizeRun,
  type GroupablePart,
  type TranscriptItem,
} from '../src/components/chat/ToolRun';
import { MessageList } from '../src/components/chat/MessageList';
import { useApp } from '../src/store';
import type {
  ChatCommandPart,
  ChatPart,
  ChatToolPart,
  ToolState,
} from '../src/types';

function cmd(id: string, title: string, state: ToolState = 'ok', exitCode?: number): ChatCommandPart {
  return { kind: 'command', id, title, output: '', state, exitCode };
}

function tool(id: string, name: string, state: ToolState = 'ok'): ChatToolPart {
  return { kind: 'tool', id, name, state };
}

const prose = (text: string): ChatPart => ({ kind: 'text', text });

/** The shape of the result, in a form a failing assertion prints readably. */
function shape(items: TranscriptItem[]): string[] {
  return items.map((item) => (item.type === 'run' ? `run(${item.parts.map((p) => p.id).join(',')})` : item.part.kind));
}

describe('what folds', () => {
  it('leaves an empty turn empty', () => {
    expect(groupTranscriptParts([])).toEqual([]);
  });

  it('leaves a run of one exactly as it was', () => {
    // A summary row reading "Ran 1 command" is the same height as the command,
    // says less, and costs a click to undo.
    const items = groupTranscriptParts([prose('here goes'), cmd('c1', 'npm test')]);
    expect(shape(items)).toEqual(['text', 'command']);
    expect(items[1]).toMatchObject({ type: 'part', key: 'c1', index: 1 });
  });

  it('folds a consecutive run of commands and tool calls together', () => {
    const items = groupTranscriptParts([
      cmd('c1', 'sed -n 1,20p a.ts'),
      cmd('c2', 'pwd'),
      tool('t1', 'Read'),
      cmd('c3', 'git status'),
    ]);
    expect(shape(items)).toEqual(['run(c1,c2,t1,c3)']);
    expect(items[0]).toMatchObject({ type: 'run', startIndex: 0 });
  });

  it('ends a run at prose, because the paragraph is why the next ones happened', () => {
    const items = groupTranscriptParts([
      cmd('c1', 'ls'),
      cmd('c2', 'pwd'),
      prose('the folder is empty, so I will scaffold it'),
      cmd('c3', 'mkdir src'),
      cmd('c4', 'npm init -y'),
      cmd('c5', 'npm i'),
    ]);
    expect(shape(items)).toEqual(['run(c1,c2)', 'text', 'run(c3,c4,c5)']);
    expect(items[2]).toMatchObject({ startIndex: 3 });
  });

  it('never swallows the substance of a turn', () => {
    // Every one of these is either something the reader has to act on, or the
    // record of a real change. A fold that hid an unanswered approval would be
    // hiding the reason nothing is happening.
    const substance: ChatPart[] = [
      { kind: 'file-change', id: 'f1', files: [{ path: 'src/game.js', kind: 'edit' }] },
      { kind: 'approval', id: 'a1', approvalKind: 'command', title: 'rm -rf', detail: '', decision: null },
      { kind: 'plan', id: 'pl1', text: '1. do it' },
      { kind: 'subagent', id: 's1', title: 'explore', text: '', state: 'ok' },
      { kind: 'skill', id: 'sk1', name: 'impeccable', state: 'ok' },
      { kind: 'image', id: 'i1', path: 'shot.png' },
      { kind: 'notice', text: 'the turn was interrupted' },
      { kind: 'reasoning', text: 'thinking' },
    ];
    for (const part of substance) {
      expect(isGroupable(part)).toBe(false);
      const items = groupTranscriptParts([cmd('c1', 'ls'), part, cmd('c2', 'pwd')]);
      expect(shape(items)).toEqual(['command', part.kind, 'command']);
    }
  });

  it('keeps a run keyed by its first row, so it survives growing mid-turn', () => {
    // Keyed by anything that changes as the run grows (its length, its last
    // id) React would remount the group on every new row and throw away
    // whatever the reader had opened while the turn was still running.
    const growing = [cmd('c1', 'ls'), cmd('c2', 'pwd')];
    const first = groupTranscriptParts(growing)[0].key;
    growing.push(cmd('c3', 'git status'));
    expect(groupTranscriptParts(growing)[0].key).toBe(first);
    expect(first).toBe('run:c1');
  });
});

describe('what the folded line says', () => {
  it('counts commands when they really were all commands', () => {
    expect(summarizeRun([cmd('c1', 'ls'), cmd('c2', 'pwd')])).toEqual({ label: 'Ran 2 commands', failed: 0 });
  });

  it('counts steps once anything else is in the run', () => {
    // "Ran 3 commands" over two commands and a file read is a small lie the
    // reader cannot check without opening the fold.
    expect(summarizeRun([cmd('c1', 'ls'), tool('t1', 'Read'), cmd('c2', 'pwd')]).label).toBe('3 steps');
  });

  it('reports every failure in the run', () => {
    const run: GroupablePart[] = [
      cmd('c1', 'find .', 'error', 1),
      cmd('c2', 'ls'),
      cmd('c3', 'git status', 'error', 128),
      tool('t1', 'Read', 'error'),
    ];
    expect(summarizeRun(run)).toEqual({ label: '4 steps', failed: 3 });
  });
});

describe('what counts as still happening', () => {
  const run = [cmd('c1', 'ls'), cmd('c2', 'npm test', 'running')];

  it('is live at the tail of a streaming turn', () => {
    expect(runIsLive(run, true, true)).toBe(true);
  });

  it('is live behind fresh prose while a row is still running', () => {
    // Parallel tool calls open several rows before any of them closes, so the
    // tail alone is not enough to tell whether a run is finished.
    expect(runIsLive(run, true, false)).toBe(true);
  });

  it('is not live when nothing in it is running', () => {
    expect(runIsLive([cmd('c1', 'ls'), cmd('c2', 'pwd')], true, false)).toBe(false);
  });

  it('is never live on a finished turn, however the rows were left', () => {
    // A turn interrupted mid-command keeps that row at `running` on disk
    // forever. Reading that as live would leave one run in the history
    // permanently open for a command that stopped days ago.
    expect(runIsLive(run, false, true)).toBe(false);
  });
});

// --- The transcript itself --------------------------------------------------

function showTurn(parts: ChatPart[], streaming = false): void {
  useApp.setState({
    messages: [{ id: 'm1', role: 'agent', parts, streaming }],
    queued: [],
  } as Partial<ReturnType<typeof useApp.getState>>);
  render(<MessageList />);
}

const rows = () => document.querySelectorAll('.cmd-row, .tool-chip').length;

beforeEach(() => useApp.setState({ messages: [], queued: [] } as Partial<ReturnType<typeof useApp.getState>>));
afterEach(cleanup);

describe('the transcript', () => {
  it('folds a finished run, and gives all of it back on a click', () => {
    showTurn([cmd('c1', 'sed -n 1,20p a.ts'), cmd('c2', 'pwd'), cmd('c3', 'git status')]);

    const summary = screen.getByRole('button', { name: 'Ran 3 commands' });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(rows()).toBe(0);

    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(rows()).toBe(3);
    expect(screen.getByText('git status')).toBeTruthy();

    fireEvent.click(summary);
    expect(rows()).toBe(0);
  });

  it('says how much of it failed without being opened', () => {
    showTurn([cmd('c1', 'find .', 'error', 1), cmd('c2', 'ls'), cmd('c3', 'git status', 'error', 128)]);
    expect(screen.getByRole('button', { name: 'Ran 3 commands, 2 failed' })).toBeTruthy();
    expect(document.querySelector('.run-group')?.getAttribute('data-failed')).toBe('true');
  });

  it('never folds work that is still in flight', () => {
    // A collapsed spinner cannot be told apart from a hang.
    showTurn([cmd('c1', 'npm i'), cmd('c2', 'npm test', 'running')], true);
    expect(document.querySelector('.run-summary')).toBeNull();
    expect(rows()).toBe(2);
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('folds the finished run above the live one in the same turn', () => {
    showTurn(
      [
        cmd('c1', 'ls'),
        cmd('c2', 'pwd'),
        prose('nothing there, scaffolding it'),
        cmd('c3', 'npm init -y'),
        cmd('c4', 'npm i', 'running'),
      ],
      true,
    );
    // One fold (the run that is over) and one open run (the one still going).
    expect(screen.getByRole('button', { name: 'Ran 2 commands' })).toBeTruthy();
    expect(rows()).toBe(2);
    expect(screen.getByText('npm i')).toBeTruthy();
  });

  it('leaves a lone command as a command row', () => {
    showTurn([cmd('c1', 'npm test')]);
    expect(document.querySelector('.run-summary')).toBeNull();
    expect(rows()).toBe(1);
  });
});
