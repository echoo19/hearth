/**
 * checkScript-powered lint: the pure diagnostic-mapping function
 * (`computeDiagnostics`) is exercised directly against synthetic CM `Text`
 * docs and a mock `check`, without mounting a full EditorView — matching how
 * CodeEditor.tsx wires `check` to the store's silent `query('checkScript', ...)`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Text } from '@codemirror/state';
import { computeDiagnostics, makeCheckScriptLinter, type ScriptDiagnostic } from '../src/components/code/lint';

const THREE_LINES = Text.of(['local x = 1', 'local y = 2', 'return x + y']);

describe('computeDiagnostics', () => {
  it('maps a 1-based diagnostic line to the matching CM line span', async () => {
    const check = vi.fn(async (): Promise<ScriptDiagnostic[]> => [{ line: 2, message: 'unexpected symbol', severity: 'error' }]);
    const [diag] = await computeDiagnostics(THREE_LINES, check, 'lua');
    const expected = THREE_LINES.line(2);
    expect(diag.from).toBe(expected.from);
    expect(diag.to).toBe(expected.to);
    expect(diag.message).toBe('unexpected symbol');
    expect(diag.severity).toBe('error');
  });

  it('preserves severity for warnings', async () => {
    const check = vi.fn(async (): Promise<ScriptDiagnostic[]> => [{ line: 1, message: 'unused var', severity: 'warning' }]);
    const [diag] = await computeDiagnostics(THREE_LINES, check, 'js');
    expect(diag.severity).toBe('warning');
  });

  it('maps line: null to the document start (line 1)', async () => {
    const check = vi.fn(async (): Promise<ScriptDiagnostic[]> => [{ line: null, message: 'parse error', severity: 'error' }]);
    const [diag] = await computeDiagnostics(THREE_LINES, check, 'lua');
    const line1 = THREE_LINES.line(1);
    expect(diag.from).toBe(line1.from);
    expect(diag.to).toBe(line1.to);
  });

  it('clamps a line past the end of the document to the last line', async () => {
    const check = vi.fn(async (): Promise<ScriptDiagnostic[]> => [{ line: 999, message: 'oops', severity: 'error' }]);
    const [diag] = await computeDiagnostics(THREE_LINES, check, 'lua');
    const lastLine = THREE_LINES.line(THREE_LINES.lines);
    expect(diag.from).toBe(lastLine.from);
    expect(diag.to).toBe(lastLine.to);
  });

  it('clamps a zero or negative line to the first line', async () => {
    const check = vi.fn(async (): Promise<ScriptDiagnostic[]> => [{ line: 0, message: 'oops', severity: 'error' }]);
    const [diag] = await computeDiagnostics(THREE_LINES, check, 'lua');
    const line1 = THREE_LINES.line(1);
    expect(diag.from).toBe(line1.from);
    expect(diag.to).toBe(line1.to);
  });

  it('returns no diagnostics when check resolves empty (valid script)', async () => {
    const check = vi.fn(async (): Promise<ScriptDiagnostic[]> => []);
    expect(await computeDiagnostics(THREE_LINES, check, 'lua')).toEqual([]);
  });

  it('never throws when check rejects (offline/error) — resolves to no diagnostics', async () => {
    const check = vi.fn(async (): Promise<ScriptDiagnostic[]> => {
      throw new Error('network down');
    });
    await expect(computeDiagnostics(THREE_LINES, check, 'lua')).resolves.toEqual([]);
  });

  it('passes the source language through as the diagnostic source tag', async () => {
    const check = vi.fn(async (): Promise<ScriptDiagnostic[]> => [{ line: 1, message: 'x', severity: 'error' }]);
    const [diag] = await computeDiagnostics(THREE_LINES, check, 'js');
    expect(diag.source).toBe('js');
  });
});

describe('makeCheckScriptLinter', () => {
  it('builds a CodeMirror extension without throwing', () => {
    const check = vi.fn(async (): Promise<ScriptDiagnostic[]> => []);
    expect(() => makeCheckScriptLinter(check, 'lua')).not.toThrow();
  });
});
