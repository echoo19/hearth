/**
 * `apiMeta`/`apiDetectAgents` used to swallow every failure with a bare
 * `catch { return null }` — a network hiccup was completely invisible, and
 * indistinguishable in the UI from a legitimate "checked, found nothing"
 * response. Both now log via `console.error` before returning `null`, so
 * the failure at least reaches devtools even though callers already treat
 * `null` as "couldn't check" (see AgentPanel's `detectionFailed`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiDetectAgents, apiMeta } from '../src/api';

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

describe('apiDetectAgents', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('returns the parsed detection result on success', async () => {
    const detect = { claude: { found: true }, codex: { found: false } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ ok: true, ...detect }) })),
    );
    await expect(apiDetectAgents()).resolves.toEqual({ ok: true, ...detect });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs and returns null when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(apiDetectAgents()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('apiDetectAgents');
  });
});
