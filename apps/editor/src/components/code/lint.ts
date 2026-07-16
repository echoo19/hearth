/**
 * `checkScript`-powered lint for the Code panel: a thin `@codemirror/lint`
 * `linter()` extension wrapped around an injected async `check` function so
 * the mapping logic here is testable without the editor store — CodeEditor.tsx
 * wires `check` to `query('checkScript', { source, language })` (see
 * store.ts's silent, error-swallowing `query`).
 *
 * `query` already returns `null` on a failed/offline command and logs the
 * error to the console panel itself, so the `check` function this module is
 * handed always resolves (never rejects) with an empty array in that case —
 * but `computeDiagnostics` also swallows a thrown/rejected `check` locally as
 * defense in depth: a lint pass must never crash typing.
 */
import { forceLinting, linter, type Diagnostic } from '@codemirror/lint';
import { StateEffect, type Extension, type Text } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { ScriptDiagnostic } from '@hearth/core';
import type { ScriptLanguage } from './scriptLanguage';

export type { ScriptDiagnostic };

/** Debounce before a lint pass runs after the last keystroke (@codemirror/lint's own `delay` option). */
const LINT_DELAY_MS = 500;

/**
 * Map a 1-based `ScriptDiagnostic` line to a CM6 line span. `null` maps to
 * the document's first line ("doc start"); out-of-range lines (checkScript
 * ran against stale/foreign source, or the doc shrank after the check
 * started) clamp to the nearest real line rather than throwing.
 */
function lineSpan(doc: Text, line: number | null): { from: number; to: number } {
  const clamped = line === null ? 1 : Math.min(Math.max(line, 1), doc.lines);
  const cmLine = doc.line(clamped);
  return { from: cmLine.from, to: cmLine.to };
}

/** Pure diagnostic mapping, exported for direct testing without mounting an EditorView. */
export async function computeDiagnostics(
  doc: Text,
  check: (source: string) => Promise<ScriptDiagnostic[]>,
  language: ScriptLanguage,
): Promise<Diagnostic[]> {
  let diagnostics: ScriptDiagnostic[];
  try {
    diagnostics = await check(doc.toString());
  } catch {
    return [];
  }
  return diagnostics.map((d) => {
    const { from, to } = lineSpan(doc, d.line);
    return { from, to, severity: d.severity, message: d.message, source: language };
  });
}

/**
 * Out-of-band "re-lint now" signal. The lint plugin only schedules a pass on
 * a DOC change, but a successful save changes what `check` returns without
 * touching the doc: CodePanel's wrapper switches from source mode (syntax
 * only, buffer dirty) to path mode (syntax + require resolution, buffer
 * matches disk). `requestLintRefresh` marks a pass as needed via this effect
 * (picked up by the `needsRefresh` config below) and then forces it to run
 * immediately — `forceLinting` alone is a no-op when no pass is pending.
 */
const lintRefresh = StateEffect.define<null>();

export function requestLintRefresh(view: EditorView): void {
  view.dispatch({ effects: lintRefresh.of(null) });
  forceLinting(view);
}

/**
 * `@codemirror/lint` `linter()` extension backed by `checkScript`. `check`
 * resolves with an empty array for an offline/errored query (see module
 * doc) so this never surfaces diagnostics for a failed check — it just skips
 * marking anything until the next successful pass.
 */
export function makeCheckScriptLinter(
  check: (source: string) => Promise<ScriptDiagnostic[]>,
  language: ScriptLanguage,
): Extension {
  return linter((view: EditorView) => computeDiagnostics(view.state.doc, check, language), {
    delay: LINT_DELAY_MS,
    needsRefresh: (update: ViewUpdate) =>
      update.transactions.some((tr) => tr.effects.some((e) => e.is(lintRefresh))),
  });
}
