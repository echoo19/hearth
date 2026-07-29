/**
 * The client's two transport contracts.
 *
 * getJson: apiMeta reports request failures before returning null.
 *
 * postJson: failure is a VALUE, never a throw. This used to split — a clean
 * `ok: false` came back as a value while a dead server came back as a
 * rejection — and every caller that handled the value forgot the rejection:
 * the New-project dialog spun on "Creating…" forever, a rename silently
 * didn't happen. What these pin is that a server that cannot be reached, a
 * reply that is not JSON, and a refusal status all come back through the one
 * `ok: false` door with a reason in words a person can be shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCreateWorkspace, apiDeleteChat, apiMeta, apiOpenWorkspace, apiRenameChat } from '../src/api';

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

describe('postJson-backed wrappers', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  /** A dead server: the fetch itself rejects, as loopback does when nothing listens. */
  function fetchRejects(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
  }

  it('apiCreateWorkspace answers ok:false in plain words when the server cannot be reached', async () => {
    fetchRejects();
    const res = await apiCreateWorkspace(undefined, 'Lighthouse');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Could not reach/);
    // The raw cause still lands on the console, same floor as getJson.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('apiOpenWorkspace answers ok:false when the reply is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      })),
    );
    const res = await apiOpenWorkspace('/somewhere');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Could not reach/);
  });

  it('rename and delete answer the reason instead of throwing, so the rail has words to show', async () => {
    fetchRejects();
    const renamed = await apiRenameChat('/p', 'chat-1', 'New title');
    expect(renamed).toEqual({ ok: false, error: expect.stringMatching(/Could not reach/) });
    const deleted = await apiDeleteChat('/p', 'chat-1');
    expect(deleted).toEqual({ ok: false, error: expect.stringMatching(/Could not reach/) });
  });

  it('keeps the server’s own words on a refusal status that carries its envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: 'Disk is full.' }),
      })),
    );
    const res = await apiCreateWorkspace(undefined, 'Lighthouse');
    expect(res).toEqual({ ok: false, error: 'Disk is full.' });
  });

  it('refuses to adopt a non-envelope body on a refusal status as an answer', async () => {
    // A proxy's JSON error page, say: a 502 whose body never came from our
    // server. Claiming it as a result would imply an exchange that did not
    // happen, so it comes back as a refusal that names the status.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({ message: 'Bad Gateway' }),
      })),
    );
    const res = await apiOpenWorkspace('/somewhere');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/502/);
  });
});
