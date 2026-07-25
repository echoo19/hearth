/**
 * Validation for the gameplay primitives (CharacterController, Health,
 * Respawn, Checkpoint, Text.binding).
 *
 * Each of these components fails SILENTLY when it is wired up wrong: a
 * controller with no body reads input and never moves, a checkpoint with a
 * solid collider blocks the player instead of firing, and a Text bound to an
 * undeclared game-state key renders as a blank label. Validation is where an
 * agent finds out, so these codes are part of the primitives' contract.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, type ProjectStore } from '@hearth/core';
import { validateProject } from '../src/validate.js';

/**
 * The starter scene `createProject` writes already contains a `Main Camera`,
 * a `Ground` tagged `ground`, and a `Player` tagged `player` with no Respawn.
 * These tests add to that scene rather than pretending it is empty, so an
 * unmatched checkpoint target has to use a tag/name the starter does not use.
 */
async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  const session = HearthSession.fromStore(store, {});
  return { session, store };
}

async function addEntity(
  session: HearthSession,
  store: ProjectStore,
  name: string,
  components: Record<string, unknown>,
  tags: string[] = [],
) {
  const res = await session.execute('createEntity', {
    scene: store.project.initialScene as string,
    name,
    components,
    tags,
  });
  expect(res.success, JSON.stringify(res.errors)).toBe(true);
}

async function issuesWithCode(store: ProjectStore, code: string) {
  const report = await validateProject(store);
  return [...report.errors, ...report.warnings].filter((i) => i.code === code);
}

describe('TEXT_BINDING_UNKNOWN_STATE', () => {
  it('errors when a Text binding names a key the project does not declare', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'ScoreLabel', {
      Text: { binding: { key: 'score', format: 'Score: {value}' } },
    });

    const issues = await issuesWithCode(store, 'TEXT_BINDING_UNKNOWN_STATE');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('score'); // the offending key
    expect(issues[0].message).toContain('ScoreLabel'); // the entity
    expect(issues[0].scene).toBe(store.project.initialScene);
    expect(issues[0].entity).toBeTruthy();
  });

  it('lists the declared keys so a typo is a one-step fix', async () => {
    const { session, store } = await makeSession();
    store.project.gameState.score = { type: 'number', initial: 0, persist: false };
    await addEntity(session, store, 'ScoreLabel', { Text: { binding: { key: 'scoer' } } });

    const issues = await issuesWithCode(store, 'TEXT_BINDING_UNKNOWN_STATE');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('scoer');
    expect(issues[0].message).toContain('score');
  });

  it('stays quiet for a declared key, and for a Text with no binding', async () => {
    const { session, store } = await makeSession();
    store.project.gameState.score = { type: 'number', initial: 0, persist: false };
    await addEntity(session, store, 'ScoreLabel', { Text: { binding: { key: 'score' } } });
    await addEntity(session, store, 'Title', { Text: { content: 'Hello' } });

    expect((await issuesWithCode(store, 'TEXT_BINDING_UNKNOWN_STATE')).length).toBe(0);
  });
});

describe('CHARACTER_CONTROLLER_WITHOUT_BODY', () => {
  it('warns when a CharacterController has no PhysicsBody to write velocity into', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Player', { CharacterController: { mode: 'platformer' } });

    const issues = await issuesWithCode(store, 'CHARACTER_CONTROLLER_WITHOUT_BODY');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('PhysicsBody');
  });

  it('stays quiet once the entity has a PhysicsBody', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Player', {
      CharacterController: { mode: 'platformer' },
      PhysicsBody: { bodyType: 'dynamic' },
      Collider: { shape: 'box', width: 16, height: 16 },
    });

    expect((await issuesWithCode(store, 'CHARACTER_CONTROLLER_WITHOUT_BODY')).length).toBe(0);
  });
});

/** A trigger collider, the only kind a Checkpoint can fire from. */
const trigger = { shape: 'box', width: 16, height: 32, isTrigger: true };

describe('CHECKPOINT_WITHOUT_TRIGGER', () => {
  it('warns when a Checkpoint entity has no Collider at all', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Rider', { Respawn: {} }, ['player']);
    await addEntity(session, store, 'Flag', { Checkpoint: {} });

    const issues = await issuesWithCode(store, 'CHECKPOINT_WITHOUT_TRIGGER');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('isTrigger');
  });

  it('warns when the Collider is solid, because it blocks instead of reporting the overlap', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Rider', { Respawn: {} }, ['player']);
    await addEntity(session, store, 'Flag', {
      Checkpoint: {},
      Collider: { shape: 'box', width: 16, height: 32, isTrigger: false },
    });

    const issues = await issuesWithCode(store, 'CHECKPOINT_WITHOUT_TRIGGER');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('solid');
  });

  it('stays quiet for a trigger Collider', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Rider', { Respawn: {} }, ['player']);
    await addEntity(session, store, 'Flag', { Checkpoint: {}, Collider: trigger });

    expect((await issuesWithCode(store, 'CHECKPOINT_WITHOUT_TRIGGER')).length).toBe(0);
  });
});

