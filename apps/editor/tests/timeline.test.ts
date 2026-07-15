/**
 * Pure logic tests for the Agent panel's activity timeline: `entryToRow`
 * (JournalEntry -> row model), `commandIcon`, and `relativeTime`. No DOM, no
 * store — mirrors the style of useAgentSocket.test.ts's pure-reducer tests.
 */
import { describe, expect, it } from 'vitest';
import { commandIcon, entryToRow, humanizeLabel, relativeTime } from '../src/components/agent/Timeline';
import type { JournalEntry } from '../src/types';

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    seq: 1,
    ts: '2026-07-03T12:00:00.000Z',
    source: 'cli',
    command: 'createEntity',
    summary: 'createEntity Player',
    ok: true,
    ...overrides,
  };
}

describe('entryToRow', () => {
  it('maps a plain successful command with no detail', () => {
    const row = entryToRow(entry(), Date.parse('2026-07-03T12:00:00.000Z'));
    expect(row.status).toBe('ok');
    expect(row.label).toBe('createEntity Player');
    expect(row.icon).toBe('entity');
    expect(row.meta).toBeUndefined();
  });

  it('falls back to the command name when summary is empty', () => {
    const row = entryToRow(entry({ summary: '' }), Date.parse('2026-07-03T12:00:00.000Z'));
    expect(row.label).toBe('createEntity');
  });

  it('runPlaytest: all assertions passed -> "N/N assertions"', () => {
    const row = entryToRow(
      entry({
        command: 'runPlaytest',
        summary: 'runPlaytest jump-test',
        detail: { passed: true, assertions: 3, failures: 0 },
      }),
      Date.parse('2026-07-03T12:00:00.000Z'),
    );
    expect(row.meta).toBe('3/3 assertions');
    expect(row.status).toBe('ok');
    expect(row.icon).toBe('play');
  });

  it('runPlaytest: some failures -> "N failed"', () => {
    const row = entryToRow(
      entry({
        command: 'runPlaytest',
        summary: 'runPlaytest jump-test',
        detail: { passed: false, assertions: 3, failures: 2 },
      }),
      Date.parse('2026-07-03T12:00:00.000Z'),
    );
    expect(row.meta).toBe('2 failed');
  });

  it('validateProject: "0 errors, 1 warning" (pluralization keyed off each count)', () => {
    const row = entryToRow(
      entry({
        command: 'validateProject',
        summary: 'validateProject',
        detail: { errors: 0, warnings: 1 },
      }),
      Date.parse('2026-07-03T12:00:00.000Z'),
    );
    expect(row.meta).toBe('0 errors, 1 warning');
    expect(row.icon).toBe('grid');
  });

  it('validateProject: plural errors, no warnings', () => {
    const row = entryToRow(
      entry({
        command: 'validateProject',
        summary: 'validateProject',
        detail: { errors: 2, warnings: 0 },
      }),
      Date.parse('2026-07-03T12:00:00.000Z'),
    );
    expect(row.meta).toBe('2 errors, 0 warnings');
  });

  it('error rows show the error code as meta, regardless of any detail', () => {
    const row = entryToRow(
      entry({
        ok: false,
        error: 'NOT_FOUND',
        summary: 'deleteEntity Player',
        command: 'deleteEntity',
      }),
      Date.parse('2026-07-03T12:00:00.000Z'),
    );
    expect(row.status).toBe('error');
    expect(row.meta).toBe('NOT_FOUND');
  });

  it('is defensive about malformed/absent detail — never throws, omits meta', () => {
    expect(() =>
      entryToRow(entry({ command: 'runPlaytest', detail: undefined }), Date.now()),
    ).not.toThrow();
    expect(entryToRow(entry({ command: 'runPlaytest', detail: undefined }), Date.now()).meta).toBeUndefined();

    expect(() =>
      entryToRow(
        entry({ command: 'runPlaytest', detail: { passed: true } as unknown as Record<string, unknown> }),
        Date.now(),
      ),
    ).not.toThrow();
    expect(
      entryToRow(
        entry({ command: 'runPlaytest', detail: { passed: true } as unknown as Record<string, unknown> }),
        Date.now(),
      ).meta,
    ).toBeUndefined();

    expect(() =>
      entryToRow(
        entry({ command: 'validateProject', detail: { errors: 'oops' } as unknown as Record<string, unknown> }),
        Date.now(),
      ),
    ).not.toThrow();
  });
});

