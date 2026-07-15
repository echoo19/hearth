/**
 * Silent audio unlock queueing policy (pure logic; the WebAudioPlayer
 * itself needs a real AudioContext and is exercised in the browser), plus
 * host suspend/resume semantics against a stubbed AudioContext + `<audio>`
 * element (review I1: pause must actually halt audio).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AudioPlaybackEvent } from '@hearth/runtime';
import {
  PENDING_ONESHOT_MAX_AGE_MS,
  playsToStartOnResume,
  latestPendingMusic,
  routeAudioEvent,
  WebAudioPlayer,
  type PendingPlay,
  type PendingMusicPlay,
  type AudioPlaybackTarget,
} from '../src/pixi/audio.js';

function play(overrides: Partial<PendingPlay>): PendingPlay {
  return { handleId: 'snd_1', assetId: 'ast_a', volume: 1, loop: false, issuedAt: 0, ...overrides };
}

describe('playsToStartOnResume', () => {
  it('always starts queued loops, however old (music starts from 0)', () => {
    const pending = [play({ handleId: 'snd_1', loop: true, issuedAt: 0 })];
    expect(playsToStartOnResume(pending, 60_000).map((p) => p.handleId)).toEqual(['snd_1']);
  });

  it('starts one-shots still within the freshness window', () => {
    const pending = [play({ issuedAt: 1000 })];
    expect(playsToStartOnResume(pending, 1000 + PENDING_ONESHOT_MAX_AGE_MS)).toHaveLength(1);
  });

  it('drops one-shots older than the window instead of bursting', () => {
    const pending = [
      play({ handleId: 'snd_stale', issuedAt: 0 }),
      play({ handleId: 'snd_fresh', issuedAt: 900 }),
      play({ handleId: 'snd_music', loop: true, issuedAt: 0 }),
    ];
    const started = playsToStartOnResume(pending, 1200).map((p) => p.handleId);
    expect(started).toEqual(['snd_fresh', 'snd_music']);
  });

  it('preserves queue order among survivors', () => {
    const pending = [
      play({ handleId: 'a', loop: true }),
      play({ handleId: 'b', issuedAt: 100 }),
      play({ handleId: 'c', loop: true }),
    ];
    expect(playsToStartOnResume(pending, 200).map((p) => p.handleId)).toEqual(['a', 'b', 'c']);
  });
});

function musicPlay(overrides: Partial<PendingMusicPlay>): PendingMusicPlay {
  return { handleId: 'snd_music', assetId: 'ast_music', volume: 1, loop: true, fadeIn: 0, ...overrides };
}

describe('latestPendingMusic', () => {
  it('replaces any previously queued music request with the newest one', () => {
    const first = musicPlay({ handleId: 'm1', assetId: 'ast_a' });
    const second = musicPlay({ handleId: 'm2', assetId: 'ast_b' });
    expect(latestPendingMusic(first, second)).toBe(second);
  });

  it('accepts the first request when nothing was queued', () => {
    const first = musicPlay({ handleId: 'm1' });
    expect(latestPendingMusic(null, first)).toBe(first);
  });

  it('never drops a queued music request as stale — always the latest', () => {
    const stale = musicPlay({ handleId: 'old', fadeIn: 3 });
    const fresh = musicPlay({ handleId: 'new', fadeIn: 0 });
    // Unlike one-shot SFX (playsToStartOnResume), there is no age check here:
    // whichever call came last always wins and always starts on unlock.
    expect(latestPendingMusic(stale, fresh)).toEqual(fresh);
  });
});

describe('WebAudioPlayer music methods without Audio support (headless)', () => {
  // This test file's node environment has neither AudioContext nor Audio, so
  // WebAudioPlayer never creates a context and every method is a no-op —
  // matching the file's existing "no real AudioContext in these tests" policy.
  it('playMusic/stopMusic/setMusicVolume are silent no-ops', () => {
    const onWarn = vi.fn();
    const player = new WebAudioPlayer(() => 'https://example.test/music.mp3', onWarn);
    expect(() => player.playMusic('snd_1', 'ast_music', { volume: 1, loop: true, fadeIn: 0 })).not.toThrow();
    expect(() => player.stopMusic({ fadeOut: 0 })).not.toThrow();
    expect(() => player.setMusicVolume(0.5, 0)).not.toThrow();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('stopAll/destroy do not throw when no music (or anything else) is active', () => {
    const player = new WebAudioPlayer(() => null);
    expect(() => player.stopAll()).not.toThrow();
    expect(() => player.destroy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Host suspend/resume (review I1): editor pause / hidden Game tab must halt
// audio for real — AudioContext.suspend() freezes SFX buffer sources on the
// audio clock, and the streamed music element is paused directly (suspending
// the context alone only silences its output while the element keeps
// advancing), remembering its position for resume.
// ---------------------------------------------------------------------------

class StubGainNode {
  gain = { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}

class StubAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  destination = {};
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  addEventListener = vi.fn();
  createGain = vi.fn(() => new StubGainNode());
  createMediaElementSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
}

interface StubMusicEl {
  preload: string;
  crossOrigin: string;
  loop: boolean;
  src: string;
  paused: boolean;
  currentTime: number;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
}

function stubMusicEl(): StubMusicEl {
  const el: StubMusicEl = {
    preload: '',
    crossOrigin: '',
    loop: false,
    src: '',
    paused: true,
    currentTime: 0,
    play: vi.fn(async () => {
      el.paused = false;
    }),
    pause: vi.fn(() => {
      el.paused = true;
    }),
  };
  return el;
}

/** Stub the browser audio surface, returning the context/element the player will use. */
function stubAudioGlobals(opts: { initialState?: 'running' | 'suspended' } = {}) {
  const el = stubMusicEl();
  let ctx: StubAudioContext | null = null;
  const Ctor = function (this: unknown) {
    ctx = new StubAudioContext();
    if (opts.initialState) ctx.state = opts.initialState;
    return ctx;
  };
  vi.stubGlobal('AudioContext', Ctor);
  vi.stubGlobal('Audio', function AudioStub() {});
  vi.stubGlobal('document', { createElement: vi.fn(() => el) });
  return { el, ctx: () => ctx! };
}

