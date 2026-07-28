/**
 * The always-on game pane: whatever web game currently lives in the folder,
 * running, in an iframe, all the time.
 *
 * The game is framed rather than filled. A game has a shape — its canvas — and
 * stretching it to whatever the pane happens to be is a lie about what the
 * player will see. So the pane is a dark matte and the game sits on a centred,
 * rounded stage sized to its own aspect, letterboxed, with margins around it.
 * That shape is reported OUT of the running document (the game is cross-origin
 * now, so it cannot be read in) and falls back to 16:9 until it arrives.
 *
 * Beyond that the pane has two states: nothing yet, and running. What it does
 * NOT do is show the tester's session. The tester plays in a browser of its own
 * and its picture belongs on its own tab (../tester/TesterStage.tsx); painting
 * it over this game would take the person's own session away from them while
 * they were using it. All this pane owes the tester is a line saying where it
 * is, so a game standing still beside a running session is never mistaken for a
 * game that has stopped working.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useApp, GAME_POLL_MS } from '../../store';
import { gameUrl } from '../../api';
import { CapabilityStrip } from './CapabilityStrip';
import { ProbeNote, stageNoteStatus } from './ProbeStage';

/** What a game is assumed to be shaped like until it says otherwise. */
export const FALLBACK_ASPECT = 16 / 9;
/** Aspects outside this band are a measurement artifact, not a game. */
const MIN_ASPECT = 0.2;
const MAX_ASPECT = 6;

/**
 * The aspect ratio to frame a game at, given whatever the document reports.
 * Pure so the fallback rules are testable without an iframe: a canvas with no
 * size yet, a hidden 1x1 tracking pixel, or an absurd ratio must all fall back
 * rather than produce a stage nothing fits in.
 */
export function stageAspect(size: { width: number; height: number } | null): number {
  if (!size || !(size.width > 0) || !(size.height > 0)) return FALLBACK_ASPECT;
  const aspect = size.width / size.height;
  if (!Number.isFinite(aspect) || aspect < MIN_ASPECT || aspect > MAX_ASPECT) return FALLBACK_ASPECT;
  return aspect;
}

/**
 * The game's own shape, out of a `message` this pane received.
 *
 * The pane used to read `iframe.contentDocument` directly, which worked only
 * because the game ran on the editor's origin, which is exactly what had to
 * stop (see the sandbox comment below and server/gameServer.ts). The game
 * origin now reports its largest canvas outward instead; every game document
 * the mount serves carries the few lines that do it.
 *
 * Pure, and suspicious of its input: this listens to `window` on a page that
 * frames untrusted code, so anything that is not the shape we asked for is
 * simply not a size. Callers still check that the message came from the frame.
 */
