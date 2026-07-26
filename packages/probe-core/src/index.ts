/**
 * @hearth/probe-core — the engine-agnostic probe.
 *
 * One contract (`contract.ts`) says what the probe needs from a game. One
 * evidence schema (`evidence.ts`) says where the answers go. Everything between
 * them is here: seeded policies that play, statistical detectors that judge, a
 * sweep runner that repeats the experiment, and an in-memory fixture game that
 * proves the whole thing can tell a working game from a broken one.
 *
 * The package depends on nothing but Node builtins — no engine, no runtime, no
 * renderer. If it ever needs one, the contract was wrong.
 */
export * from './contract.js';
export * from './evidence.js';

export * from './rng.js';
export * from './png.js';
export * from './imageHash.js';
export * from './input.js';
export * from './entities.js';
export * from './nav.js';
export * from './reachability.js';
export * from './steer.js';
export * from './coverage.js';
export * from './objectives.js';
export * from './fold.js';
export * from './avatar.js';

export * from './policies/index.js';
export * from './detectors/index.js';

export * from './evidenceStore.js';
export * from './sweep.js';

export * from './fixtures/synthetic.js';
