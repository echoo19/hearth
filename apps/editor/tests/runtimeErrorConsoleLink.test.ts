/**
 * Task 7: a structured RuntimeError recorded via recordRuntimeError() also
 * lands in the Console as a plain-language, entity-first message, with a
 * `link` to the offending script when one is known — the click target for
 * ConsolePanel's `.console-link` button (openScriptAt). Pure store-level
 * coverage: no project needs to be open for recordRuntimeError/log.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store';
import type { RuntimeErrorEntry } from '../src/runtimeBridge';

beforeEach(() => {
  useEditor.setState({ consoleEntries: [], runtimeErrors: [], consoleUnread: 0, consoleOpen: false });
});

describe('recordRuntimeError -> Console entry (Task 7)', () => {
  it('script + line: plain-language "who hit an error in path:line — message" and a link', () => {
    const error: RuntimeErrorEntry = {
      frame: 10,
      message: 'attempt to index a nil value',
      entity: 'Enemy',
      script: 'scripts/enemy.lua',
      line: 12,
    };

    useEditor.getState().recordRuntimeError(error);

    const entries = useEditor.getState().consoleEntries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      source: 'runtime',
      message: 'Enemy hit an error in scripts/enemy.lua:12 — attempt to index a nil value',
      link: { path: 'scripts/enemy.lua', line: 12 },
    });
  });

  it('script without a line: link.line is null (click still opens the file, at the top)', () => {
    const error: RuntimeErrorEntry = {
      frame: 1,
      message: 'boom',
      entity: 'Player',
      script: 'scripts/player.lua',
    };

    useEditor.getState().recordRuntimeError(error);

    const entry = useEditor.getState().consoleEntries[0];
    expect(entry.link).toEqual({ path: 'scripts/player.lua', line: null });
    expect(entry.message).toBe('Player hit an error in scripts/player.lua — boom');
  });

  it('no script at all: no link', () => {
    const error: RuntimeErrorEntry = { frame: 1, message: 'boom' };

    useEditor.getState().recordRuntimeError(error);

    const entry = useEditor.getState().consoleEntries[0];
    expect(entry.link).toBeUndefined();
    expect(entry.message).toBe('Script hit an error — boom');
  });

  it('falls back to "Script" when no entity name is given', () => {
    const error: RuntimeErrorEntry = { frame: 1, message: 'boom', script: 'scripts/a.lua', line: 3 };

    useEditor.getState().recordRuntimeError(error);

    expect(useEditor.getState().consoleEntries[0].message).toBe('Script hit an error in scripts/a.lua:3 — boom');
  });

  it('still records the raw error into runtimeErrors (existing Task-9 behavior, unchanged)', () => {
    const error: RuntimeErrorEntry = { frame: 3, message: 'x' };
    useEditor.getState().recordRuntimeError(error);
    expect(useEditor.getState().runtimeErrors).toEqual([error]);
  });

  it('a plain log() call without a link stays unlinked (existing call sites unaffected)', () => {
    useEditor.getState().log('info', 'command', 'Checkpoint saved.');
    expect(useEditor.getState().consoleEntries[0].link).toBeUndefined();
  });

  it('log() accepts an explicit link and stores it verbatim', () => {
    useEditor.getState().log('error', 'runtime', 'Hot-reload failed: scripts/x.lua:7 — unexpected symbol', {
      path: 'scripts/x.lua',
      line: 7,
    });
    expect(useEditor.getState().consoleEntries[0].link).toEqual({ path: 'scripts/x.lua', line: 7 });
  });

  // L-061 (CONSOLE-CHANGES-3): a load-time compile failure carries the line
  // inline in the message but leaves error.line null; recover it so the link
  // jumps to the exact line like the reload path does.
  it('load-time failure: recovers the line from the "<script>:<line>" in the message', () => {
    const error: RuntimeErrorEntry = {
      frame: 0,
      message:
        "Failed to load script scripts/shake-toggle.lua: scripts/shake-toggle.lua:14: 'end' expected (to close 'function' at line 6) near <eof>",
      script: 'scripts/shake-toggle.lua',
      line: null,
    };

    useEditor.getState().recordRuntimeError(error);

    const entry = useEditor.getState().consoleEntries[0];
    expect(entry.link).toEqual({ path: 'scripts/shake-toggle.lua', line: 14 });
    // The message also reflects the recovered line ("in <script>:14 —").
    expect(entry.message).toContain('scripts/shake-toggle.lua:14 —');
  });

  it('load-time failure with no line anywhere in the message: link.line stays null', () => {
    const error: RuntimeErrorEntry = {
      frame: 0,
      message: 'Failed to load script scripts/a.lua: some opaque failure',
      script: 'scripts/a.lua',
      line: null,
    };

    useEditor.getState().recordRuntimeError(error);

    expect(useEditor.getState().consoleEntries[0].link).toEqual({ path: 'scripts/a.lua', line: null });
  });

  // L-062 (CONSOLE-CHANGES-4): a hot-reload compile failure is bridged here by
  // the runtime (recordError phase:'reload') AND logged by applyReload — so
  // recordRuntimeError must NOT also log it, or every hot-reload error doubles
  // in the Console. It still records into runtimeErrors.
  it('phase "reload": recorded into runtimeErrors but NOT logged again (applyReload owns that line)', () => {
    const error: RuntimeErrorEntry = {
      frame: 5,
      message: "'end' expected",
      script: 'scripts/resume-button.lua',
      line: 17,
      phase: 'reload',
    };

    useEditor.getState().recordRuntimeError(error);

    expect(useEditor.getState().runtimeErrors).toEqual([error]);
    expect(useEditor.getState().consoleEntries).toHaveLength(0);
  });

  it('non-reload phase still logs (a genuine runtime error during play is unaffected)', () => {
    const error: RuntimeErrorEntry = {
      frame: 5,
      message: 'boom',
      script: 'scripts/a.lua',
      line: 3,
      phase: 'onUpdate',
    };

    useEditor.getState().recordRuntimeError(error);

    expect(useEditor.getState().consoleEntries).toHaveLength(1);
  });
});
