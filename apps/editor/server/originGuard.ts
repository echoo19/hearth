/**
 * Origin/Host enforcement for the local project server. A hostile webpage
 * can point a browser at http://127.0.0.1:<port>/api/... (or the /api/ws
 * upgrade) just as easily as the editor itself can — the server has no
 * secret to check, so the only defense is refusing requests whose Origin
 * (and, as a DNS-rebinding backstop, Host) doesn't look like the editor's
 * own UI.
 *
 * Rules:
 *  - No Origin header at all -> allow. Non-browser clients (curl, the CLI,
 *    MCP server) never send Origin, and this must keep working.
 *  - Origin present -> parse it as a URL; its hostname must be one of the
 *    loopback names (localhost/127.0.0.1/::1), any port, http or https.
 *    Anything else (including the literal string "null", which browsers
 *    send for sandboxed iframes/opaque origins — Electron's window loads
 *    over http://127.0.0.1 and never sends this) is rejected. A malformed
 *    Origin (fails URL parsing) is rejected too.
 *  - Host header present -> its hostname (port stripped) must be in the
 *    same loopback set. This guards against DNS rebinding, where an
 *    attacker-controlled domain resolves to 127.0.0.1 so Origin passes but
 *    the browser still sent a non-loopback Host.
 */

const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type OriginCheckResult = { ok: true } | { ok: false; reason: 'origin' | 'host' };

function isAllowedHostname(hostname: string): boolean {
  return ALLOWED_HOSTNAMES.has(hostname.toLowerCase());
}

/** Strips a trailing `:<port>` from a bare Host header value, IPv6-literal aware. */
function hostnameFromHostHeader(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[')) {
    // IPv6 literal, e.g. "[::1]:5173" or "[::1]".
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

export function isRequestAllowed(headers: { origin?: string; host?: string }): OriginCheckResult {
  const { origin, host } = headers;

  if (origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return { ok: false, reason: 'origin' };
    }
    if (!isAllowedHostname(parsed.hostname)) {
      return { ok: false, reason: 'origin' };
    }
  }

  if (host !== undefined) {
    const hostname = hostnameFromHostHeader(host);
    if (!isAllowedHostname(hostname)) {
      return { ok: false, reason: 'host' };
    }
  }

  return { ok: true };
}
