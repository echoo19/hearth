/**
 * The running playtest's picture, on its way to the game stage.
 *
 * The probe plays in its own headless browser (server/probeSweep.ts says why),
 * so for a while the pane glowed around a game that was standing perfectly
 * still: the app claimed something was playing and showed nothing playing. The
 * server now streams the probe's page over its own socket, and this is the
 * client end of it.
 *
 * Module state rather than the app store, deliberately, for the same reason
 * toast.ts is: this is display state with a clock on it, nothing persists it,
 * and at ten frames a second it would re-render the entire window if it lived
 * anywhere the rest of the app subscribes to. The status is a small value that
 * changes a handful of times per sweep and is safe to render; the frames
 * themselves never reach React at all, they go straight to an <img> element
 * that subscribes to them by hand.
 */

/**
 * `off`      no sweep, or the picture is over: the stage shows your own game.
 * `starting` a sweep is up and the browser is still coming alive.
 * `hidden`   long enough that there is honestly no picture coming. The sweep
 *            is still running, somewhere you cannot see it, and the stage says
 *            so rather than implying the still game on it is being played.
 * `live`     frames are arriving. The stage is showing the probe's session.
 */
export type ProbeStreamStatus = 'off' | 'starting' | 'hidden' | 'live';

/**
 * How long a sweep may go without a frame before the app stops implying one is
 * coming. Chromium takes a second or two to launch, so this is patient enough
 * to cover a normal start and short enough that a machine with no working
 * browser is not left waiting on a promise nothing will keep.
 */
export const PROBE_FRAME_GRACE_MS = 5000;
/** How long to wait before retrying a socket that dropped mid-sweep. */
const RETRY_MS = 1000;

type StatusListener = () => void;
type FrameListener = (data: string) => void;

let status: ProbeStreamStatus = 'off';
let latest: string | null = null;
const statusListeners = new Set<StatusListener>();
const frameListeners = new Set<FrameListener>();

let socket: WebSocket | null = null;
let project: string | null = null;
let graceTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * How many mounted surfaces want the picture. Two can: the game pane and the
 * playtest screen, and the app swaps one for the other in a single commit —
 * the leaving one's cleanup runs BEFORE the arriving one's effect. Counting
 * rather than closing on the first goodbye is what stops that swap tearing
 * down a live socket and re-arming the five-second grace on the way back.
 */
let viewers = 0;

function setStatus(next: ProbeStreamStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener();
}

function clearTimers(): void {
  if (graceTimer) clearTimeout(graceTimer);
  if (retryTimer) clearTimeout(retryTimer);
  graceTimer = null;
  retryTimer = null;
}

function streamUrl(root: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/probe/stream?project=${encodeURIComponent(root)}`;
}

function connect(): void {
  if (!project) return;
  const ws = new WebSocket(streamUrl(project));
  socket = ws;
  ws.onmessage = (event) => {
    if (socket !== ws) return;
    let frame: { type?: string; data?: string };
    try {
      frame = JSON.parse(event.data as string) as { type?: string; data?: string };
    } catch {
      return;
    }
    if (frame.type === 'probe-frame' && typeof frame.data === 'string') {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      latest = frame.data;
      setStatus('live');
      for (const listener of frameListeners) listener(frame.data);
      return;
    }
    if (frame.type === 'probe-end') {
      // The run is over. Said explicitly rather than inferred from frames
      // stopping, so the stage hands the pane back to your own game at the
      // moment it stops being a lie to do so.
      //
      // The viewer count is left alone: the surfaces watching are still
      // mounted and still want the next sweep's picture. This ends the
      // stream, it does not end their interest in one.
      teardown();
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    // A drop under a live sweep is a connection problem, not the end of the
    // run: the sweep is still going and the frames still exist. Try again,
    // and keep whatever the stage is showing in the meantime.
    if (project && !retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, RETRY_MS);
    }
  };
}

/**
 * Start watching `root`'s running sweep. Idempotent: asking twice for the same
 * folder keeps the one connection.
 */
export function openProbeStream(root: string): void {
  viewers++;
  if (project === root && socket) return;
  teardown();
  project = root;
  latest = null;
  setStatus('starting');
  graceTimer = setTimeout(() => {
    graceTimer = null;
    // Nothing has arrived. Whatever the reason (no Chromium on this machine,
    // a browser without a usable CDP session), the honest thing is to stop
    // suggesting a picture is on its way.
    if (status === 'starting') setStatus('hidden');
  }, PROBE_FRAME_GRACE_MS);
  connect();
}

/** One watcher is done. The picture only stops when the last one is. */
export function closeProbeStream(): void {
  viewers = Math.max(0, viewers - 1);
  if (viewers > 0) return;
  teardown();
}

/** Drop the connection and everything it was showing. */
function teardown(): void {
  clearTimers();
  project = null;
  const ws = socket;
  socket = null;
  if (ws) {
    ws.onmessage = null;
    ws.onclose = null;
    ws.close();
  }
  latest = null;
  setStatus('off');
}

export function subscribeProbeStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function probeStreamStatus(): ProbeStreamStatus {
  return status;
}

/**
 * Every frame as it arrives, outside React. The last one is NOT replayed on
 * subscribe: callers paint `latestProbeFrame()` themselves when they mount,
 * which keeps this callback meaning exactly "a new frame".
 */
export function subscribeProbeFrames(listener: FrameListener): () => void {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

export function latestProbeFrame(): string | null {
  return latest;
}

/** What an <img> shows a frame through. */
export function probeFrameSrc(data: string): string {
  return `data:image/jpeg;base64,${data}`;
}

/** Test seam: drop the connection and every listener between cases. */
export function resetProbeStream(): void {
  viewers = 0;
  teardown();
  statusListeners.clear();
  frameListeners.clear();
}
