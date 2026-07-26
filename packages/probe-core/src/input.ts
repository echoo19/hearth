/**
 * The input surface a policy is allowed to touch.
 *
 * Policies never call the game directly: they push mutations into a queue that
 * the sweep drains and applies (the contract's input methods are async; a
 * policy decision must stay synchronous and pure so it can be replayed and
 * unit-tested without a game at all). The queue doubles as the run's input
 * timeline — the record that makes a failing seed reproducible.
 */
import type { PointerKind } from './contract.js';

/** One input change a policy asked for, tagged with the step it was decided on. */
export type InputMutation =
  | { kind: 'action'; action: string; down: boolean }
  | { kind: 'axis'; axis: string; value: number }
  | { kind: 'pointer'; x: number; y: number; pointer: PointerKind };

export type TimedInput = InputMutation & { frame: number };

/** What a policy writes to. Implemented by InputQueue; kept narrow for tests. */
export interface InputSink {
  action(name: string, down: boolean): void;
  axis(name: string, value: number): void;
  pointer(x: number, y: number, kind: PointerKind): void;
}

/** Collects a step's input decisions in order, tagged with the step index. */
export class InputQueue implements InputSink {
  readonly events: TimedInput[] = [];
  private frame = 0;
  private pending: InputMutation[] = [];

  setFrame(frame: number): void {
    this.frame = frame;
  }

  action(name: string, down: boolean): void {
    this.push({ kind: 'action', action: name, down });
  }

  axis(name: string, value: number): void {
    this.push({ kind: 'axis', axis: name, value });
  }

  pointer(x: number, y: number, kind: PointerKind): void {
    this.push({ kind: 'pointer', x, y, pointer: kind });
  }

  /** Take everything decided since the last drain (the sweep applies these). */
  drain(): InputMutation[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private push(mutation: InputMutation): void {
    this.pending.push(mutation);
    this.events.push({ ...mutation, frame: this.frame });
  }
}
