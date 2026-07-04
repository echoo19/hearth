/**
 * Scene-wide event bus behind ctx.events — subscription bookkeeping only.
 * Delivery ordering, depth limits, and onEvent hooks are orchestrated by
 * SceneRuntime.emitEvent, which owns entity order and script dispatch.
 * Deterministic: subscription order is insertion order; no wall clock.
 */
export interface GameEventRecord {
  frame: number;
  name: string;
  data?: unknown;
}

export interface EventSubscription {
  id: string;
  ownerId: string;
  name: string;
  fn: (data: unknown) => void;
}

export class EventBus {
  private subs: EventSubscription[] = [];
  private seq = 0;

  on(ownerId: string, name: string, fn: (data: unknown) => void): string {
    const id = `evt_${++this.seq}`;
    this.subs.push({ id, ownerId, name, fn });
    return id;
  }

  off(id: string): void {
    this.subs = this.subs.filter((s) => s.id !== id);
  }

  /** Drop every subscription owned by a destroyed entity. */
  removeOwner(ownerId: string): void {
    this.subs = this.subs.filter((s) => s.ownerId !== ownerId);
  }

  /** Snapshot of current subscribers for `name`, in subscription order. */
  listenersFor(name: string): EventSubscription[] {
    return this.subs.filter((s) => s.name === name);
  }

  /** True when `sub` is still live (not off'd/reaped mid-delivery). */
  isLive(sub: EventSubscription): boolean {
    return this.subs.includes(sub);
  }

  clear(): void {
    this.subs = [];
  }
}
