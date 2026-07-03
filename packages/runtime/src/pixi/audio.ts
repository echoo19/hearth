/**
 * Web Audio playback for the pixi host.
 *
 * Buffers are fetched + decoded once per asset and cached. Each playback
 * gets its own gain node (volume/loop) routed through a master gain, so
 * stopping the runtime can silence everything at once.
 *
 * Silent audio unlock: the AudioContext is created up front. Browsers start
 * it suspended until a user gesture, so one-time window listeners
 * (pointerdown / keydown / touchstart) resume it on the first natural input
 * — no visible UI, ever. Plays issued while suspended are queued: on resume,
 * loops (music) start from the beginning and one-shot SFX older than ~0.5s
 * are dropped instead of bursting all at once. Queue age uses wall-clock
 * time (performance.now); this is presentation-side only, never simulation.
 */

export interface WebAudioPlayOptions {
  volume: number;
  loop: boolean;
}

interface ActivePlayback {
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  stopped: boolean;
}

/** A play requested while the AudioContext was still suspended. */
export interface PendingPlay {
  handleId: string;
  assetId: string;
  volume: number;
  loop: boolean;
  /** performance.now() when the play was requested. */
  issuedAt: number;
}

/** One-shot SFX queued longer than this before unlock are dropped. */
export const PENDING_ONESHOT_MAX_AGE_MS = 500;

/**
 * Which queued plays should actually start once the context resumes:
 * loops always (from position 0); one-shots only when still fresh.
 * Pure — exported for headless tests.
 */
export function playsToStartOnResume(pending: readonly PendingPlay[], now: number): PendingPlay[] {
  return pending.filter((p) => p.loop || now - p.issuedAt <= PENDING_ONESHOT_MAX_AGE_MS);
}

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private active = new Map<string, ActivePlayback>();
  private pending: PendingPlay[] = [];
  private unlockFn: (() => void) | null = null;
  private destroyed = false;

  constructor(
    /** Maps an asset id to a fetchable URL (or null when unknown). */
    private readonly resolveUrl: (assetId: string) => string | null,
    private readonly onWarn?: (message: string) => void,
  ) {
    if (!WebAudioPlayer.supported()) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') this.armUnlock();
  }

  /** True when Web Audio is available in this environment. */
  static supported(): boolean {
    return typeof (globalThis as { AudioContext?: unknown }).AudioContext === 'function';
  }

  play(handleId: string, assetId: string, opts: WebAudioPlayOptions): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.destroyed) return;
    if (ctx.state === 'suspended') {
      // Queue for the unlock; start decoding now so resume is instant.
      this.pending.push({
        handleId,
        assetId,
        volume: opts.volume,
        loop: opts.loop,
        issuedAt: performance.now(),
      });
      void this.loadBuffer(ctx, assetId);
      return;
    }
    this.startPlayback(handleId, assetId, opts);
  }

  stop(handleId: string): void {
    const queued = this.pending.findIndex((p) => p.handleId === handleId);
    if (queued !== -1) {
      this.pending.splice(queued, 1);
      return;
    }
    const playback = this.active.get(handleId);
    if (!playback) return;
    playback.stopped = true;
    try {
      playback.source?.stop();
    } catch {
      // already stopped
    }
    this.cleanup(handleId, playback);
  }

  /** Master stop: silence and drop every active and queued playback. */
  stopAll(): void {
    this.pending = [];
    for (const handleId of [...this.active.keys()]) this.stop(handleId);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopAll();
    this.disarmUnlock();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.buffers.clear();
  }

  // ---------------------------------------------------------------------------

  /** One-time, invisible unlock on the first natural user input. */
  private armUnlock(): void {
    if (this.unlockFn || typeof window === 'undefined') return;
    this.unlockFn = () => {
      this.disarmUnlock();
      void this.ctx
        ?.resume()
        .then(() => this.flushPending())
        .catch(() => {});
    };
    for (const type of UNLOCK_EVENTS) window.addEventListener(type, this.unlockFn);
    // Some browsers resume contexts on their own (e.g. after a same-page
    // gesture elsewhere); flush the queue whenever the context comes alive.
    this.ctx?.addEventListener('statechange', () => {
      if (this.ctx?.state === 'running') this.flushPending();
    });
  }

  private disarmUnlock(): void {
    if (!this.unlockFn || typeof window === 'undefined') return;
    for (const type of UNLOCK_EVENTS) window.removeEventListener(type, this.unlockFn);
    this.unlockFn = null;
  }

  private flushPending(): void {
    if (this.destroyed || this.pending.length === 0) return;
    const queued = this.pending;
    this.pending = [];
    for (const p of playsToStartOnResume(queued, performance.now())) {
      this.startPlayback(p.handleId, p.assetId, { volume: p.volume, loop: p.loop });
    }
  }

  private startPlayback(handleId: string, assetId: string, opts: WebAudioPlayOptions): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.destroyed) return;
    const playback: ActivePlayback = { gain: ctx.createGain(), source: null, stopped: false };
    playback.gain.gain.value = opts.volume;
    playback.gain.connect(this.master);
    this.active.set(handleId, playback);
    void this.loadBuffer(ctx, assetId).then((buffer) => {
      if (!buffer || playback.stopped || this.destroyed) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = opts.loop;
      source.connect(playback.gain);
      source.onended = () => this.cleanup(handleId, playback);
      playback.source = source;
      source.start();
    });
  }

  private loadBuffer(ctx: AudioContext, assetId: string): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(assetId);
    if (!pending) {
      pending = (async () => {
        const url = this.resolveUrl(assetId);
        if (!url) {
          this.onWarn?.(`audio: no URL for asset ${assetId}`);
          return null;
        }
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          return await ctx.decodeAudioData(bytes);
        } catch (err) {
          this.onWarn?.(`audio: failed to load asset ${assetId}: ${(err as Error).message}`);
          return null;
        }
      })();
      this.buffers.set(assetId, pending);
    }
    return pending;
  }

  private cleanup(handleId: string, playback: ActivePlayback): void {
    if (this.active.get(handleId) !== playback) return;
    playback.gain.disconnect();
    this.active.delete(handleId);
  }
}
