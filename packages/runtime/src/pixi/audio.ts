/**
 * Web Audio playback for the pixi host.
 *
 * Buffers are fetched + decoded once per asset and cached. Each playback
 * gets its own gain node (volume/loop) routed through a master gain, so
 * stopping the runtime can silence everything at once. The AudioContext is
 * created lazily and resumed on the first user gesture (pointerdown or
 * keydown) to satisfy browser autoplay policy.
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

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private active = new Map<string, ActivePlayback>();
  private resumeFn: (() => void) | null = null;
  private destroyed = false;

  constructor(
    /** Maps an asset id to a fetchable URL (or null when unknown). */
    private readonly resolveUrl: (assetId: string) => string | null,
    private readonly onWarn?: (message: string) => void,
  ) {}

  /** True when Web Audio is available in this environment. */
  static supported(): boolean {
    return typeof (globalThis as { AudioContext?: unknown }).AudioContext === 'function';
  }

  play(handleId: string, assetId: string, opts: WebAudioPlayOptions): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;
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

  stop(handleId: string): void {
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

  /** Master stop: silence and drop every active playback. */
  stopAll(): void {
    for (const handleId of [...this.active.keys()]) this.stop(handleId);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopAll();
    if (this.resumeFn) {
      window.removeEventListener('pointerdown', this.resumeFn);
      window.removeEventListener('keydown', this.resumeFn);
      this.resumeFn = null;
    }
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.buffers.clear();
  }

  // ---------------------------------------------------------------------------

  private ensureContext(): AudioContext | null {
    if (this.destroyed) return null;
    if (this.ctx) return this.ctx;
    if (!WebAudioPlayer.supported()) return null;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    // Autoplay policy: contexts created without a gesture start suspended.
    this.resumeFn = () => {
      void this.ctx?.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', this.resumeFn);
    window.addEventListener('keydown', this.resumeFn);
    return this.ctx;
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