describe('CHECKPOINT_TARGET_NOT_FOUND', () => {
  it('warns when the target tag matches nothing in the scene', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Rider', { Respawn: {} }, ['player']);
    await addEntity(session, store, 'Flag', { Checkpoint: { target: 'tag:hero' }, Collider: trigger });

    const issues = await issuesWithCode(store, 'CHECKPOINT_TARGET_NOT_FOUND');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('hero');
  });

  it('warns when the target names an entity that does not exist', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Rider', { Respawn: {} }, ['player']);
    await addEntity(session, store, 'Flag', { Checkpoint: { target: 'Ghost' }, Collider: trigger });

    const issues = await issuesWithCode(store, 'CHECKPOINT_TARGET_NOT_FOUND');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('Ghost');
  });

  it('stays quiet when a tagged entity matches', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Rider', { Respawn: {} }, ['player']);
    await addEntity(session, store, 'Flag', { Checkpoint: { target: 'tag:player' }, Collider: trigger });

    expect((await issuesWithCode(store, 'CHECKPOINT_TARGET_NOT_FOUND')).length).toBe(0);
  });

  it('stays quiet when the target matches by exact name', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Rider', { Respawn: {} });
    await addEntity(session, store, 'Flag', { Checkpoint: { target: 'Rider' }, Collider: trigger });

    expect((await issuesWithCode(store, 'CHECKPOINT_TARGET_NOT_FOUND')).length).toBe(0);
  });
});

describe('CHECKPOINT_TARGET_MISSING_RESPAWN', () => {
  it('warns when the matched target has no Respawn component', async () => {
    const { session, store } = await makeSession();
    // The starter scene's Player is tagged `player` and has no Respawn.
    await addEntity(session, store, 'Flag', { Checkpoint: { target: 'tag:player' }, Collider: trigger });

    const issues = await issuesWithCode(store, 'CHECKPOINT_TARGET_MISSING_RESPAWN');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('Respawn');
    expect(issues[0].message).toContain('Player'); // names the entity to fix
  });

  it('does not fire alongside CHECKPOINT_TARGET_NOT_FOUND', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, 'Flag', { Checkpoint: { target: 'tag:hero' }, Collider: trigger });

    expect((await issuesWithCode(store, 'CHECKPOINT_TARGET_NOT_FOUND')).length).toBe(1);
    expect((await issuesWithCode(store, 'CHECKPOINT_TARGET_MISSING_RESPAWN')).length).toBe(0);
  });

  it('stays quiet when any matching entity has Respawn', async () => {
    const { session, store } = await makeSession();
    // Two entities carry the tag (the starter Player and this one); one Respawn
    // between them is enough, because the runtime matches whichever overlaps.
    await addEntity(session, store, 'Rider', { Respawn: {} }, ['player']);
    await addEntity(session, store, 'Flag', { Checkpoint: { target: 'tag:player' }, Collider: trigger });

    expect((await issuesWithCode(store, 'CHECKPOINT_TARGET_MISSING_RESPAWN')).length).toBe(0);
  });
});

describe('a correctly wired platformer passes clean', () => {
  it('reports none of the primitive codes', async () => {
    const { session, store } = await makeSession();
    store.project.gameState.score = { type: 'number', initial: 0, persist: false };
    await addEntity(
      session,
      store,
      'Rider',
      {
        CharacterController: { mode: 'platformer', speed: 220, jumpHeight: 90 },
        PhysicsBody: { bodyType: 'dynamic' },
        Collider: { shape: 'box', width: 16, height: 16 },
        Health: { max: 3, invulnerableFrames: 45 },
        Respawn: {},
      },
      ['player'],
    );
    await addEntity(session, store, 'Flag', {
      Checkpoint: { target: 'tag:player', once: true },
      Collider: { shape: 'box', width: 16, height: 32, isTrigger: true },
    });
    await addEntity(session, store, 'ScoreLabel', {
      Text: { binding: { key: 'score', format: 'Score: {value}' } },
    });

    const report = await validateProject(store);
    const codes = [...report.errors, ...report.warnings].map((i) => i.code);
    for (const code of [
      'TEXT_BINDING_UNKNOWN_STATE',
      'CHARACTER_CONTROLLER_WITHOUT_BODY',
      'CHECKPOINT_WITHOUT_TRIGGER',
      'CHECKPOINT_TARGET_NOT_FOUND',
      'CHECKPOINT_TARGET_MISSING_RESPAWN',
    ]) {
      expect(codes, `unexpected ${code}`).not.toContain(code);
    }
  });
});
