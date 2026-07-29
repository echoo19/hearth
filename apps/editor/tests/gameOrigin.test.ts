/**
 * The origin boundary between a game and Hearth's control plane.
 *
 * THE HOLE THIS PINS SHUT
 *
 * The game pane frames whatever the agent wrote with `allow-scripts` AND
 * `allow-same-origin`, which is a no-op sandbox on purpose (a game needs
 * localStorage, workers, WASM, canvas readback). While the game was served
 * from a mount on the API server, that made every game an ordinary page on the
 * editor's origin, and this was enough to own the machine:
 *
 *   const ws = new WebSocket('ws://127.0.0.1:5173/api/ws?project=/Users/me');
 *   ws.onopen = () => {
 *     ws.send('{"type":"pty-start"}');
 *     setTimeout(() => ws.send('{"type":"pty-input","data":"id\\n"}'), 500);
 *   };
 *
 * `pty-start` spawns the user's login shell, `pty-input` writes to its stdin,
 * `pty-data` streams the output back. WebSocket does no CORS, so nothing in
 * the browser stood in the way, and GET /api/meta handed out os.homedir() to
 * anyone who asked, so the path did not even have to be guessed.
 *
 * Two independent layers close it, and both are tested here with real servers
 * and a real `ws` client, because both of them are transport-level rules that
 * a pure-function test would not have caught in the first place:
 *
 *   1. The game is served from its own loopback origin (server/gameServer.ts),
 *      and the control plane refuses a caller whose port is not its own
 *      (server/originGuard.ts).
 *   2. The /api/ws upgrade refuses a `?project=` that is not a folder somebody
 *      deliberately opened, so even a same-origin caller cannot name a path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import {
  createProjectServerContext,
  handleApiRequest,
  isHearthServerPath,
  encodeRootKey,
  type ProjectServerContext,
} from '../server/projectServer';
import { startGameServer, withMeasureShim, type GameServerHandle } from '../server/gameServer';
import { attachWebSocket } from '../server/ws';

let tmp: string;
let openFolder: string;
let secretFolder: string;
let ctx: ProjectServerContext;
let api: http.Server;
let apiOrigin: string;
let apiHost: string;
let game: GameServerHandle;

/** Opens a socket and reports how it ended: connected, or refused/closed. */
async function tryConnect(
  url: string,
  headers?: Record<string, string>,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const client = new WebSocket(url, { headers });
  try {
    return await new Promise<{ ok: true } | { ok: false; detail: string }>((resolve) => {
      const done = (result: { ok: true } | { ok: false; detail: string }) => resolve(result);
      client.on('open', () => done({ ok: true }));
      client.on('error', (err: Error) => done({ ok: false, detail: err.message }));
      client.on('close', (code: number, reason: Buffer) =>
        done({ ok: false, detail: `${code} ${reason.toString()}` }),
      );
      setTimeout(() => done({ ok: false, detail: 'timeout' }), 3000);
    });
  } finally {
    client.close();
  }
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-game-origin-'));
  openFolder = path.join(tmp, 'my-game');
  secretFolder = path.join(tmp, 'never-opened');
  await fsp.mkdir(openFolder, { recursive: true });
  await fsp.mkdir(secretFolder, { recursive: true });
  await fsp.writeFile(path.join(openFolder, 'index.html'), '<html><body><canvas></canvas></body></html>');
  await fsp.writeFile(path.join(secretFolder, 'secret.txt'), 'not yours');

  // The project's own hidden folder, with a stand-in for the two things that
  // actually live there. Written by this test, so nothing real is ever read.
  await fsp.mkdir(path.join(openFolder, '.hearth', 'chats'), { recursive: true });
  await fsp.writeFile(
    path.join(openFolder, '.hearth', 'app.json'),
    JSON.stringify({ apiKey: 'sk-ant-KEY-THIS-TEST-INVENTED', openaiApiKey: 'sk-OPENAI-INVENTED' }),
  );
  await fsp.writeFile(
    path.join(openFolder, '.hearth', 'chats', 'index.json'),
    JSON.stringify([{ id: 'c1', title: 'CHAT TITLE THIS TEST INVENTED' }]),
  );
  await fsp.mkdir(path.join(openFolder, '.git'), { recursive: true });
  await fsp.writeFile(path.join(openFolder, '.git', 'config'), 'PUSH TOKEN THIS TEST INVENTED');

  // A game that keeps art outside its entry's directory, which is the flow the
  // hidden-name rule must not have cost.
  await fsp.mkdir(path.join(openFolder, 'shared'), { recursive: true });
  await fsp.writeFile(path.join(openFolder, 'shared', 'atlas.png'), 'ATLAS BYTES');
  await fsp.mkdir(path.join(openFolder, 'dist'), { recursive: true });
  await fsp.writeFile(
    path.join(openFolder, 'dist', 'index.html'),
    '<html><body><canvas></canvas><img src="../shared/atlas.png"></body></html>',
  );

  ctx = createProjectServerContext({ recentsFile: path.join(tmp, 'recents.json'), repoRoot: tmp });
  await ctx.openWorkspace(openFolder);

  game = await startGameServer(ctx);
  ctx.setGameOrigin(game.origin);

  api = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (isHearthServerPath(url.pathname)) {
      void handleApiRequest(ctx, req, res).catch(() => {
        res.statusCode = 500;
        res.end('{}');
      });
      return;
    }
    // Stands in for the SPA fallback both real transports have.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html');
    res.end('<html>editor</html>');
  });
  attachWebSocket(api, ctx);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = (api.address() as { port: number }).port;
  apiOrigin = `http://127.0.0.1:${port}`;
  apiHost = `127.0.0.1:${port}`;
});

