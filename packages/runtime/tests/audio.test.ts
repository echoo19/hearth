/**
 * Audio: ctx.audio.play/stop recording into audioEvents, AudioSource
 * autoplay on scene start, asset resolution by id and name, and the
 * onAudio host notification.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime, type AudioPlaybackEvent } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

const AUDIO_ASSETS = [
  { id: 'ast_beep', name: 'beep', type: 'audio', path: 'assets/beep.wav' },
  { id: 'ast_music', name: 'music', type: 'audio', path: 'assets/music.wav' },
];

describe('ctx.audio', () => {
  it('records play events with frame and resolved asset id (by name)', async () => {
    const { store } = await makeStore({
      assets: AUDIO_ASSETS,
      entities: [ent('Player', { Transform: {}, Script: { scriptPath: 'scripts/sfx.js' } })],
      scripts: {
        'sfx.js': `
          export default {
            onUpdate(ctx) { if (ctx.time.frame === 3) ctx.audio.play('beep'); },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(10);
    expect(runtime.audioEvents).toEqual([{ frame: 3, assetId: 'ast_beep', action: 'play' }]);
    expect(runtime.errors).toEqual([]);
  });

  it('stops by handle id and stops every playback of an asset by name', async () => {
    const { store } = await makeStore({
      assets: AUDIO_ASSETS,
      entities: [ent('Jukebox', { Transform: {}, Script: { scriptPath: 'scripts/jukebox.js' } })],
      scripts: {
        'jukebox.js': `
          export default {
            onStart(ctx) {
              ctx.vars.handle = ctx.audio.play('ast_music', { loop: true });
              ctx.audio.play('beep');
              ctx.audio.play('beep');
            },
            onUpdate(ctx) {
              if (ctx.time.frame === 2) ctx.audio.stop(ctx.vars.handle);
              if (ctx.time.frame === 4) ctx.audio.stop('beep');
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(10);
    expect(runtime.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_music', action: 'play' },
      { frame: 0, assetId: 'ast_beep', action: 'play' },
      { frame: 0, assetId: 'ast_beep', action: 'play' },
      { frame: 2, assetId: 'ast_music', action: 'stop' },
      { frame: 4, assetId: 'ast_beep', action: 'stop' },
      { frame: 4, assetId: 'ast_beep', action: 'stop' },
    ]);
    expect(runtime.errors).toEqual([]);
  });

  it('warns and returns null for an unknown asset', async () => {
    const { store } = await makeStore({
      assets: AUDIO_ASSETS,
      entities: [ent('Player', { Transform: {}, Script: { scriptPath: 'scripts/bad.js' } })],
      scripts: {
        'bad.js': `
          export default {
            onStart(ctx) { ctx.log('handle=' + ctx.audio.play('nope')); },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2);
    expect(runtime.audioEvents).toEqual([]);
    const msgs = runtime.logs.map((l) => l.message);
    expect(msgs).toContain('audio.play: asset not found: nope');
    expect(msgs).toContain('handle=null');
  });
});

describe('AudioSource autoplay', () => {
  it('plays on scene start with its loop and volume', async () => {
    const received: AudioPlaybackEvent[] = [];
    const { store } = await makeStore({
      assets: AUDIO_ASSETS,
      entities: [
        ent('Music', {
          Transform: {},
          AudioSource: { assetId: 'ast_music', autoplay: true, loop: true, volume: 0.5 },
        }),
        ent('Silent', {
          Transform: {},
          AudioSource: { assetId: 'ast_beep', autoplay: false },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test', { onAudio: (e) => received.push(e) });
    runtime.run(5);
    expect(runtime.audioEvents).toEqual([{ frame: 0, assetId: 'ast_music', action: 'play' }]);
    expect(received).toEqual([
      { action: 'play', handleId: 'snd_1', assetId: 'ast_music', volume: 0.5, loop: true },
    ]);
  });

  it('plays autoplay sources only once, on the first frame', async () => {
    const { store } = await makeStore({
      assets: AUDIO_ASSETS,
      entities: [
        ent('Music', {
          Transform: {},
          AudioSource: { assetId: 'ast_music', autoplay: true },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(60);
    expect(runtime.audioEvents.length).toBe(1);
  });
});
