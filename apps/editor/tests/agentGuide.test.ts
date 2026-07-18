import { describe, expect, it } from 'vitest';
import {
  dismissAgentGuide,
  isAgentGuideDismissed,
  agentGuideStorageKey,
} from '../src/components/agent/guide';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('Agent beginner guide persistence', () => {
  it('scopes dismissal to one project', () => {
    const storage = new MemoryStorage();
    dismissAgentGuide('/games/one', storage);

    expect(isAgentGuideDismissed('/games/one', storage)).toBe(true);
    expect(isAgentGuideDismissed('/games/two', storage)).toBe(false);
    expect(storage.values.get(agentGuideStorageKey('/games/one'))).toBe('1');
  });

  it('keeps the guide visible when storage is unavailable', () => {
    const broken = {
      getItem(): string | null {
        throw new Error('blocked');
      },
      setItem(): void {
        throw new Error('blocked');
      },
    };

    expect(isAgentGuideDismissed('/games/one', broken)).toBe(false);
    expect(() => dismissAgentGuide('/games/one', broken)).not.toThrow();
  });
});
