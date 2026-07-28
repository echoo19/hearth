/**
 * What the playtest bot is looking at, drawn over the stage while it plays.
 *
 * The bot cannot play the game in the pane. That session belongs to whoever is
 * sitting here, and taking its keys away mid-sentence is not a thing an app
 * gets to do. So the sweep runs in its own browser and sends back pictures of
 * it (server/probeStream.ts), and this puts them where the game already is.
 *
 * Frames never pass through React. Ten re-renders a second of a pane this size
 * would be felt everywhere in the window, so the <img> subscribes to the frame
 * stream by hand and assigns its own `src`, the same shape the terminal uses
 * for pty output. Only the status, which changes a few times a sweep, renders.
 *
 * The note is the honest half. A picture that has not arrived must not be
 * implied by a glowing frame around a game standing still, so when there is no
 * stream the note says where the bot actually is instead.
 */
import React, { useEffect, useRef } from 'react';
import {
  latestProbeFrame,
  probeFrameSrc,
  subscribeProbeFrames,
  type ProbeStreamStatus,
} from '../../probeStream';

/**
 * The line that names whose game this is. Pure, because it is the whole
 * honesty contract: `live` is the only state allowed to say the stage is the
 * bot's, and no state is allowed to say nothing at all while a sweep runs.
 */
export function probeNote(status: ProbeStreamStatus): string | null {
  switch (status) {
    case 'live':
      return "The bot's view";
    case 'starting':
      return 'Starting the bot';
    case 'hidden':
      return 'Bot is playing off screen';
    default:
      return null;
  }
}

/**
 * Which note a stage wearing the ember ring should carry.
 *
 * The two clocks do not tick together: the stream closes the moment the run
 * ends, and the app learns the sweep is over a beat later (or, when a sweep
 * dies without writing its last journal line, a poll later). In between, the
 * ring is up with no stream behind it, which is precisely the state that
 * started all this. So the app's own belief that a sweep is running is enough
 * to say the bot is off somewhere, whether that is because it has not sent a
 * picture yet or because it has stopped sending them.
 */
export function stageNoteStatus(status: ProbeStreamStatus, sweepRunning: boolean): ProbeStreamStatus {
  return status === 'off' && sweepRunning ? 'hidden' : status;
}

/** The stream itself. Mounted only while frames are actually arriving. */
export function ProbeFrames() {
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    // Whatever arrived before this mounted: without it a remount (a stage
    // resize, a tab return) would show black until the next frame.
    const first = latestProbeFrame();
    if (first) img.src = probeFrameSrc(first);
    return subscribeProbeFrames((data) => {
      img.src = probeFrameSrc(data);
    });
  }, []);

  return (
    <img
      ref={imgRef}
      className="probe-frame"
      // Letterboxed inside the stage rather than fitted to it: the probe's
      // browser has its own viewport, and stretching its picture onto a stage
      // shaped for the game's canvas would be a second lie about what is on
      // screen.
      alt="The game as the playtest bot is playing it"
    />
  );
}

/** The corner note. Small, static, and never absent while a sweep is up. */
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
