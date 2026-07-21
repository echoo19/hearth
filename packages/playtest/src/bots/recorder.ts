/**
 * InputRecorder — the single choke point every bot input flows through.
 *
 * Each call both APPLIES the input to the live runtime (setActionDown/Up,
 * setAxis, sendPointer) AND logs an InputEvent tagged with the current frame.
 * Policies receive only a recorder (never the raw InputState), so the recorded
 * timeline is a faithful, replayable transcript of everything the bot did —
 * which is exactly what makes the later bake step exact.
 *
 * The runtime is resolved fresh on every apply: a scene switch replaces
 * `session.runtime`, so caching it would leave the recorder driving a dead
 * runtime after a switch.
 */
import type { GameSession } from '@hearth/runtime';
import type { InputEvent } from './types.js';

export class InputRecorder {
  private readonly log: InputEvent[] = [];
  private frame = 0;

  constructor(private readonly session: GameSession) {}

  /** Set by the run loop before each policy.onFrame — the frame these inputs apply on. */
  setFrame(frame: number): void {
    this.frame = frame;
  }

  /** Press (down=true) or release (down=false) a named digital action. */
  action(action: string, down: boolean): void {
    const input = this.session.runtime.input;
    if (down) input.setActionDown(action);
    else input.setActionUp(action);
    this.log.push({ frame: this.frame, kind: 'action', action, down });
  }

  /** Set a sticky virtual-axis override in [-1, 1]. */
  axis(axis: string, value: number): void {
    this.session.runtime.input.setAxis(axis, value);
    this.log.push({ frame: this.frame, kind: 'axis', axis, value });
  }

  /**
   * Send a pointer event in screen coordinates. `button` 'down'/'up' drives the
   * primary button held-state; omitted is a plain move.
   */
  pointer(x: number, y: number, button?: 'down' | 'up'): void {
    const kind = button === 'down' ? 'down' : button === 'up' ? 'up' : 'move';
    this.session.runtime.sendPointer(x, y, kind);
    this.log.push({ frame: this.frame, kind: 'pointer', x, y, ...(button ? { button } : {}) });
  }

  /** The recorded timeline, in application order. */
  get events(): InputEvent[] {
    return this.log;
  }
}