afterAll(async () => {
  game.close();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('layer 1: the game is not on the control plane’s origin', () => {
  it('serves the game from a different origin than the api', () => {
    expect(game.origin).not.toBe(apiOrigin);
  });

  it('no longer serves the game mount from the api origin', async () => {
    const res = await fetch(`${apiOrigin}/game/${encodeRootKey(openFolder)}/index.html`);
    const body = await res.text();
    // Falls through to the editor's own SPA document. What matters is that the
    // project's bytes are not what came back.
    expect(body).not.toContain('<canvas');
  });

  it('serves the game from the game origin, shim and all', async () => {
    const res = await fetch(`${game.origin}/game/${encodeRootKey(openFolder)}/index.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<canvas');
    expect(body).toContain('hearthGameSize');
  });

  it('keeps the open-folder jail on the game origin too', async () => {
    const res = await fetch(`${game.origin}/game/${encodeRootKey(secretFolder)}/secret.txt`);
    expect(res.status).toBe(403);
  });

  it('has no api on the game origin at all', async () => {
    const res = await fetch(`${game.origin}/api/meta`);
    expect(res.status).toBe(404);
  });

  it('THE ATTACK: a socket opened from the game origin is refused', async () => {
    // Precisely what the exploit did, with the Origin header a browser would
    // have attached to it from inside the game frame.
    const result = await tryConnect(
      `ws://${apiHost}/api/ws?project=${encodeURIComponent(openFolder)}`,
      { Origin: game.origin },
    );
    expect(result.ok).toBe(false);
  });

  it('THE ATTACK: /api/meta from the game origin is refused, so there is no home directory to aim at', async () => {
    const res = await fetch(`${apiOrigin}/api/meta`, { headers: { Origin: game.origin } });
    expect(res.status).toBe(403);
  });

  it('still lets the editor’s own page through', async () => {
    const res = await fetch(`${apiOrigin}/api/meta`, { headers: { Origin: apiOrigin } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; gameOrigin: string };
    expect(body.ok).toBe(true);
    expect(body.gameOrigin).toBe(game.origin);
  });
});

describe('layer 2: the socket cannot name a folder nobody opened', () => {
  it('THE ATTACK: refuses ?project=<home>, even same-origin', async () => {
    const result = await tryConnect(
      `ws://${apiHost}/api/ws?project=${encodeURIComponent(os.homedir())}`,
      { Origin: apiOrigin },
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a folder that exists but was never opened', async () => {
    const result = await tryConnect(
      `ws://${apiHost}/api/ws?project=${encodeURIComponent(secretFolder)}`,
      { Origin: apiOrigin },
    );
    expect(result.ok).toBe(false);
  });

  it('refuses an unopened root reached by a path that resolves into one', async () => {
    // openedRoots holds RESOLVED paths, so the check has to resolve too.
    const sneaky = path.join(openFolder, '..', 'never-opened');
    const result = await tryConnect(`ws://${apiHost}/api/ws?project=${encodeURIComponent(sneaky)}`, {
      Origin: apiOrigin,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts an unresolved spelling OF an open folder, so the editor is not made to normalize', async () => {
    const equivalent = path.join(openFolder, '.', '');
    const result = await tryConnect(
      `ws://${apiHost}/api/ws?project=${encodeURIComponent(equivalent)}`,
      { Origin: apiOrigin },
    );
    expect(result.ok).toBe(true);
  });

  it('still connects the editor to a folder it opened', async () => {
    const result = await tryConnect(
      `ws://${apiHost}/api/ws?project=${encodeURIComponent(openFolder)}`,
      { Origin: apiOrigin },
    );
    expect(result.ok).toBe(true);
  });
});

describe('layer 3: the game’s own origin does not serve the project’s secrets', () => {
  // The origin split's thesis is that the boundary is the ORIGIN, not the
  // capability. `/game/<key>/<rel>` resolves rel against the project ROOT, so
  // for as long as it excluded nothing, that thesis handed the game the user's
  // saved API keys and every conversation, from the same origin, with the key
  // already sitting in the game's own location.pathname.
  const key = () => encodeRootKey(openFolder);

  it('THE ATTACK: the game cannot fetch .hearth/app.json off its own mount', async () => {
    const res = await fetch(`${game.origin}/game/${key()}/.hearth/app.json`, {
      headers: { Origin: game.origin },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('KEY-THIS-TEST-INVENTED');
  });

  it('THE ATTACK: nor the chat history beside it', async () => {
    const res = await fetch(`${game.origin}/game/${key()}/.hearth/chats/index.json`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('CHAT TITLE');
  });

  it('nor .git/config, which is where a push token would be', async () => {
    const res = await fetch(`${game.origin}/game/${key()}/.git/config`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('PUSH TOKEN');
  });

  it('and the dot cannot be spelled around', async () => {
    // Percent-encoded, and reached through a detour that only normalizes into
    // a hidden segment. The check runs on the RESOLVED path for this reason.
    const encoded = await fetch(`${game.origin}/game/${key()}/%2Ehearth/app.json`);
    expect(encoded.status).toBe(403);
    const detour = await fetch(`${game.origin}/game/${key()}/shared/..%2F.hearth%2Fapp.json`);
    expect(detour.status).toBe(403);
  });

  it('LEGITIMATE: a game still loads an asset from elsewhere in its project', async () => {
    // dist/index.html points at ../shared/atlas.png. Re-basing the mount on the
    // entry's own directory would have broken exactly this, which is why the
    // rule is on the name and not on the shape.
    const entry = await fetch(`${game.origin}/game/${key()}/dist/index.html`);
    expect(entry.status).toBe(200);
    const asset = await fetch(`${game.origin}/game/${key()}/shared/atlas.png`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('ATLAS BYTES');
  });

  it('LEGITIMATE: the evidence mount still serves out of .hearth, because its base IS there', async () => {
    const shot = path.join(openFolder, '.hearth', 'evidence', 'sweeps', '1', 'shots');
    await fsp.mkdir(shot, { recursive: true });
    await fsp.writeFile(path.join(shot, 'f0.png'), 'FRAME BYTES');
    const res = await fetch(`${game.origin}/evidence/${key()}/sweeps/1/shots/f0.png`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('FRAME BYTES');
  });
});

describe('layer 4: closing a folder takes it back out of the jail', () => {
  it('THE ATTACK: an open folder stayed open forever, so project A could read project B', async () => {
    const other = path.join(tmp, 'other-game');
    await fsp.mkdir(other, { recursive: true });
    await fsp.writeFile(path.join(other, 'notes.txt'), 'B’S OWN BYTES');
    await ctx.openWorkspace(other);

    // While open, it is served. That is the point of the mount.
    const open = await fetch(`${game.origin}/game/${encodeRootKey(other)}/notes.txt`);
    expect(open.status).toBe(200);

    // Closing it used to be a client-side state change and nothing more.
    await ctx.closeWorkspace(other);
    const closed = await fetch(`${game.origin}/game/${encodeRootKey(other)}/notes.txt`);
    expect(closed.status).toBe(403);
    expect(await closed.text()).not.toContain('B’S OWN BYTES');
  });

  it('and the socket cannot name it either once it is closed', async () => {
    const other = path.join(tmp, 'other-socket');
    await fsp.mkdir(other, { recursive: true });
    await ctx.openWorkspace(other);
    expect(
      (await tryConnect(`ws://${apiHost}/api/ws?project=${encodeURIComponent(other)}`, { Origin: apiOrigin })).ok,
    ).toBe(true);
    await ctx.closeWorkspace(other);
    expect(
      (await tryConnect(`ws://${apiHost}/api/ws?project=${encodeURIComponent(other)}`, { Origin: apiOrigin })).ok,
    ).toBe(false);
  });

  it('LEGITIMATE: reopening it works, and the folder the user is in is untouched', async () => {
    const other = path.join(tmp, 'other-game');
    expect(((await ctx.openWorkspace(other)).body as { ok: boolean }).ok).toBe(true);
    expect((await fetch(`${game.origin}/game/${encodeRootKey(other)}/notes.txt`)).status).toBe(200);
    // Closing one folder must not close the one beside it.
    expect((await fetch(`${game.origin}/game/${encodeRootKey(openFolder)}/index.html`)).status).toBe(200);
  });
});

describe('the measure shim', () => {
  it('goes inside the body rather than ahead of the doctype', () => {
    // A script before the doctype drops the page into quirks mode, which would
    // change how the agent's game lays out. Hearth is a guest in this document.
    const out = withMeasureShim('<!doctype html><html><body><canvas></canvas></body></html>');
    expect(out.indexOf('<script>')).toBeGreaterThan(out.indexOf('<canvas>'));
    expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('</body>'));
  });

  it('appends when there is no body tag to sit inside', () => {
    expect(withMeasureShim('<canvas></canvas>')).toContain('hearthGameSize');
  });
});