describe('WebAudioPlayer suspend/resume (host pause)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('suspend() suspends a running context and pauses the music element; resume() undoes both at the held position', () => {
    const { el, ctx } = stubAudioGlobals();
    const player = new WebAudioPlayer(() => 'https://example.test/music.mp3');
    player.playMusic('snd_m', 'ast_music', { volume: 1, loop: true, fadeIn: 0 });
    expect(el.paused).toBe(false); // track is playing
    el.currentTime = 42.5; // simulate mid-track playback

    player.suspend();
    expect(ctx().suspend).toHaveBeenCalledTimes(1);
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.paused).toBe(true);
    expect(el.currentTime).toBe(42.5); // position preserved, never reset

    player.resume();
    expect(ctx().resume).toHaveBeenCalledTimes(1);
    expect(el.play).toHaveBeenCalledTimes(2); // startMusic + resume
    expect(el.currentTime).toBe(42.5); // resumes from where pause froze it
    player.destroy();
  });

  it('resume() does not restart music that was not playing at suspend()', () => {
    const { el, ctx } = stubAudioGlobals();
    const player = new WebAudioPlayer(() => 'https://example.test/music.mp3');
    player.playMusic('snd_m', 'ast_music', { volume: 1, loop: true, fadeIn: 0 });
    el.paused = true; // the element ended / was paused out-of-band

    player.suspend();
    expect(el.pause).not.toHaveBeenCalled(); // nothing to pause
    player.resume();
    expect(el.play).toHaveBeenCalledTimes(1); // only startMusic's original play
    expect(ctx().resume).toHaveBeenCalledTimes(1); // context still resumes
    player.destroy();
  });

  it('leaves an autoplay-locked context alone: no suspend() on pause, no resume() on play', () => {
    // A context still waiting for its first user gesture must not be touched:
    // suspending is redundant and resuming programmatically would defeat the
    // unlock bookkeeping (or fail outright in a real browser).
    const { ctx } = stubAudioGlobals({ initialState: 'suspended' });
    const player = new WebAudioPlayer(() => null);
    player.suspend();
    expect(ctx().suspend).not.toHaveBeenCalled();
    player.resume();
    expect(ctx().resume).not.toHaveBeenCalled();
    player.destroy();
  });

  it('suspend() and resume() are idempotent', () => {
    const { ctx } = stubAudioGlobals();
    const player = new WebAudioPlayer(() => null);
    player.suspend();
    player.suspend();
    expect(ctx().suspend).toHaveBeenCalledTimes(1);
    player.resume();
    player.resume();
    expect(ctx().resume).toHaveBeenCalledTimes(1);
    player.destroy();
  });

  it('no-ops safely after destroy() and without Web Audio support', () => {
    const { ctx } = stubAudioGlobals();
    const player = new WebAudioPlayer(() => null);
    player.destroy();
    expect(() => {
      player.suspend();
      player.resume();
    }).not.toThrow();
    expect(ctx().suspend).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    const bare = new WebAudioPlayer(() => null); // node env: no AudioContext at all
    expect(() => {
      bare.suspend();
      bare.resume();
    }).not.toThrow();
  });
});

