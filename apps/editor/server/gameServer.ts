/**
 * The game mount, on an origin of its own.
 *
 * WHY THIS FILE EXISTS
 *
 * The pane runs whatever web game the agent wrote, in an iframe, with a
 * deliberately permissive sandbox (`allow-scripts` AND `allow-same-origin`, so
 * the game keeps localStorage, workers, WASM, and canvas readback). That
 * combination is a no-op sandbox by design: the framed document is an ordinary
 * page with whatever origin the server gave it.
 *
 * It used to be given the EDITOR's origin, because /game/<key>/<entry> was a
 * mount on the same server as /api. So a line of JavaScript in any game could
 * open ws://<editor>/api/ws, send `pty-start`, and drive an interactive login
 * shell as the user. WebSocket ignores CORS, and the upgrade handler resolved
 * whatever `?project=` path it was handed, so `?project=/Users/<name>` was
 * enough. `GET /api/meta` even handed out the home directory.
 *
 * Tightening the sandbox is the wrong fix: dropping `allow-same-origin` takes
 * localStorage, workers, and canvas readback away from every game, and Hearth
 * does not get to decide what kind of game someone is allowed to build. So the
 * boundary moved instead. The game is served from its own loopback port here.
 * It is still same-origin WITH ITSELF (every capability unchanged, relative
 * asset URLs unchanged, `localStorage` unchanged), and it is cross-origin to
 * the control plane, which no longer accepts it (see originGuard.ts, where
 * the port pair is compared).
 *
 * This server serves EXACTLY two things and knows how to do nothing else: the
 * project folder and the project's evidence folder, both through the caller's
 * `serveMounted`, which is what enforces "the folder must be open" and "the
 * path must not escape it". There is no API here, no WebSocket upgrade
 * listener, and no route table to grow one by accident.
 */
import http from 'node:http';
import { isLoopbackRequest } from './originGuard.js';

export const GAME_MOUNT = '/game/';
export const EVIDENCE_MOUNT = '/evidence/';

/** What `serveMounted` answers with. Structural, to keep this module a leaf. */
interface MountedFile {
  status: number;
  contentType?: string;
  data?: Uint8Array;
  body?: unknown;
}

/**
 * The one thing this server needs from the project context. Named structurally
 * rather than imported, so projectServer.ts can depend on this file without a
 * cycle back through it.
 */
export interface GameMountSource {
  serveMounted(mount: 'game' | 'evidence', key: string, rel: string): Promise<MountedFile>;
}

export interface GameServerHandle {
  /** Absolute origin the client must build game URLs against, e.g. http://127.0.0.1:52341 */
  origin: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Injected into every HTML document the game mount serves.
 *
 * The pane frames a game at its OWN aspect rather than stretching it, and it
 * used to learn that aspect by reading `iframe.contentDocument` for the
 * game's largest canvas. Moving the game off the editor's origin makes that
 * read throw, and the pane would silently letterbox every non-16:9 game onto
 * the wrong stage. So the measurement travels the way a cross-origin
 * measurement has to: the document reports its own canvas size outward.
 *
 * Kept to an anonymous IIFE that declares no globals, touches no game state,
 * and stops polling after ten seconds, because this is the agent's document
 * and Hearth is a guest in it. `window.parent === window` means nobody framed
 * this (someone opened the game directly through Play), so it does nothing at
 * all.
 */
const MEASURE_SHIM = `<script>(function(){
if(window.parent===window)return;
var last='';
function look(){
var best=null,list=document.getElementsByTagName('canvas');
for(var i=0;i<list.length;i++){
var c=list[i],r=c.getBoundingClientRect(),w=r.width||c.clientWidth||c.width,h=r.height||c.clientHeight||c.height;
if(w>0&&h>0&&(!best||w*h>best.w*best.h))best={w:w,h:h};
}
var key=best?best.w+'x'+best.h:'';
if(key===last)return;
last=key;
try{window.parent.postMessage({hearthGameSize:{width:best?best.w:0,height:best?best.h:0}},'*');}catch(e){}
}
var ticks=0,timer=setInterval(function(){look();if(++ticks>25)clearInterval(timer);},400);
window.addEventListener('load',look);
window.addEventListener('resize',look);
})();</script>`;

/**
 * Puts the shim in the document without disturbing what the agent wrote.
 * Before `</body>` when there is one, else appended: a script before the
 * doctype would drop the whole page into quirks mode, which would change how
 * the game lays out. A document whose bytes are not valid UTF-8 text is left
 * exactly as it arrived.
 */
export function withMeasureShim(html: string): string {
  const close = html.toLowerCase().lastIndexOf('</body>');
  if (close === -1) return html + MEASURE_SHIM;
  return html.slice(0, close) + MEASURE_SHIM + html.slice(close);
}

/**
 * Starts the mount server on a free loopback port. Binds to 127.0.0.1 only,
 * so nothing off this machine can reach it even before the Host check runs.
 */
export function startGameServer(source: GameMountSource): Promise<GameServerHandle> {
  const server = http.createServer((req, res) => {
    void handleGameRequest(source, req, res).catch((err: unknown) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: (err as Error).message ?? 'Internal error' }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Could not determine the game server port'));
        return;
      }
      let closing: Promise<void> | null = null;
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: () => {
          closing ??= new Promise<void>((closeResolve) => server.close(() => closeResolve()));
          return closing;
        },
      });
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function handleGameRequest(
  source: GameMountSource,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!isLoopbackRequest({ origin: req.headers.origin, host: req.headers.host }).ok) {
    return sendJson(res, 403, { ok: false, error: 'Forbidden: non-loopback request rejected' });
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  for (const [mount, prefix] of [
    ['game', GAME_MOUNT],
    ['evidence', EVIDENCE_MOUNT],
  ] as const) {
    if (!url.pathname.startsWith(prefix)) continue;
    const rest = url.pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    const rootKey = slash === -1 ? rest : rest.slice(0, slash);
    const relRaw = slash === -1 ? '' : rest.slice(slash + 1);
    let rel: string;
    try {
      rel = decodeURIComponent(relRaw);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Malformed path.' });
    }
    const result = await source.serveMounted(mount, rootKey, rel === '' ? 'index.html' : rel);
    if (result.data === undefined) return sendJson(res, result.status, result.body);

    const isHtml = (result.contentType ?? '').startsWith('text/html');
    const data = isHtml
      ? Buffer.from(withMeasureShim(Buffer.from(result.data).toString('utf8')), 'utf8')
      : Buffer.from(result.data);
    res.statusCode = result.status;
    res.setHeader('Content-Type', result.contentType ?? 'application/octet-stream');
    // Never cached: the whole point of the pane is that it shows what the
    // agent just wrote, and a reload must fetch the new bytes.
    res.setHeader('Cache-Control', 'no-store');
    // No X-Frame-Options here, deliberately. The editor page frames this from
    // a different loopback port, which is the entire point of the split, so
    // SAMEORIGIN would blank the pane. Framing is not the threat model: the
    // threat was the game reaching the control plane, and that is answered by
    // the origin, not by who is allowed to frame whom.
    res.end(data);
    return;
  }

  // Nothing else lives here, and nothing else ever should. A 404 rather than a
  // fallback document, so a mistyped mount is loud instead of showing the
  // wrong page.
  return sendJson(res, 404, { ok: false, error: 'The game server serves /game/ and /evidence/ only.' });
}
