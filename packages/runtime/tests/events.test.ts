/**
 * ctx.events: the scene-wide pub/sub bus (ctx.events.emit/on/off) and the
 * onEvent script hook. Covers delivery ordering, self-hearing, off()
 * (including unknown ids), auto-cleanup on entity destroy, mid-delivery
 * subscribe/unsubscribe semantics, the re-entrancy depth guard, and the
 * events/eventCounts recording (with its 200-entry cap).
 */
import { describe, it, expect } from 'vitest';
import { GameSession, SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

function scripted(name: string, scriptPath: string, components: Record<string, unknown> = {}) {
  return ent(name, { Transform: {}, Script: { scriptPath }, ...components });
}

const messages = (logs: { message: string }[]) => logs.map((l) => l.message);

describe('ctx.events', () => {
  it('delivers to subscribers in subscription order, then onEvent hooks in entity creation order', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('A', 'scripts/a.js'),
        scripted('B', 'scripts/b.js'),
        scripted('C', 'scripts/c.js'),
      ],
      scripts: {
        'a.js': `export default {
          onStart(ctx) { ctx.events.on('ping', () => ctx.log('sub:A')); },
        };`,
        'b.js': `export default {
          onEvent(ctx, name) { if (name === 'ping') ctx.log('hook:B'); },
        };`,
        'c.js': `export default {
          onUpdate(ctx) { if (ctx.time.frame === 0) ctx.events.emit('ping'); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toEqual(['sub:A', 'hook:B']);
  });

  it('the emitter hears its own event via both the subscription and the onEvent hook', async () => {
    const { store } = await makeStore({
      entities: [scripted('Emitter', 'scripts/emitter.js')],
      scripts: {
        'emitter.js': `export default {
          onStart(ctx) { ctx.events.on('boom', () => ctx.log('sub:self')); },
          onEvent(ctx, name) { if (name === 'boom') ctx.log('hook:self'); },
          onUpdate(ctx) { if (ctx.time.frame === 0) ctx.events.emit('boom'); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toEqual(['sub:self', 'hook:self']);
  });

  it('ctx.events.off stops delivery; an unknown id is a no-op', async () => {
    const { store } = await makeStore({
      entities: [scripted('Toggle', 'scripts/toggle.js')],
      scripts: {
        'toggle.js': `export default {
          onStart(ctx) {
            ctx.vars.subId = ctx.events.on('ping', () => ctx.log('should-not-fire'));
            ctx.events.off('nope-unknown-id');
          },
          onUpdate(ctx) {
            if (ctx.time.frame === 0) ctx.events.off(ctx.vars.subId);
            if (ctx.time.frame === 1) ctx.events.emit('ping');
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).not.toContain('should-not-fire');
  });

  it('subscriptions auto-clean when the owning entity is destroyed', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('A', 'scripts/a.js'),
        scripted('Killer', 'scripts/killer.js'),
      ],
      scripts: {
        'a.js': `export default {
          onStart(ctx) { ctx.events.on('ping', () => ctx.log('sub:A')); },
        };`,
        'killer.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 0) ctx.scene.destroy(ctx.scene.find('A'));
            if (ctx.time.frame === 1) ctx.events.emit('ping');
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).not.toContain('sub:A');
  });

  it('a handler subscribed during delivery waits for the next emit; one unsubscribed before its turn is skipped', async () => {
    const { store } = await makeStore({
      entities: [scripted('Hub', 'scripts/hub.js')],
      scripts: {
        'hub.js': `export default {
          onStart(ctx) {
            let sub3;
            ctx.events.on('go', () => {
              ctx.log('sub1');
              ctx.events.off(sub3);
              ctx.events.on('go', () => ctx.log('late'));
            });
            ctx.events.on('go', () => ctx.log('sub2'));
            sub3 = ctx.events.on('go', () => ctx.log('sub3'));
          },
          onUpdate(ctx) {
            if (ctx.time.frame === 0) ctx.events.emit('go');
            if (ctx.time.frame === 1) ctx.events.emit('go');
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    // sub3 was off'd by sub1 before sub3's own turn: skipped. 'late' was
    // subscribed mid-delivery: not called this round.
    expect(messages(runtime.logs)).toEqual(['sub1', 'sub2']);
    runtime.run(1);
    // Second emit: sub3 stays gone, 'late' (added last emit) now fires.
    expect(messages(runtime.logs)).toEqual(['sub1', 'sub2', 'sub1', 'sub2', 'late']);
  });

  it('nested emits work to depth 8; the 9th-deep emit is dropped with a cascade warning', async () => {
    const { store } = await makeStore({
      entities: [scripted('Cascade', 'scripts/cascade.js')],
      scripts: {
        'cascade.js': `export default {
          onEvent(ctx, name) { ctx.events.emit(name); },
          onUpdate(ctx) { if (ctx.time.frame === 0) ctx.events.emit('cascade'); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.eventCounts.get('cascade')).toBe(8);
    expect(
      runtime.logs.some((l) => l.level === 'warn' && l.message.includes('event cascade too deep')),
    ).toBe(true);
  });

  it('eventCounts counts exactly past the 200-entry events cap, with eventsTruncated set', async () => {
    const { store } = await makeStore({
      entities: [scripted('Flood', 'scripts/flood.js')],
      scripts: {
        'flood.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 0) {
              for (let i = 0; i < 250; i++) ctx.events.emit('spam');
            }
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.eventCounts.get('spam')).toBe(250);
    expect(runtime.events.filter((e) => e.name === 'spam').length).toBe(200);
    expect(runtime.eventsTruncated).toBe(true);
  });

  it('session eventCounts stays exact past the 200-record cap', async () => {
    const { store } = await makeStore({
      entities: [scripted('Flood', 'scripts/flood.js')],
      scripts: {
        'flood.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 0) {
              for (let i = 0; i < 250; i++) ctx.events.emit('spam');
            }
          },
        };`,
      },
    });
    const session = await GameSession.create(store);
    await session.stepAsync();
    expect(session.errors).toEqual([]);
    expect(session.eventCounts.get('spam')).toBe(250);
    expect(session.events.length).toBe(200);
    expect(session.eventsTruncated).toBe(true);
    session.destroy();
  });

  it('aggregates eventCounts and keeps recorded event frames session-monotonic across a ctx.scenes.load switch', async () => {
    const { store } = await makeStore({
      entities: [scripted('Emitter', 'scripts/emitter.js')],
      scripts: {
        'emitter.js': `export default {
          onStart(ctx) { ctx.events.emit('ping'); },
          onUpdate(ctx) { if (ctx.time.frame === 2) ctx.scenes.load('Level'); },
        };`,
        'receiver.js': `export default {
          onStart(ctx) { ctx.events.emit('ping'); },
        };`,
      },
      extraScenes: [
        { id: 'scn_level', name: 'Level', entities: [scripted('Receiver', 'scripts/receiver.js')] },
      ],
    });

    const session = await GameSession.create(store);
    for (let i = 0; i < 6; i++) await session.stepAsync();

    expect(session.currentSceneId).toBe('scn_level');
    // One "ping" pre-switch (Emitter.onStart in scn_test), one post-switch
    // (Receiver.onStart in scn_level) — eventCounts must sum across both
    // scenes rather than resetting when the runtime is swapped.
    expect(session.eventCounts.get('ping')).toBe(2);

    const pingFrames = session.events.filter((e) => e.name === 'ping').map((e) => e.frame);
    expect(pingFrames.length).toBe(2);
    // The pre-switch emit lands at frame 0; the post-switch emit continues
    // the session's monotonic frame counter (matching the scene-switch
    // frame recorded elsewhere for this exact load-at-frame-2 pattern)
    // rather than resetting to 0 for the new scene.
    expect(pingFrames).toEqual([0, 3]);
    const allFrames = session.events.map((e) => e.frame);
    expect([...allFrames].sort((a, b) => a - b)).toEqual(allFrames);
    session.destroy();
  });

  it('a throwing subscription stops firing once its script is disabled, and errors stop growing', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('Faulty', 'scripts/faulty.js'),
        scripted('Ticker', 'scripts/ticker.js'),
      ],
      scripts: {
        'faulty.js': `export default {
          onStart(ctx) {
            ctx.events.on('tick', () => {
              ctx.vars.calls = (ctx.vars.calls ?? 0) + 1;
              ctx.log('call:' + ctx.vars.calls);
              throw new Error('boom');
            });
          },
        };`,
        'ticker.js': `export default {
          onUpdate(ctx) { ctx.events.emit('tick'); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(3); // three consecutive throws disable the script
    expect(runtime.errors.length).toBe(3);
    expect(
      runtime.logs.some((l) => l.level === 'warn' && l.message.includes('disabled after')),
    ).toBe(true);
    const errorsAfterDisable = runtime.errors.length;
    const logsAfterDisable = runtime.logs.length;
    runtime.run(5); // five more emits; the disabled sub must not fire
    expect(runtime.errors.length).toBe(errorsAfterDisable);
    expect(runtime.logs.length).toBe(logsAfterDisable);
    expect(messages(runtime.logs).filter((m) => m.startsWith('call:'))).toEqual([
      'call:1',
      'call:2',
      'call:3',
    ]);
    expect(runtime.eventCounts.get('tick')).toBe(8); // emits keep counting
  });

  it('passes the data payload through to listeners and the recorded event', async () => {
    const { store } = await makeStore({
      entities: [scripted('Scorer', 'scripts/payload.js')],
      scripts: {
        'payload.js': `export default {
          onStart(ctx) { ctx.events.on('score', (data) => ctx.log('got:' + data.score)); },
          onUpdate(ctx) { if (ctx.time.frame === 0) ctx.events.emit('score', { score: 5 }); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime.logs)).toContain('got:5');
    const recorded = runtime.events.find((e) => e.name === 'score');
    expect(recorded?.data).toEqual({ score: 5 });
  });
});