describe('routeAudioEvent', () => {
  function fakeTarget(): AudioPlaybackTarget & {
    play: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    playMusic: ReturnType<typeof vi.fn>;
    stopMusic: ReturnType<typeof vi.fn>;
    setMusicVolume: ReturnType<typeof vi.fn>;
  } {
    return {
      play: vi.fn(),
      stop: vi.fn(),
      playMusic: vi.fn(),
      stopMusic: vi.fn(),
      setMusicVolume: vi.fn(),
    };
  }

  it('routes a non-music play event to play()', () => {
    const audio = fakeTarget();
    const e: AudioPlaybackEvent = { action: 'play', handleId: 'snd_1', assetId: 'ast_beep', volume: 1, loop: false };
    routeAudioEvent(e, audio);
    expect(audio.play).toHaveBeenCalledWith('snd_1', 'ast_beep', { volume: 1, loop: false });
    expect(audio.playMusic).not.toHaveBeenCalled();
  });

  it('routes a non-music stop event to stop()', () => {
    const audio = fakeTarget();
    const e: AudioPlaybackEvent = { action: 'stop', handleId: 'snd_1', assetId: 'ast_beep', volume: 1, loop: false };
    routeAudioEvent(e, audio);
    expect(audio.stop).toHaveBeenCalledWith('snd_1');
  });

  it('routes a music play event to playMusic() with fadeIn defaulted to 0', () => {
    const audio = fakeTarget();
    const e: AudioPlaybackEvent = {
      action: 'play',
      handleId: 'snd_music',
      assetId: 'ast_music',
      volume: 0.8,
      loop: true,
      music: true,
    };
    routeAudioEvent(e, audio);
    expect(audio.playMusic).toHaveBeenCalledWith('snd_music', 'ast_music', { volume: 0.8, loop: true, fadeIn: 0 });
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('routes a music play event to playMusic() carrying a fadeIn', () => {
    const audio = fakeTarget();
    const e: AudioPlaybackEvent = {
      action: 'play',
      handleId: 'snd_music',
      assetId: 'ast_music',
      volume: 0.8,
      loop: true,
      music: true,
      fadeIn: 2,
    };
    routeAudioEvent(e, audio);
    expect(audio.playMusic).toHaveBeenCalledWith('snd_music', 'ast_music', { volume: 0.8, loop: true, fadeIn: 2 });
  });

  it('routes a music stop event to stopMusic() with fadeOut defaulted to 0', () => {
    const audio = fakeTarget();
    const e: AudioPlaybackEvent = {
      action: 'stop',
      handleId: 'snd_music',
      assetId: 'ast_music',
      volume: 0.8,
      loop: true,
      music: true,
    };
    routeAudioEvent(e, audio);
    expect(audio.stopMusic).toHaveBeenCalledWith({ fadeOut: 0 });
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it('routes a music-volume event to setMusicVolume() with fade defaulted to 0', () => {
    const audio = fakeTarget();
    const e: AudioPlaybackEvent = {
      action: 'music-volume',
      handleId: 'snd_music',
      assetId: 'ast_music',
      volume: 0.3,
      loop: true,
    };
    routeAudioEvent(e, audio);
    expect(audio.setMusicVolume).toHaveBeenCalledWith(0.3, 0);
  });

  it('routes a music-volume event carrying a fade', () => {
    const audio = fakeTarget();
    const e: AudioPlaybackEvent = {
      action: 'music-volume',
      handleId: 'snd_music',
      assetId: 'ast_music',
      volume: 0.3,
      loop: true,
      fade: 1.5,
    };
    routeAudioEvent(e, audio);
    expect(audio.setMusicVolume).toHaveBeenCalledWith(0.3, 1.5);
  });
});
