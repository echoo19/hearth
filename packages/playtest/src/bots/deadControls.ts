/**
 * Dead-control detection — a declared input that nothing uses.
 *
 * Two confidence levels, deliberately worded apart:
 *   - definitive (issue): the name appears in no script source at all, so no code
 *     path could ever read it. A dangling control on the input map.
 *   - observational (note): the name is referenced in a script but was never read
 *     during this sweep — maybe it's only read in a state the bots didn't reach, so
 *     the wording never overclaims.
 *
 * The source scan is a substring match against concatenated script text — cheap
 * and good enough to tell "referenced somewhere" from "referenced nowhere". Pure.
 */
import type { Finding } from './types.js';

export interface DeadControlInput {
  actions: string[];
  axes: string[];
  /** Input names read at runtime across the whole sweep (union of every run). */
  read: Set<string>;
  /** Concatenated source of every script the swept scenes reference. */
  sourceText: string;
}

export function deadControlFindings(input: DeadControlInput): Finding[] {
  const findings: Finding[] = [];
  const declared = [
    ...input.actions.map((name) => ({ name, kind: 'action' as const })),
    ...input.axes.map((name) => ({ name, kind: 'axis' as const })),
  ];

  for (const { name, kind } of declared) {
    if (input.read.has(name)) continue; // exercised — nothing to say
    const referenced = mentionsInput(input.sourceText, name);
    if (!referenced) {
      findings.push({
        kind: 'dead-control',
        severity: 'issue',
        summary: `${kind} "${name}" is declared but no script reads it`,
        detail: `nothing calls ctx.input for "${name}" — remove it from the input map or wire it up`,
        evidence: { input: name, control: kind, confidence: 'no-source-reference' },
      });
    } else {
      findings.push({
        kind: 'dead-control',
        severity: 'note',
        summary: `${kind} "${name}" is referenced but was never exercised in this sweep`,
        detail: `a script reads "${name}" but the bots never triggered that path — it may only apply in a state they didn't reach`,
        evidence: { input: name, control: kind, confidence: 'never-read' },
      });
    }
  }
  return findings;
}

/** Whether concatenated source references an input name (as a quoted string token). */
export function mentionsInput(sourceText: string, name: string): boolean {
  // Match the name inside quotes — how ctx.input.isDown('name') / axis("name") reads.
  return sourceText.includes(`'${name}'`) || sourceText.includes(`"${name}"`) || sourceText.includes(`\`${name}\``);
}
