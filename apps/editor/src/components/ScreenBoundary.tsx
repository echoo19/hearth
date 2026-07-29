/**
 * The last thing standing between one bad row and a white window.
 *
 * WHY THIS EXISTS. A tester note in `.hearth/tester/sessions/` that was missing
 * `onTheChange` made the history row read `undefined.verdict` during render.
 * React has no default handling for a throw during render: it unmounts the
 * whole tree. The app went blank, stayed blank across a reload, and only came
 * back when the file was deleted, which a person who is looking at a white
 * window has no way of knowing. The folder is documented as hand-editable and
 * meant to be committed, so it is a file people will produce.
 *
 * That particular note is fixed where it is read (server/tester/memory.ts), and
 * this exists so the NEXT one is a panel instead of a blank window. It is
 * deliberately dumb: no retry loop, no error reporting, no attempt to guess
 * what broke. It says what happened, gives a way back, and keeps the rest of
 * the window alive.
 *
 * A class, because componentDidCatch has no hook equivalent.
 */
import React from 'react';

interface Props {
  /** What this boundary is wrapped around, in the words the person uses for it. */
  surface: string;
  /** Offered when there is somewhere to go that is not the broken surface. */
  onLeave?: () => void;
  children: React.ReactNode;
}

interface State {
  message: string | null;
}

export class ScreenBoundary extends React.Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { message: message.trim() === '' ? 'Something threw while it was being drawn.' : message };
  }

  componentDidCatch(error: unknown): void {
    // The console is where the app's own failures already go, and a person
    // reading a broken panel deserves the same line an agent failure gets.
    // Reached through the global rather than the store, so a boundary is never
    // the thing that pulls the store into a module that has just crashed.
    console.error('[hearth]', this.props.surface, error);
  }

  render(): React.ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;
    // `.empty-state` and `.hint` rather than a class family of its own: this is
    // the app's existing "there is nothing to show you here" shape, it is
    // styled app-wide already, and a boundary that needs its own stylesheet is
    // a boundary that can fail to load on the day it is needed.
    return (
      <div className="empty-state" role="alert">
        <span>{this.props.surface} could not be drawn.</span>
        {/* The message verbatim. Rewording it would cost the one person who can
            act on it the one detail that says what to act on. */}
        <span className="hint">{message}</span>
        <span className="hint">
          The rest of Hearth is still running. Reloading the window usually clears it, and if it comes
          back in the same place, whatever this surface reads is what to look at.
        </span>
        {this.props.onLeave && (
          <button
            type="button"
            className="btn"
            // Leaving AND forgetting, in that order. A boundary holds its error
            // until something clears it, so a button that only called `onLeave`
            // left the same panel on screen however many times it was pressed:
            // the surface underneath had changed and the reader could not tell,
            // which is the dead end this panel exists to avoid. Clearing draws
            // the children again; if the new surface throws too, this comes
            // straight back with the new message, which is the honest answer.
            onClick={() => {
              this.props.onLeave?.();
              this.setState({ message: null });
            }}
          >
            Go back
          </button>
        )}
      </div>
    );
  }
}
