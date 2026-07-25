/**
 * Named game-state values (score, lives, currency) declared in `hearth.json`
 * and reachable from scripts via ctx.state.
 *
 * Lives on GameSession, not SceneRuntime, so values survive scene switches —
 * the same reason the music channel is session-scoped. Keys marked `persist`
 * round-trip through the session storage on every change.
 *
 * Deliberately knows nothing about SceneRuntime: it takes a declaration map, a
 * storage adapter and an optional change callback, which is what makes it
 * unit-testable and reusable from the editor.
 */

/** Every value a declared key can hold. */
export type GameStateValue = number | boolean | string;

/** One declared key, mirroring `GameStateEntry` from the project schema. */
export interface GameStateDecl {
  type: 'number' | 'boolean' | 'string';
  initial: GameStateValue;
  persist: boolean;
}

/** Minimal storage shape — structurally satisfied by SessionStorage. */
export interface GameStateStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Enumerate stored keys; unused here but part of the shared storage shape. */
  keys?(): string[];
}

/** Namespace for persisted values so they never collide with ctx.save keys. */
const STORAGE_PREFIX = 'hearth:state:';

export type GameStateChangeHandler = (
  key: string,
  value: GameStateValue,
  previous: GameStateValue,
) => void;

export class GameStateStore {
  private readonly values = new Map<string, GameStateValue>();

  constructor(
    private readonly decls: Record<string, GameStateDecl>,
    private readonly storage: GameStateStorage,
    private readonly onChange?: GameStateChangeHandler,
  ) {
    for (const [key, decl] of Object.entries(decls)) {
      this.values.set(key, this.loadInitial(key, decl));
    }
  }

  /**
   * A persisted key prefers whatever storage holds, but only if it still parses
   * and still matches the declared type — a project that changes a key's type
   * must not resurrect the old value.
   */
  private loadInitial(key: string, decl: GameStateDecl): GameStateValue {
    if (!decl.persist) return decl.initial;
    const raw = this.storage.get(STORAGE_PREFIX + key);
    if (raw === null || raw === undefined) return decl.initial;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === decl.type ? (parsed as GameStateValue) : decl.initial;
    } catch {
      return decl.initial;
    }
  }

  /** True when `key` is declared. */
  has(key: string): boolean {
    return this.values.has(key);
  }

  /** Every declared key, in declaration order. */
  keys(): string[] {
    return [...this.values.keys()];
  }

  /** Current value, or null for an undeclared key — reads never throw. */
  get(key: string): GameStateValue | null {
    const value = this.values.get(key);
    return value === undefined ? null : value;
  }

  /** Writes throw on an undeclared key or a type mismatch; a no-op write is silent. */
  set(key: string, value: GameStateValue): void {
    const decl = this.declFor(key);
    if (typeof value !== decl.type) {
      throw new Error(`Game state "${key}" is a ${decl.type}; got ${typeof value}.`);
    }
    const previous = this.values.get(key) as GameStateValue;
    if (previous === value) return;
    this.values.set(key, value);
    if (decl.persist) this.storage.set(STORAGE_PREFIX + key, JSON.stringify(value));
    this.onChange?.(key, value, previous);
  }

  /** Numbers only; the common `score + 1` case without a read-modify-write. */
  add(key: string, delta: number): void {
    const decl = this.declFor(key);
    if (decl.type !== 'number') {
      throw new Error(`ctx.state.add only works on numbers; "${key}" is a ${decl.type}.`);
    }
    this.set(key, (this.values.get(key) as number) + delta);
  }

  /** Restore one key to its declared initial value, or every key when omitted. */
  reset(key?: string): void {
    if (key !== undefined) {
      this.set(key, this.declFor(key).initial);
      return;
    }
    for (const [k, decl] of Object.entries(this.decls)) this.set(k, decl.initial);
  }

  private declFor(key: string): GameStateDecl {
    const decl = this.decls[key];
    if (!decl) {
      throw new Error(`Unknown game state key "${key}". Declare it in hearth.json gameState.`);
    }
    return decl;
  }
}