export function gameSizeFromMessage(data: unknown): { width: number; height: number } | null {
  const payload = (data as { hearthGameSize?: unknown } | null)?.hearthGameSize;
  if (typeof payload !== 'object' || payload === null) return null;
  const { width, height } = payload as { width?: unknown; height?: unknown };
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/**
 * How much to scale a game drawn at its own pixel size so it exactly fills a
 * stage of `stageWidth`. Pure: a stage or a game with no width yet scales by 1
 * rather than collapsing the frame to nothing.
 */
export function frameScale(stageWidth: number, gameWidth: number): number {
  if (!(stageWidth > 0) || !(gameWidth > 0)) return 1;
  return stageWidth / gameWidth;
}

/**
 * Nothing to show yet. A soft preview frame rather than an illustration: the
 * shape of what will appear, so the pane reads as waiting rather than broken.
 *
 * The second copy is for the one case where there IS a game and the pane still
 * cannot show it: the mount server never came up, so there is no origin to
 * serve it from. Saying "no game yet" there would be a lie, and the fix is not
 * something the person can do from this pane, so it says what happened.
 */
function GameEmptyState({ reason }: { reason: 'none' | 'no-origin' }) {
  return (
    <div className="game-empty">
      <div className="game-empty-frame" aria-hidden="true" />
      {reason === 'no-origin' ? (
        <>
          <p className="game-empty-lead">Nowhere to run the game</p>
          <p className="game-empty-hint">
            Hearth serves your game on its own local port and that port could not be opened. Restarting Hearth
            usually clears it.
          </p>
        </>
      ) : (
        <>
          <p className="game-empty-lead">No game to show yet</p>
          <p className="game-empty-hint">Ask for one. It appears here the moment there is something to run.</p>
        </>
      )}
    </div>
  );
}

export function GamePane() {
  const projectPath = useApp((s) => s.projectPath);
  const game = useApp((s) => s.game);
  const gameNonce = useApp((s) => s.gameNonce);
  const refreshGame = useApp((s) => s.refreshGame);
  const testerRunning = useApp((s) => s.tester.running || s.tester.starting);
  // Which loopback origin the game is served from. Learned from /api/meta at
  // startup (the port is chosen then), never assumed, and never defaulted to
  // this page's own origin.
  const gameOrigin = useApp((s) => s.meta?.gameOrigin ?? null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const aspect = stageAspect(size);

  // Poll rather than push: the agent writes files through whatever toolchain
  // it likes, so there is no reliable "I finished" signal to subscribe to. A
  // stat of one folder every 1.5s is cheap and always right.
  useEffect(() => {
    if (!projectPath) return;
    const id = window.setInterval(() => void refreshGame(), GAME_POLL_MS);
    return () => window.clearInterval(id);
  }, [projectPath, refreshGame]);

  // Games commonly size their canvas a frame or two after load (engine boot, a
  // resize handler), so the document keeps reporting for a while rather than
  // announcing once. Every message is checked against THIS frame's window:
  // `message` is a window-wide event, and a page that frames untrusted code
  // must never take a stranger's word for what shape it is.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const next = gameSizeFromMessage(event.data);
      if (next) setSize(next);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A new document has a new shape, and until it says what that is the stage
  // must not keep the last game's.
  useEffect(() => {
    setSize(null);
  }, [game.entry, gameNonce]);

  // The stage's own width drives the scale a fixed-size game is drawn at, so a
  // 960x540 canvas fills a 600px stage instead of being cropped by it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(stage);
    setStageWidth(stage.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [game.present, game.entry]);

  const entry = game.present ? game.entry : null;
  // A game the pane knows about but has no origin to serve from is a different
  // state from no game at all, and the empty state says so.
  const hasGame = entry !== null && projectPath !== null;

  return (
    <div className="game-pane">
      {entry !== null && projectPath !== null && gameOrigin !== null ? (
        <div className="game-stage-wrap">
          <div className="game-stage-column">
          <div
            ref={stageRef}
            className="game-stage"
            style={{ '--game-aspect': aspect } as React.CSSProperties}
          >
            <iframe
              ref={frameRef}
              // A game with a known pixel size is rendered at that size and
              // scaled down to the stage — the alternative is cropping it,
              // which shows the player a game nobody will ever see. A game with
              // no measurable size is responsive by definition: let it fill.
              className={`game-frame${size ? ' is-scaled' : ''}`}
              style={
                size
                  ? ({
                      width: `${size.width}px`,
                      height: `${size.height}px`,
                      '--game-scale': frameScale(stageWidth, size.width),
                    } as React.CSSProperties)
                  : undefined
              }
              title="Game preview"
              // The nonce is part of the key AND the URL: remounting guarantees a
              // clean document even for a game that installed global state, and
              // the query defeats any cached bytes.
              key={`${entry}#${gameNonce}`}
              src={gameUrl(gameOrigin, projectPath, entry, gameNonce)}
              /* READ THIS BEFORE "FIXING" THE SANDBOX.
               *
               * `allow-scripts` together with `allow-same-origin` is famously
               * a no-op sandbox: the frame ends up an ordinary document with
               * its server's origin. That is DELIBERATE and it must stay.
               * Taking `allow-same-origin` away gives the frame an opaque
               * origin, and an opaque origin has no localStorage, no
               * IndexedDB, no module workers, no canvas readback, and breaks
               * several ordinary WASM setups. Half the games people make in
               * Hearth would stop working, and Hearth does not get to decide
               * which half. The sandbox is not what holds this line.
               *
               * What holds the line is the ORIGIN. `gameOrigin` is a second
               * loopback server (server/gameServer.ts) that serves the
               * project folder and nothing else: no API, no route table, no
               * WebSocket upgrade. So the game is still same-origin with
               * ITSELF (every capability above intact, relative asset URLs
               * intact) and cross-origin to Hearth's control plane, which
               * refuses it by port (server/originGuard.ts).
               *
               * This is not theoretical. When the game was served from the
               * editor's own origin, one line of JavaScript in any game
               * opened ws://<editor>/api/ws?project=<anything>, sent
               * `pty-start`, and had an interactive login shell as the user.
               * WebSocket does not do CORS, so nothing in the browser stood
               * in the way. If you ever move the game back onto this origin,
               * you put that back, and no sandbox string will save you: the
               * moment you tighten the sandbox enough to stop it, you have
               * broken the games.
               */
              sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups allow-same-origin"
            />
            {/* `off` unless the app believes a session is running, which is the
                whole rule: this stage never carries the tester's picture, so
                the only thing it can honestly say is where the tester is. */}
            <ProbeNote status={stageNoteStatus('off', testerRunning)} />
          </div>
          {/* Under the game, not under the pane. The strip used to be pinned to
              the pane's bottom edge, which put it a long way from the thing it
              acts on whenever the game was shorter than the space it was given:
              a wide, short game left the Play control stranded below a field of
              empty matte. In the column it travels with the stage and lands
              flush against its right edge. */}
          <CapabilityStrip />
        </div>
      </div>
      ) : (
        <>
          <GameEmptyState reason={hasGame ? 'no-origin' : 'none'} />
          <CapabilityStrip />
        </>
      )}
    </div>
  );
}
