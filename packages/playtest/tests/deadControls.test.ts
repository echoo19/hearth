/**
 * Dead-control detection — a declared input nothing uses. Two confidence levels:
 * a name that appears in no script at all (definitive) vs one that is referenced
 * but was never exercised by the bots this sweep (observational). Pure function.
 */
import { describe, it, expect } from 'vitest';
import { deadControlFindings } from '@hearth/playtest';

describe('deadControlFindings', () => {
  it('flags a declared action that no script references as a definite issue', () => {
    const findings = deadControlFindings({
      actions: ['jump', 'crouch'],
      axes: [],
      read: new Set(['jump']),
      sourceText: `ctx.input.isDown('jump')`,
    });
    const crouch = findings.find((f) => f.summary.includes('crouch'));
    expect(crouch).toBeDefined();
    expect(crouch!.severity).toBe('issue');
    expect(crouch!.kind).toBe('dead-control');
  });

  it('flags a referenced-but-never-exercised action as a softer note', () => {
    const findings = deadControlFindings({
      actions: ['jump', 'dash'],
      axes: [],
      read: new Set(['jump']), // dash referenced in source but never read at runtime
      sourceText: `ctx.input.isDown('jump'); if (ctx.input.isDown('dash')) {}`,
    });
    const dash = findings.find((f) => f.summary.includes('dash'));
    expect(dash).toBeDefined();
    expect(dash!.severity).toBe('note');
  });

  it('says nothing about an input that was actually read', () => {
    const findings = deadControlFindings({
      actions: ['jump'],
      axes: [],
      read: new Set(['jump']),
      sourceText: `ctx.input.isDown('jump')`,
    });
    expect(findings).toEqual([]);
  });

  it('covers axes too', () => {
    const findings = deadControlFindings({
      actions: [],
      axes: ['move', 'aim'],
      read: new Set(['move']),
      sourceText: `ctx.input.axis('move')`,
    });
    // 'aim' is neither referenced nor read → definite issue.
    expect(findings.some((f) => f.summary.includes('aim') && f.severity === 'issue')).toBe(true);
  });
});
