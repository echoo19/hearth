/**
 * Game tab: mounts the Pixi runtime preview. Degrades gracefully while the
 * @hearth/runtime package (built in parallel) doesn't exist yet.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { setGameView } from '../gameViewRef';
import type { MountedGameView, RuntimeLogEvent } from '../runtimeBridge';

type Status = 'loading' | 'ready' | 'unavailable' | 'error';

function eventMessage(event: RuntimeLogEvent | string | Error): string {
  if (typeof event === 'string') return event;
  if (event instanceof Error) return event.message;
  return event.message ?? JSON.stringify(event);
}

export function GamePreview() {
  const projectPath = useEditor((s) => s.projectPath);
  const sceneId = useEditor((s) => s.sceneId);
  const playing = useEditor((s) => s.playing);
  const paused = useEditor((s) => s.paused);
  const runNonce = useEditor((s) => s.runNonce);
  const debugDraw = useEditor((s) => s.debugDraw);
  const log = useEditor((s) => s.log);
  const recordRuntimeError = useEditor((s) => s.recordRuntimeError);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MountedGameView | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [detail, setDetail] = useState('');
  // Set when a script switches scenes (ctx.scenes.load) during this run.
  const [liveScene, setLiveScene] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = hostRef.current;
    viewRef.current = null;
    setGameView(null);

    if (!projectPath || !sceneId || !container) return;

    setStatus('loading');
    setLiveScene(null);
    container.innerHTML = '';

    void (async () => {
      try {
        // The bridge module is imported lazily; it is the only module that
        // references @hearth/runtime. Availability is decided by whether the
        // import resolves (in a built app the runtime is always bundled in;
        // the old server-side repo check was wrong for packaged installs
        // where no repo checkout exists on disk).
        const bridge = await import('../runtimeBridge').catch(() => null);
        if (!bridge) {
          if (!cancelled) setStatus('unavailable');
          return;
        }
        const view = await bridge.mountGameView({
          container,
          projectPath,
          sceneId,
          autoplay: useEditor.getState().playing,
          onLog: (event) => log('info', 'runtime', eventMessage(event)),
          onError: (event) => log('error', 'runtime', eventMessage(event)),
          // Structured errors (script/line/phase) are recorded for Task 7's
          // clickable diagnostics; onError above still handles the Console line.
          onErrorEntry: (error) => {
            if (!cancelled) recordRuntimeError(error);
          },
          onSceneChange: (sceneName) => {
            if (cancelled) return;
            setLiveScene(sceneName);
            log('info', 'runtime', `scene switched to "${sceneName}"`);
          },
        });
        if (cancelled) {
          view.destroy();
          return;
        }
        viewRef.current = view;
        setGameView(view);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setDetail((err as Error).message);
        log('error', 'runtime', `Preview failed to start: ${(err as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      try {
        viewRef.current?.destroy();
      } catch {
        /* runtime cleanup is best-effort */
      }
      viewRef.current = null;
      setGameView(null);
    };
    // runNonce remounts the view on every Play, so runs always start from the
    // scene as it currently is rather than resuming a stale world.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, sceneId, runNonce]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || status !== 'ready') return;
    try {
      if (playing) view.play();
      else view.pause();
    } catch (err) {
      log('error', 'runtime', `play/pause failed: ${(err as Error).message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, status]);

  // Debug pause (Task 9): freezes the running game without stopping the run.
  // Only meaningful while playing — Stop already froze the view via the
  // effect above, and a fresh Play always starts with paused reset to false.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || status !== 'ready' || !playing) return;
    try {
      if (paused) view.pause();
      else view.play();
    } catch (err) {
      log('error', 'runtime', `pause/resume failed: ${(err as Error).message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, status]);

  // debugDraw resets to false in the store whenever the view remounts (new
  // Play, scene switch); this effect just keeps the live view in sync with
  // the Toolbar's toggle while mounted.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || status !== 'ready') return;
    try {
      view.setDebugDraw?.(debugDraw);
    } catch (err) {
      log('error', 'runtime', `debug draw toggle failed: ${(err as Error).message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugDraw, status]);

  return (
    <div className="game-preview">
      {liveScene && status === 'ready' && (
        <div className="game-preview-scene" title="Current scene (switched by a script)">
          {liveScene}
        </div>
      )}
      <div ref={hostRef} className="game-canvas-host" />
      {status !== 'ready' && (
        <div className="empty-state" style={{ position: 'absolute', inset: 0 }}>
          {status === 'loading' && <span>Starting the game preview…</span>}
          {status === 'unavailable' && (
            <>
              <span>Runtime package not built yet</span>
              <span className="hint">
                The Game preview needs @hearth/runtime, which is still being built. Run{' '}
                <code>npm run build:packages</code> (or wait for the runtime to land), then reopen this tab. The
                Scene tab works without it.
              </span>
            </>
          )}
          {status === 'error' && (
            <>
              <span>The preview could not start</span>
              <span className="hint">{detail}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
