/**
 * Origin/Host enforcement for the local servers.
 *
 * There are two of them and they get two different rules, because they carry
 * two different kinds of bytes:
 *
 *  - The CONTROL PLANE (/api/*, the /api/ws upgrade, the probe stream). This
 *    runs commands, reads and writes the user's disk, and spawns their login
 *    shell. Guarded by `isRequestAllowed`.
 *  - The GAME MOUNT (server/gameServer.ts), a separate loopback port that
 *    serves nothing but files out of an open project folder. Guarded by
 *    `isLoopbackRequest`.
 *
 * A hostile webpage can point a browser at http://127.0.0.1:<port>/api/...
 * just as easily as the editor itself can. The server has no secret to check,
 * so the only defense is refusing requests whose Origin (and, as a
 * DNS-rebinding backstop, Host) doesn't look like the editor's own UI.
 *
 * `isRequestAllowed` rules:
 *  - No Origin header at all -> allow. Non-browser clients (curl, the CLI,
 *    MCP server) never send Origin, and this must keep working.
 *  - Origin present -> parse it as a URL; its hostname must be one of the
 *    loopback names (localhost/127.0.0.1/::1), http or https. Anything else
 *    (including the literal string "null", which browsers send for opaque
 *    origins) is rejected, as is a malformed Origin.
 *  - Origin present AND Host present -> their PORTS must match. This is the
 *    rule that keeps the game out of the control plane. The game document is
 *    served from its own loopback port (Layer 1 of the RCE fix), and a
 *    loopback port is still loopback: a rule that accepted "any localhost
 *    origin, any port" accepted the game, and a game is arbitrary code the
 *    agent wrote. `fetch` would at least have been stopped from READING the
 *    reply by CORS, but WebSocket ignores CORS entirely, so the /api/ws
 *    upgrade (pty-start -> a shell as the user) was reachable from any game.
 *    Requiring the ports to agree makes this a same-origin check, and every
 *    OTHER localhost page on the machine falls to it too.
 *  - Host present -> its hostname (port stripped) must be in the same loopback
 *    set. This guards against DNS rebinding, where an attacker-controlled
 *    domain resolves to 127.0.0.1 so Origin passes but the browser still sent
 *    a non-loopback Host.
 *
 * Loopback hostnames are treated as aliases of one another (Origin
 * `http://localhost:5173` against Host `127.0.0.1:5173` is fine): a browser
 * derives both from the same address bar, so the pair can never disagree on
 * the name in practice, and pinning the name as well would only break someone
 * who typed the other spelling.
 */

const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type OriginCheckResult = { ok: true } | { ok: false; reason: 'origin' | 'host' | 'port' };

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

/**
 * The port a Host header names, or null when it names none. A bare host means
 * the scheme default, which for a loopback dev/desktop server is always http's
 * 80 in practice; returning null instead of guessing lets the caller skip the
 * comparison rather than reject on a technicality.
 */
function portFromHostHeader(host: string): string | null {
  const trimmed = host.trim();
  const start = trimmed.startsWith('[') ? trimmed.indexOf(']') : -1;
  const colon = start === -1 ? trimmed.lastIndexOf(':') : trimmed.indexOf(':', start);
  if (colon === -1 || colon === trimmed.length - 1) return null;
  const port = trimmed.slice(colon + 1);
  return /^\d+$/.test(port) ? port : null;
}

/** The port an origin URL names, filling in the scheme default when implicit. */
function portFromOrigin(origin: URL): string {
  if (origin.port !== '') return origin.port;
  return origin.protocol === 'https:' ? '443' : '80';
}

/** Parses and loopback-checks an Origin header. Null when it is not acceptable. */
function parseLoopbackOrigin(origin: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  return isAllowedHostname(parsed.hostname) ? parsed : null;
}

/**
 * The control-plane guard: loopback, and same port as the server being asked.
 * See the rules in this file's header.
 */
export function isRequestAllowed(headers: { origin?: string; host?: string }): OriginCheckResult {
  const { origin, host } = headers;

  const parsedOrigin = origin === undefined ? null : parseLoopbackOrigin(origin);
  if (origin !== undefined && !parsedOrigin) return { ok: false, reason: 'origin' };

  if (host !== undefined) {
    if (!isAllowedHostname(hostnameFromHostHeader(host))) return { ok: false, reason: 'host' };
    // The port pair is the game boundary. Only compared when the Host header
    // actually carries a port, so a client that sends a bare host is judged on
    // the loopback rules alone rather than on a default we invented for it.
    const hostPort = portFromHostHeader(host);
    if (parsedOrigin && hostPort !== null && portFromOrigin(parsedOrigin) !== hostPort) {
      return { ok: false, reason: 'port' };
    }
  }

  return { ok: true };
}

/**
 * The game-mount guard: loopback only, port free.
 *
 * The game server deliberately does NOT require a same-origin caller. The
 * editor page frames the game from a different loopback port, and that is the
 * entire point of the split, so a cross-port Origin here is the normal case.
 * All this rules out is a non-loopback Host (DNS rebinding, which would let a
 * remote page read the user's project files) and a non-loopback Origin.
 */
export function isLoopbackRequest(headers: { origin?: string; host?: string }): OriginCheckResult {
  const { origin, host } = headers;
  if (origin !== undefined && !parseLoopbackOrigin(origin)) return { ok: false, reason: 'origin' };
  if (host !== undefined && !isAllowedHostname(hostnameFromHostHeader(host))) {
    return { ok: false, reason: 'host' };
  }
  return { ok: true };
}
