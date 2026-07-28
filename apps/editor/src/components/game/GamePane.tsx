/**
 * The always-on game pane: whatever web game currently lives in the folder,
 * running, in an iframe, all the time.
 *
 * The game is framed rather than filled. A game has a shape — its canvas — and
 * stretching it to whatever the pane happens to be is a lie about what the
 * player will see. So the pane is a dark matte and the game sits on a centred,
 * rounded stage sized to its own aspect, letterboxed, with margins around it.
 * That shape is measured from the running document when it can be (same-origin
 * mount, so the canvas is readable) and falls back to 16:9 when it can't.
 *
 * Beyond that the pane has two states: nothing yet, and running. It used to
 * have a third, for a sweep driving the game from inside the app, with the
 * stage glowing and the bot's own session streamed onto it. Playtesting is the
 * agent's business now and runs out of process, so the pane has nothing to say
 * about it. The stream's client half (../../probeStream.ts, ./ProbeStage.tsx)
 * is kept for whatever renders a driven session next.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, GAME_POLL_MS } from '../../store';
import { gameUrl } from '../../api';
import { CapabilityStrip } from './CapabilityStrip';

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
 * Read the game's own shape out of the loaded document: its largest canvas,
 * else the body. Same-origin (the game is served from this server's /game
 * mount), but a cross-origin or not-yet-ready document must never throw into
 * the render path — an unreadable document simply has no shape.
 */
export function measureGameSize(frame: HTMLIFrameElement | null): { width: number; height: number } | null {
  try {
    const doc = frame?.contentDocument;
    if (!doc) return null;
    let best: { width: number; height: number } | null = null;
    for (const canvas of Array.from(doc.querySelectorAll('canvas'))) {
      const width = canvas.width || canvas.clientWidth;
      const height = canvas.height || canvas.clientHeight;
      if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) {
        best = { width, height };
      }
    }
    return best;
  } catch {
    return null; // cross-origin, or the document went away mid-read
  }
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
 */
function GameEmptyState() {
  return (
    <div className="game-empty">
      <div className="game-empty-frame" aria-hidden="true" />
      <p className="game-empty-lead">No game to show yet</p>
      <p className="game-empty-hint">Ask for one. It appears here the moment there is something to run.</p>
    </div>
  );
}

export function GamePane() {
  const projectPath = useApp((s) => s.projectPath);
  const game = useApp((s) => s.game);
  const gameNonce = useApp((s) => s.gameNonce);
  const refreshGame = useApp((s) => s.refreshGame);
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

  // Games commonly size their canvas a frame or two after load (engine boot,
  // a resize handler), so `load` is a first look, not the last word.
  const measure = useCallback(() => {
    setSize(measureGameSize(frameRef.current));
  }, []);

  useEffect(() => {
    setSize(null);
    const timers = [250, 900].map((delay) => window.setTimeout(measure, delay));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [measure, game.entry, gameNonce]);

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

  return (
    <div className="game-pane">
      {game.present && game.entry && projectPath ? (
        <div className="game-stage-wrap">
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
              key={`${game.entry}#${gameNonce}`}
              src={gameUrl(projectPath, game.entry, gameNonce)}
              onLoad={measure}
              sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups allow-same-origin"
            />
          </div>
        </div>
      ) : (
        <GameEmptyState />
      )}
      <CapabilityStrip />
    </div>
  );
}
