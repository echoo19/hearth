/**
 * ctx. completion source: prefix-tree navigation over the real CTX_API
 * import, plus the drift-guard test that keeps this module from silently
 * forking a stale copy of the API surface.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, type Completion, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { CTX_API } from '@hearth/core';
import { ctxCompletionSource, resolveCtxPath } from '../src/components/code/completion';

/** Build a CompletionContext with the cursor at the end of `doc`. */
function contextFor(doc: string, explicit = false): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, doc.length, explicit);
}

/**
 * `CompletionSource` is typed to allow an async result, but this module's
 * implementation is always synchronous (no I/O — CTX_API is in-memory data).
 * This helper asserts that and gives the rest of the suite a plain
 * `CompletionResult | null` to assert against.
 */
function complete(source: CompletionSource, doc: string, explicit = false): CompletionResult | null {
  const result = source(contextFor(doc, explicit));
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    throw new Error('ctxCompletionSource unexpectedly returned a Promise');
  }
  return result as CompletionResult | null;
}

function labels(options: readonly Completion[]): string[] {
  return options.map((o) => o.label).sort();
}

describe('ctxCompletionSource', () => {
  it('completes top-level ctx segments from a partial prefix', () => {
    const source = ctxCompletionSource('js');
    const result = complete(source, 'ctx.sce');
    expect(result).not.toBeNull();
    expect(labels(result!.options)).toContain('scene');
    // Only a prefix match, not unrelated top-level segments.
    expect(labels(result!.options)).not.toContain('camera');
  });

  it('completes nested ctx segments after a trailing dot, with signature + description info', () => {
    const source = ctxCompletionSource('js');
    const result = complete(source, 'ctx.scene.');
    expect(result).not.toBeNull();
    const names = labels(result!.options);
    expect(names).toEqual(expect.arrayContaining(['spawn', 'spawnPrefab', 'find', 'findByTag', 'destroy', 'findPath']));

    const spawn = result!.options.find((o) => o.label === 'spawn')!;
    expect(spawn.type).toBe('method');
    expect(spawn.info).toContain('spawn(def: SpawnDef): EntityHandle');
    expect(spawn.info).toContain('Create an entity at runtime');
  });

  it('filters nested completions by the partial word being typed', () => {
    const source = ctxCompletionSource('js');
    const result = complete(source, 'ctx.scene.sp');
    expect(result).not.toBeNull();
    expect(labels(result!.options)).toEqual(['spawn', 'spawnPrefab']);
  });

  it('returns null for an unknown ctx path', () => {
    const source = ctxCompletionSource('js');
    expect(complete(source, 'ctx.notARealNamespace.')).toBeNull();
  });

  it('does not trigger on an identifier that merely ends in "ctx"', () => {
    const source = ctxCompletionSource('js');
    expect(complete(source, 'myctx.')).toBeNull();
  });

  it('does not complete ctx paths for plain word typing with no dot', () => {
    const source = ctxCompletionSource('js');
    expect(complete(source, 'ctx')).toBeNull();
  });

  it('places the completion range at the start of the partial word, not the whole path', () => {
    const source = ctxCompletionSource('js');
    const doc = 'ctx.scene.sp';
    const result = complete(source, doc);
    expect(result!.from).toBe(doc.length - 'sp'.length);
  });

  describe('lua keyword completion', () => {
    it('completes bare Lua keywords by prefix', () => {
      const source = ctxCompletionSource('lua');
      const result = complete(source, 'fun');
      expect(result).not.toBeNull();
      expect(labels(result!.options)).toEqual(['function']);
      expect(result!.options[0].type).toBe('keyword');
    });

    it('does not offer Lua keyword completion for js', () => {
      const source = ctxCompletionSource('js');
      expect(complete(source, 'fun')).toBeNull();
    });

    it('does not fire mid-identifier with no matching keyword', () => {
      const source = ctxCompletionSource('lua');
      expect(complete(source, 'myVariable')).toBeNull();
    });
  });
});

describe('resolveCtxPath drift guard', () => {
  it('resolves every real CTX_API entry through the completion tree', () => {
    expect(CTX_API.length).toBeGreaterThan(0);
    for (const entry of CTX_API) {
      const resolved = resolveCtxPath(entry.path);
      expect(resolved, `CTX_API entry "${entry.path}" did not resolve in the completion tree`).toEqual(entry);
    }
  });

  it('does not resolve an unknown path', () => {
    expect(resolveCtxPath('totally.not.a.real.path')).toBeUndefined();
  });
});
