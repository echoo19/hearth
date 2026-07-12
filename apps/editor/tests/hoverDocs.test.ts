/**
 * `ctx.` hover docs: pure identifier-under-cursor extraction + CTX_API
 * lookup, kept CodeMirror-free so it's testable without a real EditorView.
 * Sourced from `resolveCtxPath` (completion.ts) — the same trie
 * `ctxCompletionSource` reads from — so a hover result can never drift from
 * what completion already offers; no separate drift-guard test needed here
 * (completion.test.ts already covers `resolveCtxPath` against the real
 * `CTX_API` import).
 */
import { describe, expect, it } from 'vitest';
import { ctxChainMatchAt, ctxDocAt } from '../src/components/code/hoverDocs';

describe('ctxDocAt', () => {
  it('resolves the CTX_API entry when hovering mid-way through a nested path', () => {
    const line = "local coin = ctx.scene.spawnPrefab('Coin')";
    const col = line.indexOf('spawnPrefab') + 3; // mid-identifier, inside "spawnPrefab"
    const entry = ctxDocAt(line, col);
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe('scene.spawnPrefab');
    expect(entry!.signature).toContain('spawnPrefab(name: string');
  });

  it('resolves a single-segment path when hovering over it', () => {
    const line = 'ctx.transform.position.x += 100 * dt';
    const col = line.indexOf('transform') + 3;
    const entry = ctxDocAt(line, col);
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe('transform');
  });

  it('returns null when hovering a non-ctx identifier', () => {
    const line = 'local speed = 100';
    const col = line.indexOf('speed') + 2;
    expect(ctxDocAt(line, col)).toBeNull();
  });

  it('returns null for a partial, unresolved path segment', () => {
    const line = 'ctx.sce';
    const col = line.length - 1; // inside "sce", not the real "scene" segment
    expect(ctxDocAt(line, col)).toBeNull();
  });

  it('returns null for an identifier that merely ends in "ctx"', () => {
    const line = 'myctx.scene.spawn()';
    const col = line.indexOf('scene') + 2;
    expect(ctxDocAt(line, col)).toBeNull();
  });

  it('returns null when hovering the bare "ctx" token itself, before any dot', () => {
    const line = 'ctx.scene.spawn()';
    expect(ctxDocAt(line, 1)).toBeNull();
  });

  it('returns null when the column falls outside any ctx chain on the line', () => {
    const line = 'ctx.scene.spawn()  -- comment';
    expect(ctxDocAt(line, line.length - 2)).toBeNull();
  });

  it('resolves a nested animator method (wave I: state machines)', () => {
    const line = 'ctx.animator.setParam(ctx.entity.name, "moving", true)';
    const col = line.indexOf('setParam') + 3;
    const entry = ctxDocAt(line, col);
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe('animator.setParam');
    expect(entry!.signature).toContain('setParam(entityRef: string, name: string');
  });
});

describe('ctxChainMatchAt', () => {
  it('reports the [from, to) range of just the hovered segment, not the whole chain', () => {
    const line = 'ctx.scene.spawnPrefab(';
    const col = line.indexOf('spawnPrefab') + 3;
    const match = ctxChainMatchAt(line, col);
    expect(match).not.toBeNull();
    expect(match!.path).toBe('scene.spawnPrefab');
    expect(line.slice(match!.from, match!.to)).toBe('ctx.scene.spawnPrefab');
  });

  it('reports the range up through only the first segment when hovering it', () => {
    const line = 'ctx.scene.spawnPrefab(';
    const col = line.indexOf('scene') + 2;
    const match = ctxChainMatchAt(line, col);
    expect(match).not.toBeNull();
    expect(match!.path).toBe('scene');
    expect(line.slice(match!.from, match!.to)).toBe('ctx.scene');
  });
});
