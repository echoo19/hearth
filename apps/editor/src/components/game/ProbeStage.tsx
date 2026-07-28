/**
 * What the tester is looking at, drawn onto a stage while it plays.
 *
 * The tester cannot play the game in the pane. That session belongs to whoever
 * is sitting here, and taking its keys away mid-sentence is not a thing an app
 * gets to do. So it plays in a browser of its own and sends back pictures of it
 * (server/probeStream.ts), and this puts them on screen.
 *
 * Frames never pass through React. Ten re-renders a second of a picture this
 * size would be felt everywhere in the window, so the <img> subscribes to the
 * frame stream by hand and assigns its own `src`, the same shape the terminal
 * uses for pty output. Only the status, which changes a few times a session,
 * renders.
 *
 * The note is the honest half. A picture that has not arrived must not be
 * implied by a frame around a game standing still, so when there is no stream
 * the note says where the tester actually is instead.
 */
import React, { useEffect, useRef } from 'react';
import {
  latestProbeFrame,
  probeFrameSrc,
  subscribeProbeFrames,
  type ProbeStreamStatus,
} from '../../probeStream';

/**
 * The line that names whose game this is. Pure, because it is the whole honesty
 * contract: `live` is the only state allowed to say the stage is the tester's,
 * and no state is allowed to say nothing at all while a session runs.
 */
export function probeNote(status: ProbeStreamStatus): string | null {
  switch (status) {
    case 'live':
      return 'Your tester is playing';
    case 'starting':
      return 'Opening the game';
    case 'hidden':
      return 'Your tester is playing off screen';
    default:
      return null;
  }
}

/**
 * Which note a stage should carry, given what the app believes.
 *
 * The two clocks do not tick together: the stream closes the moment the session
 * ends, and the app learns the session is over a beat later. In between, the app
 * still believes a session is running with no stream behind it, which is
 * precisely the state that started all this. So the app's own belief is enough
 * to say the tester is off somewhere, whether that is because it has not sent a
 * picture yet or because it has stopped sending them.
 */
export function stageNoteStatus(status: ProbeStreamStatus, testerRunning: boolean): ProbeStreamStatus {
  return status === 'off' && testerRunning ? 'hidden' : status;
}

/**
 * One transparent pixel, so the element is never an <img> without a `src`.
 * A source-less image renders its alt text at full size across the stage, which
 * reads as a broken picture rather than as one that has not arrived yet, and
 * the browser takes a second or two to start the stream every session.
 */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** The stream itself. Mounted for as long as a session is being watched. */
export function ProbeFrames() {
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    // Whatever arrived before this mounted: without it a remount (a stage
    // resize, a tab return) would show black until the next frame.
    const first = latestProbeFrame();
    img.src = first ? probeFrameSrc(first) : BLANK;
    return subscribeProbeFrames((data) => {
      img.src = probeFrameSrc(data);
    });
  }, []);

  return (
    <img
      ref={imgRef}
      className="probe-frame"
      // Letterboxed inside the stage rather than fitted to it: the tester's
      // browser has its own viewport, and stretching its picture onto a stage
      // shaped for the game's canvas would be a second lie about what is on
      // screen.
      alt="The game as the tester is playing it"
    />
  );
}

/** The corner note. Small, static, and never absent while a session is up. */
export function ProbeNote({ status }: { status: ProbeStreamStatus }) {
  const note = probeNote(status);
  if (!note) return null;
  return (
    <div className={`probe-note${status === 'live' ? ' is-live' : ''}`}>
      <span className="probe-note-dot" aria-hidden="true" />
      {note}
    </div>
  );
}
