import { describe, it, expect } from 'vitest';
import { isLoopbackRequest, isRequestAllowed } from '../server/originGuard';

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

  it('rejects a loopback Origin on a DIFFERENT port from the server it is asking', () => {
    // This is the game. It is served from its own loopback port so it cannot
    // reach the control plane, and "any localhost origin is fine" was exactly
    // what let it. A game that opens ws://<editor>/api/ws and sends pty-start
    // gets a login shell, and WebSocket does no CORS, so this check is the
    // only thing between a game and the user's machine.
    expect(
      isRequestAllowed({ origin: 'http://127.0.0.1:52341', host: 'localhost:5173' }),
    ).toEqual({ ok: false, reason: 'port' });
  });

  it('allows a loopback Origin whose port matches the Host it is asking', () => {
    expect(
      isRequestAllowed({ origin: 'http://127.0.0.1:5173', host: 'localhost:5173' }),
    ).toEqual({ ok: true });
  });

  it('treats the loopback spellings as one another’s aliases', () => {
    // A browser derives Origin and Host from the same address bar, so the
    // name can never actually disagree; pinning it would only break someone
    // who typed the other spelling.
    expect(isRequestAllowed({ origin: 'http://localhost:5173', host: '127.0.0.1:5173' })).toEqual({
      ok: true,
    });
  });

  it('judges a portless Host on the loopback rules alone', () => {
    expect(isRequestAllowed({ origin: 'http://localhost:5173', host: 'localhost' })).toEqual({
      ok: true,
    });
  });

  it('allows requests with only a loopback Host header and no Origin', () => {
    expect(isRequestAllowed({ host: '127.0.0.1:39271' })).toEqual({ ok: true });
  });

  it('rejects a non-loopback Host header with no Origin', () => {
    expect(isRequestAllowed({ host: 'evil.example' })).toEqual({ ok: false, reason: 'host' });
  });
});

describe('isLoopbackRequest (the game mount)', () => {
  it('allows a cross-port loopback Origin, which is the normal case', () => {
    // The editor page frames the game from a different port on purpose, so
    // the mount server must NOT apply the control plane's port rule.
    expect(isLoopbackRequest({ origin: 'http://localhost:5173', host: '127.0.0.1:52341' })).toEqual({
      ok: true,
    });
  });

  it('allows a navigation, which carries no Origin at all', () => {
    expect(isLoopbackRequest({ host: '127.0.0.1:52341' })).toEqual({ ok: true });
  });

  it('rejects a non-loopback Host (DNS rebinding at the project files)', () => {
    expect(isLoopbackRequest({ host: 'evil.example' })).toEqual({ ok: false, reason: 'host' });
  });

  it('rejects a remote page reading the project folder', () => {
    expect(isLoopbackRequest({ origin: 'https://evil.example', host: '127.0.0.1:52341' })).toEqual({
      ok: false,
      reason: 'origin',
    });
  });
});
