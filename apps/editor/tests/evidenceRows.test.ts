/**
 * The evidence feed's folding rules: a flat `EvidenceEvent` stream in, one
 * card per sweep out. Pure, so no store, socket, or DOM is involved.
 */
import { describe, expect, it } from 'vitest';
import {
  foldEvidence,
  railSummary,
  verdictLabel,
  verdictTone,
  type SweepRow,
} from '../src/components/evidence/evidenceRows';
import type { EvidenceEvent } from '../src/types';

let seq = 0;
/**
 * Build one journal line. Fields are loose on purpose: the fold must survive a
 * partial event (a sweep that only got as far as `sweep-started`) and an event
 * kind this build has never seen, neither of which the closed
 * `EvidenceEvent` union can express.
 */
function event(kind: string, fields: Record<string, unknown> = {}, ts = '2026-07-25T10:00:00.000Z'): EvidenceEvent {
  return { kind, seq: ++seq, ts, ...fields } as unknown as EvidenceEvent;
}

function sweepRows(rows: ReturnType<typeof foldEvidence>): SweepRow[] {
  return rows.filter((row): row is SweepRow => row.kind === 'sweep');
}

describe('verdictTone', () => {
  it('maps the known verdicts onto the three semantic tones', () => {
    expect(verdictTone('ran-clean')).toBe('ok');
    expect(verdictTone('stuck')).toBe('warn');
    expect(verdictTone('error')).toBe('err');
  });

  it('treats an unknown verdict as neutral rather than guessing', () => {
    expect(verdictTone('something-new')).toBe('neutral');
  });
});

describe('verdictLabel', () => {
  it('reads hyphenated ids as words', () => {
    expect(verdictLabel('ran-clean')).toBe('ran clean');
    expect(verdictLabel('stuck')).toBe('stuck');
  });
});

describe('foldEvidence', () => {
  it('returns nothing for an empty journal', () => {
    expect(foldEvidence([])).toEqual([]);
  });

  it('shows a sweep as soon as it starts, before any run finishes', () => {
    const rows = sweepRows(foldEvidence([event('sweep-started', { sweepId: '0001', target: 'index.html' })]));
    expect(rows).toHaveLength(1);
    expect(rows[0].running).toBe(true);
    expect(rows[0].target).toBe('index.html');
    expect(rows[0].counts).toEqual([]);
  });

  it('accumulates in-progress run verdicts onto the sweep', () => {
    const rows = sweepRows(
      foldEvidence([
        event('sweep-started', { sweepId: '0001' }),
        event('run-finished', { sweepId: '0001', verdict: 'ran-clean' }),
        event('run-finished', { sweepId: '0001', verdict: 'ran-clean' }),
        event('run-finished', { sweepId: '0001', verdict: 'stuck' }),
      ]),
    );
    expect(rows[0].runs).toBe(3);
    expect(rows[0].running).toBe(true);
    expect(rows[0].counts).toEqual([
      { verdict: 'ran-clean', count: 2, tone: 'ok' },
      { verdict: 'stuck', count: 1, tone: 'warn' },
    ]);
  });

  it('lets the finished report override the accumulated counts', () => {
    const rows = sweepRows(
      foldEvidence([
        event('sweep-started', { sweepId: '0001' }),
        event('run-finished', { sweepId: '0001', verdict: 'ran-clean' }),
        event('sweep-finished', {
          sweepId: '0001',
          verdicts: { 'ran-clean': 4, error: 1 },
          findings: [{ kind: 'crash', detail: 'TypeError in update()' }],
          reportPath: 'sweeps/0001/report.json',
        }),
      ]),
    );
    expect(rows[0].running).toBe(false);
    expect(rows[0].runs).toBe(5);
    expect(rows[0].counts.map((c) => c.verdict)).toEqual(['ran-clean', 'error']);
    expect(rows[0].findings).toEqual([{ kind: 'crash', detail: 'TypeError in update()' }]);
  });

  it('attaches shots to their sweep, and keeps orphan shots as notes', () => {
    const rows = foldEvidence([
      event('sweep-started', { sweepId: '0001' }),
      event('shot', { sweepId: '0001', path: 'sweeps/0001/shots/a.png' }),
      event('shot', { path: 'loose.png', caption: 'a loose frame' }),
    ]);
    const sweep = sweepRows(rows)[0];
    expect(sweep.shots).toEqual(['sweeps/0001/shots/a.png']);
    expect(rows.some((row) => row.kind === 'note' && row.text === 'a loose frame')).toBe(true);
  });

  it('keeps notes, and does not drop an event kind it has never seen', () => {
    const rows = foldEvidence([
      event('note', { text: 'probe attached' }),
      event('some-future-kind', {}),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.kind === 'note' && row.text === 'probe attached')).toBe(true);
    expect(rows.some((row) => row.kind === 'note' && row.text === 'some-future-kind')).toBe(true);
  });

  it('orders newest first', () => {
    const rows = foldEvidence([
      event('sweep-started', { sweepId: '0001' }, '2026-07-25T10:00:00.000Z'),
      event('sweep-started', { sweepId: '0002' }, '2026-07-25T11:00:00.000Z'),
    ]);
    expect(sweepRows(rows).map((row) => row.sweepId)).toEqual(['0002', '0001']);
  });
});

describe('railSummary', () => {
  it('says so plainly when nothing has been played', () => {
    expect(railSummary(foldEvidence([]))).toBe('No playtests yet');
  });

  it('reports a sweep still playing', () => {
    expect(railSummary(foldEvidence([event('sweep-started', { sweepId: '0001' })]))).toBe('Playing…');
  });

  it('summarises the newest sweep by verdict', () => {
    const rows = foldEvidence([
      event('sweep-finished', { sweepId: '0001', verdicts: { 'ran-clean': 3, stuck: 1 } }),
    ]);
    expect(railSummary(rows)).toBe('3 ran clean · 1 stuck');
  });
});
