import { describe, it, expect } from 'vitest';
import { isRequestAllowed } from '../server/originGuard';

describe('isRequestAllowed', () => {
  it('allows requests with no Origin header (CLI/curl/non-browser)', () => {
    expect(isRequestAllowed({})).toEqual({ ok: true });
  });

  it('allows a localhost Origin with a dev-server port', () => {
    expect(isRequestAllowed({ origin: 'http://localhost:5173' })).toEqual({ ok: true });
  });

  it('allows a 127.0.0.1 Origin with any port (Electron loopback)', () => {
    expect(isRequestAllowed({ origin: 'http://127.0.0.1:39271' })).toEqual({ ok: true });
  });

  it('allows an https localhost Origin', () => {
    expect(isRequestAllowed({ origin: 'https://localhost:4173' })).toEqual({ ok: true });
  });

  it('allows an IPv6 loopback Origin', () => {
    expect(isRequestAllowed({ origin: 'http://[::1]:5173' })).toEqual({ ok: true });
  });

  it('rejects a cross-site Origin', () => {
    expect(isRequestAllowed({ origin: 'https://evil.example' })).toEqual({ ok: false, reason: 'origin' });
  });

  it('rejects a subdomain trick that merely contains "localhost"', () => {
    expect(isRequestAllowed({ origin: 'http://localhost.evil.example' })).toEqual({
      ok: false,
      reason: 'origin',
    });
  });

  it('rejects the opaque "null" Origin sent by sandboxed iframes', () => {
    expect(isRequestAllowed({ origin: 'null' })).toEqual({ ok: false, reason: 'origin' });
  });

  it('rejects a malformed Origin header', () => {
    expect(isRequestAllowed({ origin: 'not a url' })).toEqual({ ok: false, reason: 'origin' });
  });

  it('rejects when Origin is loopback but Host is not (DNS rebinding)', () => {
    expect(
      isRequestAllowed({ origin: 'http://127.0.0.1:5173', host: 'evil.example:5173' }),
    ).toEqual({ ok: false, reason: 'host' });
  });

  it('allows matching loopback Origin and Host with different ports', () => {
    expect(
      isRequestAllowed({ origin: 'http://127.0.0.1:5173', host: 'localhost:39271' }),
    ).toEqual({ ok: true });
  });

  it('allows requests with only a loopback Host header and no Origin', () => {
    expect(isRequestAllowed({ host: '127.0.0.1:39271' })).toEqual({ ok: true });
  });

  it('rejects a non-loopback Host header with no Origin', () => {
    expect(isRequestAllowed({ host: 'evil.example' })).toEqual({ ok: false, reason: 'host' });
  });
});