describe('humanizeLabel', () => {
  it('setComponentProperty: entity + property from detail, not the raw scene-only summary', () => {
    const label = humanizeLabel(
      entry({
        command: 'setComponentProperty',
        summary: 'setComponentProperty mainScene',
        detail: { scene: 'mainScene', entity: 'Player', property: 'Transform.position' },
      }),
    );
    expect(label).toBe('setComponentProperty Player.Transform.position');
  });

  it('setProperties: a single changed key reads the same as setComponentProperty', () => {
    const label = humanizeLabel(
      entry({
        command: 'setProperties',
        summary: 'setProperties mainScene',
        detail: { scene: 'mainScene', entity: 'Player', properties: ['Transform.position'] },
      }),
    );
    expect(label).toBe('setProperties Player.Transform.position');
  });

  it('setProperties: multiple changed keys collapse to a count, staying one line', () => {
    const label = humanizeLabel(
      entry({
        command: 'setProperties',
        summary: 'setProperties mainScene',
        detail: {
          scene: 'mainScene',
          entity: 'Player',
          properties: ['Transform.position.x', 'Transform.position.y'],
        },
      }),
    );
    expect(label).toBe('setProperties Player (2 properties)');
  });

  it('falls back to summary when detail has no entity (e.g. renameEntity today)', () => {
    const label = humanizeLabel(entry({ command: 'renameEntity', summary: 'renameEntity mainScene' }));
    expect(label).toBe('renameEntity mainScene');
  });

  it('is defensive about a malformed detail bag — never throws, falls back to summary', () => {
    expect(() =>
      humanizeLabel(
        entry({
          command: 'setComponentProperty',
          detail: { entity: 42, property: 'Transform.position' } as unknown as Record<string, unknown>,
        }),
      ),
    ).not.toThrow();
    expect(
      humanizeLabel(
        entry({
          command: 'setComponentProperty',
          summary: 'setComponentProperty mainScene',
          detail: { entity: 42 } as unknown as Record<string, unknown>,
        }),
      ),
    ).toBe('setComponentProperty mainScene');
  });
});

describe('entryToRow uses the humanized label', () => {
  it('routes through humanizeLabel for the row label', () => {
    const row = entryToRow(
      entry({
        command: 'setComponentProperty',
        summary: 'setComponentProperty mainScene',
        detail: { scene: 'mainScene', entity: 'Player', property: 'Transform.position' },
      }),
      Date.parse('2026-07-03T12:00:00.000Z'),
    );
    expect(row.label).toBe('setComponentProperty Player.Transform.position');
  });
});

describe('commandIcon', () => {
  it('maps entity/component commands to the entity glyph', () => {
    expect(commandIcon('createEntity')).toBe('entity');
    expect(commandIcon('setComponentProperty')).toBe('entity');
  });

  it('maps scene commands to the camera glyph', () => {
    expect(commandIcon('createScene')).toBe('camera');
    expect(commandIcon('setInitialScene')).toBe('camera');
  });

  it('maps asset commands to the image glyph', () => {
    expect(commandIcon('importAsset')).toBe('image');
    expect(commandIcon('sliceSpritesheet')).toBe('image');
  });

  it('maps script commands to the script glyph', () => {
    expect(commandIcon('createScript')).toBe('script');
    expect(commandIcon('attachScript')).toBe('script');
  });

  it('maps playtest commands to the play glyph', () => {
    expect(commandIcon('createPlaytest')).toBe('play');
    expect(commandIcon('runPlaytest')).toBe('play');
    expect(commandIcon('runScene')).toBe('play');
  });

  it('maps settings/validate commands to the grid glyph', () => {
    expect(commandIcon('updateSettings')).toBe('grid');
    expect(commandIcon('setInputMapping')).toBe('grid');
    expect(commandIcon('validateProject')).toBe('grid');
  });

  it('maps history/session commands to the duplicate (snapshot) glyph', () => {
    expect(commandIcon('undo')).toBe('duplicate');
    expect(commandIcon('redo')).toBe('duplicate');
    expect(commandIcon('revertProject')).toBe('duplicate');
  });

  it('falls back to entity for unknown commands', () => {
    expect(commandIcon('someFutureCommand')).toBe('entity');
  });
});

describe('relativeTime', () => {
  const base = Date.parse('2026-07-03T12:00:00.000Z');

  it('collapses sub-5s deltas to "just now"', () => {
    expect(relativeTime('2026-07-03T12:00:00.000Z', base)).toBe('just now');
    expect(relativeTime('2026-07-03T11:59:58.000Z', base)).toBe('just now');
  });

  it('renders seconds', () => {
    expect(relativeTime('2026-07-03T11:59:30.000Z', base)).toBe('30s ago');
  });

  it('renders minutes', () => {
    expect(relativeTime('2026-07-03T11:58:00.000Z', base)).toBe('2m ago');
  });

  it('renders hours', () => {
    expect(relativeTime('2026-07-03T09:00:00.000Z', base)).toBe('3h ago');
  });

  it('renders days', () => {
    expect(relativeTime('2026-07-01T12:00:00.000Z', base)).toBe('2d ago');
  });

  it('treats a future timestamp (clock skew) as "just now" rather than negative', () => {
    expect(relativeTime('2026-07-03T12:00:05.000Z', base)).toBe('just now');
  });

  it('returns an empty string for an unparsable timestamp rather than throwing', () => {
    expect(relativeTime('not-a-date', base)).toBe('');
  });
});
