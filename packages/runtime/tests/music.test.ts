/**
 * Music channel: a single shared channel (owned by GameSession, or the
 * SceneRuntime itself in standalone use) for ctx.audio.playMusic/stopMusic/
 * setMusicVolume. Distinct from ctx.audio.play/stop: playMusic replaces the
 * current track (recording a stop for the old one first), the channel
 * survives scene switches, and stopAllAudio/stopAudio never touch it.
 */
import { describe, it, expect } from 'vitest';
import { GameSession, SceneRuntime, type AudioPlaybackEvent } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

const MUSIC_ASSETS = [
  { id: 'ast_bgm1', name: 'bgm1', type: 'audio', path: 'assets/bgm1.wav' },
  { id: 'ast_bgm2', name: 'bgm2', type: 'audio', path: 'assets/bgm2.wav' },
];

describe('ctx.audio.playMusic / stopMusic / setMusicVolume (SceneRuntime)', () => {
  it('playMusic returns mus_1 and records the play event', async () => {
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [ent('Jukebox', { Transform: {}, Script: { scriptPath: 'scripts/jukebox.js' } })],
      scripts: {
        'jukebox.js': `
          export default {
            onStart(ctx) { ctx.vars.handle = ctx.audio.playMusic('bgm1'); },
            onUpdate(ctx) { if (ctx.time.frame === 1) ctx.log('handle=' + ctx.vars.handle); },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2);
    expect(runtime.logs.map((l) => l.message)).toContain('handle=mus_1');
    expect(runtime.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_bgm1', action: 'play', music: true },
    ]);
    expect(runtime.errors).toEqual([]);
  });

  it('a second playMusic records a stop for the first track (fadeOut = new fadeIn), then plays mus_2', async () => {
    const received: AudioPlaybackEvent[] = [];
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [ent('Jukebox', { Transform: {}, Script: { scriptPath: 'scripts/jukebox.js' } })],
      scripts: {
        'jukebox.js': `
          export default {
            onStart(ctx) { ctx.audio.playMusic('bgm1'); },
            onUpdate(ctx) {
              if (ctx.time.frame === 1) ctx.vars.h2 = ctx.audio.playMusic('bgm2', { fadeIn: 2 });
              if (ctx.time.frame === 2) ctx.log('h2=' + ctx.vars.h2);
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test', { onAudio: (e) => received.push(e) });
    runtime.run(3);
    expect(runtime.logs.map((l) => l.message)).toContain('h2=mus_2');
    expect(runtime.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_bgm1', action: 'play', music: true },
      { frame: 1, assetId: 'ast_bgm1', action: 'stop', music: true },
      { frame: 1, assetId: 'ast_bgm2', action: 'play', music: true },
    ]);
    expect(received).toEqual([
      { action: 'play', handleId: 'mus_1', assetId: 'ast_bgm1', volume: 1, loop: true, music: true, fadeIn: 0 },
      { action: 'stop', handleId: 'mus_1', assetId: 'ast_bgm1', volume: 1, loop: false, music: true, fadeOut: 2 },
      { action: 'play', handleId: 'mus_2', assetId: 'ast_bgm2', volume: 1, loop: true, music: true, fadeIn: 2 },
    ]);
  });

  it('stopMusic records a stop; a second stopMusic is a no-op (no event, no warn)', async () => {
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [ent('Jukebox', { Transform: {}, Script: { scriptPath: 'scripts/jukebox.js' } })],
      scripts: {
        'jukebox.js': `
          export default {
            onStart(ctx) { ctx.audio.playMusic('bgm1'); },
            onUpdate(ctx) {
              if (ctx.time.frame === 1) ctx.audio.stopMusic({ fadeOut: 1 });
              if (ctx.time.frame === 2) ctx.audio.stopMusic();
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(4);
    expect(runtime.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_bgm1', action: 'play', music: true },
      { frame: 1, assetId: 'ast_bgm1', action: 'stop', music: true },
    ]);
    expect(runtime.logs.some((l) => l.level === 'warn')).toBe(false);
    expect(runtime.errors).toEqual([]);
  });

  it('setMusicVolume fires onAudio music-volume but never touches audioEvents; no-op when idle', async () => {
    const received: AudioPlaybackEvent[] = [];
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [ent('Jukebox', { Transform: {}, Script: { scriptPath: 'scripts/jukebox.js' } })],
      scripts: {
        'jukebox.js': `
          export default {
            onUpdate(ctx) {
              if (ctx.time.frame === 0) ctx.audio.setMusicVolume(0.9); // idle: no-op
              if (ctx.time.frame === 1) ctx.audio.playMusic('bgm1');
              if (ctx.time.frame === 2) ctx.audio.setMusicVolume(0.3, { fade: 1 });
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test', { onAudio: (e) => received.push(e) });
    runtime.run(4);
    expect(runtime.audioEvents).toEqual([
      { frame: 1, assetId: 'ast_bgm1', action: 'play', music: true },
    ]);
    expect(received).toEqual([
      { action: 'play', handleId: 'mus_1', assetId: 'ast_bgm1', volume: 1, loop: true, music: true, fadeIn: 0 },
      {
        action: 'music-volume',
        handleId: 'mus_1',
        assetId: 'ast_bgm1',
        volume: 0.3,
        loop: false,
        music: true,
        fade: 1,
      },
    ]);
  });

  it('warns and returns null for an unknown asset', async () => {
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [ent('Jukebox', { Transform: {}, Script: { scriptPath: 'scripts/bad.js' } })],
      scripts: {
        'bad.js': `
          export default {
            onStart(ctx) { ctx.log('handle=' + ctx.audio.playMusic('nope')); },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.audioEvents).toEqual([]);
    const msgs = runtime.logs.map((l) => l.message);
    expect(msgs).toContain('audio.playMusic: asset not found: nope');
    expect(msgs).toContain('handle=null');
  });

  it('stopAllAudio never touches the music channel', async () => {
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [ent('Jukebox', { Transform: {}, Script: { scriptPath: 'scripts/jukebox.js' } })],
      scripts: {
        'jukebox.js': `
          export default {
            onStart(ctx) {
              ctx.audio.playMusic('bgm1');
              ctx.audio.play('bgm2');
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    runtime.stopAllAudio();
    expect(runtime.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_bgm1', action: 'play', music: true },
      { frame: 0, assetId: 'ast_bgm2', action: 'play' },
      { frame: 1, assetId: 'ast_bgm2', action: 'stop' },
    ]);
  });
});

describe('AudioSource music autoplay', () => {
  it('records a music play (not a regular one) on frame 0, with its volume/loop', async () => {
    const received: AudioPlaybackEvent[] = [];
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [
        ent('BGM', {
          Transform: {},
          AudioSource: { assetId: 'ast_bgm1', autoplay: true, music: true, volume: 0.5, loop: true },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test', { onAudio: (e) => received.push(e) });
    runtime.run(3);
    expect(runtime.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_bgm1', action: 'play', music: true },
    ]);
    expect(received).toEqual([
      { action: 'play', handleId: 'mus_1', assetId: 'ast_bgm1', volume: 0.5, loop: true, music: true, fadeIn: 0 },
    ]);
  });
});

describe('ctx.audio.playMusic exposed to Lua', () => {
  it('a Lua script can playMusic and stopMusic through the same ctx proxy', async () => {
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [ent('Jukebox', { Transform: {}, Script: { scriptPath: 'scripts/jukebox.lua' } })],
      scripts: {
        'jukebox.lua': [
          'local script = {}',
          'function script.onStart(ctx)',
          '  local h = ctx.audio.playMusic("bgm1")',
          '  ctx.log("handle=" .. h)',
          'end',
          'function script.onUpdate(ctx, dt)',
          '  if ctx.time.frame == 1 then',
          '    ctx.audio.stopMusic()',
          '  end',
          'end',
          'return script',
        ].join('\n'),
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(3);
    expect(runtime.errors).toEqual([]);
    expect(runtime.logs.map((l) => l.message)).toContain('handle=mus_1');
    expect(runtime.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_bgm1', action: 'play', music: true },
      { frame: 1, assetId: 'ast_bgm1', action: 'stop', music: true },
    ]);
    runtime.destroy();
  });
});

describe('music channel survives GameSession scene switches', () => {
  it('a scene switch never stops music; the shared channel carries over to the new scene', async () => {
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [ent('Menu', { Transform: {}, Script: { scriptPath: 'scripts/menu.js' } })],
      scripts: {
        'menu.js': `
          export default {
            onStart(ctx) { ctx.audio.playMusic('bgm1'); },
            onUpdate(ctx) { if (ctx.time.frame === 1) ctx.scenes.load('Level'); },
          };
        `,
        'hero.js': `
          export default {
            onUpdate(ctx) { if (ctx.time.frame === 3) ctx.audio.stopMusic(); },
          };
        `,
      },
      extraScenes: [
        {
          id: 'scn_level',
          name: 'Level',
          entities: [ent('Hero', { Transform: {}, Script: { scriptPath: 'scripts/hero.js' } })],
        },
      ],
    });
    const session = await GameSession.create(store);
    for (let i = 0; i < 4; i++) await session.stepAsync();

    expect(session.currentSceneId).toBe('scn_level');
    // Exactly the explicit play + the explicit stop in the new scene — no
    // stop from the switch itself (old.stopAllAudio() must not touch music).
    expect(session.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_bgm1', action: 'play', music: true },
      { frame: 3, assetId: 'ast_bgm1', action: 'stop', music: true },
    ]);
    session.destroy();
  });

  it('session.audioEvents never includes music-volume records', async () => {
    const received: AudioPlaybackEvent[] = [];
    const { store } = await makeStore({
      assets: MUSIC_ASSETS,
      entities: [ent('Jukebox', { Transform: {}, Script: { scriptPath: 'scripts/jukebox.js' } })],
      scripts: {
        'jukebox.js': `
          export default {
            onStart(ctx) { ctx.audio.playMusic('bgm1'); },
            onUpdate(ctx) { if (ctx.time.frame === 1) ctx.audio.setMusicVolume(0.2); },
          };
        `,
      },
    });
    const session = await GameSession.create(store, { onAudio: (e) => received.push(e) });
    for (let i = 0; i < 3; i++) await session.stepAsync();

    expect(session.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_bgm1', action: 'play', music: true },
    ]);
    expect(received.some((e) => e.action === 'music-volume')).toBe(true);
    session.destroy();
  });
});
