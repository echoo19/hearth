/**
 * Game tab: mounts the Pixi runtime preview. Degrades gracefully while the
 * @hearth/runtime package (built in parallel) doesn't exist yet.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
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
  const runNonce = useEditor((s) => s.runNonce);
  const log = useEditor((s) => s.log);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MountedGameView | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    let cancelled = false;
    const container = hostRef.current;
    viewRef.current = null;

    if (!projectPath || !sceneId || !container) return;

    setStatus('loading');
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
        });
        if (cancelled) {
          view.destroy();
          return;
        }
        viewRef.current = view;
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

  return (
    <div className="game-preview">
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
