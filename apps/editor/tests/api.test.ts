/** apiMeta reports request failures before returning null. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMeta } from '../src/api';

describe('apiMeta', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('returns the parsed meta on a successful, ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ ok: true, repoRoot: '/repo' }) })),
    );
    await expect(apiMeta()).resolves.toEqual({ ok: true, repoRoot: '/repo' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns null without logging when the server responds but ok is false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ ok: false }) })),
    );
    await expect(apiMeta()).resolves.toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs and returns null when fetch rejects (network failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(apiMeta()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('apiMeta');
  });

  it('logs and returns null when the response body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      })),
    );
    await expect(apiMeta()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
