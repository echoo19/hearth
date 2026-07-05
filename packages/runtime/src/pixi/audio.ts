/**
 * Web Audio playback for the pixi host.
 *
 * SFX buffers are fetched + decoded once per asset and cached. Each playback
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
 *
 * Music is a separate channel and streams instead of decoding: a single
 * `<audio>` element (`document.createElement('audio')`, no fallback) feeds
 * `ctx.createMediaElementSource` into its own gain node, never
 * `decodeAudioData` — tracks can be long, so decoding the whole thing up
 * front would be wasteful. Only one music track plays at a time; replacing
 * it crossfades (old ramps out over the new call's fadeIn, new ramps in over
 * the same span). While the context is suspended, at most one queued music
 * request is kept — the latest always wins and it is never dropped as stale
 * (unlike one-shot SFX), because losing the track a scene just asked for
 * would be far more noticeable than losing a one-shot.
 */
import type { AudioPlaybackEvent } from '../runtime.js';

export interface WebAudioPlayOptions {
  volume: number;
  loop: boolean;
}

/** Options for `playMusic` — same shape as `AudioPlaybackEvent`'s music play fields. */
export interface WebAudioMusicOptions {
  volume: number;
  loop: boolean;
  fadeIn: number;
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

/** A music play requested while the AudioContext was still suspended. */
export interface PendingMusicPlay {
  handleId: string;
  assetId: string;
  volume: number;
  loop: boolean;
  fadeIn: number;
}

/**
 * The single queued-music slot: latest request always wins. Unlike
 * `playsToStartOnResume`, there is no staleness check — a queued music
 * request always starts on unlock, however long it waited. Pure — exported
 * for headless tests.
 */
export function latestPendingMusic(
  _current: PendingMusicPlay | null,
  incoming: PendingMusicPlay,
): PendingMusicPlay {
  return incoming;
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

/** The subset of `WebAudioPlayer` that `routeAudioEvent` dispatches to. */
export interface AudioPlaybackTarget {
  play(handleId: string, assetId: string, opts: WebAudioPlayOptions): void;
  stop(handleId: string): void;
  playMusic(handleId: string, assetId: string, opts: WebAudioMusicOptions): void;
  stopMusic(opts: { fadeOut: number }): void;
  setMusicVolume(volume: number, fade: number): void;
}

/**
 * Routes one `AudioPlaybackEvent` from a `SceneRuntime`/`GameSession` to the
 * right `WebAudioPlayer` method. Pure dispatch — exported so the wiring can
 * be tested headlessly with a fake `AudioPlaybackTarget`, without a real
 * AudioContext.
 */
export function routeAudioEvent(e: AudioPlaybackEvent, audio: AudioPlaybackTarget): void {
  if (e.action === 'music-volume') {
    audio.setMusicVolume(e.volume, e.fade ?? 0);
    return;
  }
  if (e.music) {
    if (e.action === 'play') {
      audio.playMusic(e.handleId, e.assetId, { volume: e.volume, loop: e.loop, fadeIn: e.fadeIn ?? 0 });
    } else {
      audio.stopMusic({ fadeOut: e.fadeOut ?? 0 });
    }
    return;
  }
  if (e.action === 'play') audio.play(e.handleId, e.assetId, { volume: e.volume, loop: e.loop });
  else audio.stop(e.handleId);
}

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

export class WebAudioPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private active = new Map<string, ActivePlayback>();
  private pending: PendingPlay[] = [];
  private pendingMusic: PendingMusicPlay | null = null;
  private musicEl: HTMLAudioElement | null = null;
  private musicSource: MediaElementAudioSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private musicReleases = new Set<{ timer: ReturnType<typeof setTimeout>; finish: () => void }>();
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

  /** True when streamed `<audio>` playback is available (music channel). */
  static musicSupported(): boolean {
    return typeof (globalThis as { Audio?: unknown }).Audio === 'function';
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

  /**
   * Replace the current music track (if any). The outgoing track fades out
   * over this call's `fadeIn` while the incoming one ramps in over the same
   * span (both immediate when `fadeIn` is 0). While the context is
   * suspended the request is queued — latest always wins, never dropped.
   */
  playMusic(handleId: string, assetId: string, opts: WebAudioMusicOptions): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.destroyed || !WebAudioPlayer.musicSupported()) return;
    if (ctx.state === 'suspended') {
      this.pendingMusic = latestPendingMusic(this.pendingMusic, {
        handleId,
        assetId,
        volume: opts.volume,
        loop: opts.loop,
        fadeIn: opts.fadeIn,
      });
      return;
    }
    this.startMusic(handleId, assetId, opts);
  }

