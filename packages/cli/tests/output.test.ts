/**
 * Human output rendering — arrays of objects (sweep findings, failures) must be
 * shown as a readable list, not the opaque "[N items]" placeholder.
 */
import { describe, it, expect } from 'vitest';
import { renderHuman, makeResult } from '../src/output.js';

describe('renderHuman', () => {
  it('renders findings as a bulleted list with severity and summary', () => {
    const result = makeResult('sweepScene', true, {
      scene: 'level_1',
      findings: [
        { kind: 'dead-control', severity: 'issue', summary: 'action "dash" is declared but no script reads it' },
        { kind: 'fade-softlock', severity: 'blocker', summary: 'stuck behind a full-screen fade since frame 40' },
      ],
    });
    const text = renderHuman(result).join('\n');
    expect(text).not.toContain('[2 items]');
    expect(text).toContain('dash');
    expect(text).toContain('fade');
    expect(text).toContain('blocker');
  });

  it('renders failures with their repro string', () => {
    const result = makeResult('sweepScene', true, {
      failures: [
        { policy: 'mash', seed: 0, verdict: 'error', detail: 'boom', repro: 'hearth sweep X --policies mash --seeds 1' },
      ],
    });
    const text = renderHuman(result).join('\n');
    expect(text).not.toContain('[1 items]');
    expect(text).toContain('hearth sweep X');
    expect(text).toContain('boom');
  });

  it('still summarizes plain scalar fields on one line', () => {
    const result = makeResult('sweepScene', true, { scene: 'level_1', runs: 18 });
    const text = renderHuman(result).join('\n');
    expect(text).toContain('scene: level_1');
    expect(text).toContain('runs: 18');
  });
});