  /** Fade out (or stop immediately) and release the current music track. */
  stopMusic(opts: { fadeOut: number }): void {
    if (this.destroyed || !WebAudioPlayer.musicSupported()) return;
    this.pendingMusic = null;
    this.releaseMusic(opts.fadeOut);
  }

  /** Ramp (or set) the music channel's volume. No-op if nothing is playing. */
  setMusicVolume(volume: number, fade: number): void {
    if (this.destroyed || !WebAudioPlayer.musicSupported()) return;
    if (!this.musicGain) return;
    this.fadeGain(this.musicGain, volume, fade);
  }

  /** Master stop: silence and drop every active and queued playback. */
  stopAll(): void {
    this.pending = [];
    for (const handleId of [...this.active.keys()]) this.stop(handleId);
    this.pendingMusic = null;
    this.killMusicReleases();
    this.releaseMusic(0);
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
    if (this.destroyed) return;
    if (this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const p of playsToStartOnResume(queued, performance.now())) {
        this.startPlayback(p.handleId, p.assetId, { volume: p.volume, loop: p.loop });
      }
    }
    if (this.pendingMusic) {
      const m = this.pendingMusic;
      this.pendingMusic = null;
      this.startMusic(m.handleId, m.assetId, { volume: m.volume, loop: m.loop, fadeIn: m.fadeIn });
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

  /**
   * Start streaming `assetId` as the music track, replacing (and fading
   * out) whatever was already playing. `handleId` is accepted for parity
   * with `play()`/host-side bookkeeping; the channel itself only ever
   * tracks one track at a time.
   */
  private startMusic(_handleId: string, assetId: string, opts: WebAudioMusicOptions): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.destroyed) return;
    const url = this.resolveUrl(assetId);
    if (!url) {
      this.onWarn?.(`audio: no URL for music asset ${assetId}`);
      return;
    }

    this.releaseMusic(opts.fadeIn);

    const el = document.createElement('audio');
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.loop = opts.loop;
    el.src = url;

    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(this.master);
    if (opts.fadeIn > 0) gain.gain.value = 0;
    this.fadeGain(gain, opts.volume, opts.fadeIn);

    this.musicEl = el;
    this.musicSource = source;
    this.musicGain = gain;

    el.play().catch((err) => {
      if (this.musicEl !== el) return; // already superseded
      this.onWarn?.(`audio: failed to play music ${assetId}: ${(err as Error).message}`);
      this.musicEl = null;
      this.musicSource = null;
      this.musicGain = null;
      el.src = '';
      source.disconnect();
      gain.disconnect();
    });
  }

  /** Fade out (or stop immediately) and detach the current music track, if any. */
  private releaseMusic(fadeOutSeconds: number): void {
    const el = this.musicEl;
    const gain = this.musicGain;
    const source = this.musicSource;
    if (!el || !gain || !source) return;
    this.musicEl = null;
    this.musicGain = null;
    this.musicSource = null;
    this.fadeGain(gain, 0, fadeOutSeconds);
    this.scheduleMusicRelease(() => {
      el.pause();
      el.src = '';
      source.disconnect();
      gain.disconnect();
    }, fadeOutSeconds);
  }

  /** Runs `finish` after `seconds` (immediately when 0), tracked so destroy/stopAll can flush it. */
  private scheduleMusicRelease(finish: () => void, seconds: number): void {
    if (seconds <= 0) {
      finish();
      return;
    }
    const entry: { timer: ReturnType<typeof setTimeout>; finish: () => void } = {
      timer: setTimeout(() => {
        this.musicReleases.delete(entry);
        finish();
      }, seconds * 1000),
      finish,
    };
    this.musicReleases.add(entry);
  }

  /** Cancel every pending fade-out release timer, running its cleanup now. */
  private killMusicReleases(): void {
    for (const entry of this.musicReleases) {
      clearTimeout(entry.timer);
      entry.finish();
    }
    this.musicReleases.clear();
  }

  /** `setValueAtTime(current, now)` then `linearRampToValueAtTime(target, now + seconds)`; set directly when `seconds` is 0. */
  private fadeGain(gain: GainNode, target: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (seconds > 0) {
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(target, ctx.currentTime + seconds);
    } else {
      gain.gain.value = target;
    }
  }
}
