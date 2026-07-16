// @vitest-environment jsdom
/**
 * L-114: native window/tab close must respect the Code panel's dirty script
 * buffers. The renderer mirrors that single dirty boolean to Electron and only
 * installs a browser beforeunload prompt while scripts are actually dirty.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let nativeMock: { setUnsavedScripts?: (has: boolean) => void } | null = null;

vi.mock('../src/native', () => ({
  hearthNative: () => nativeMock,
}));

import { useUnsavedScriptsCloseGuard } from '../src/unsavedScriptsCloseGuard';

afterEach(() => {
  nativeMock = null;
});

describe('useUnsavedScriptsCloseGuard', () => {
  it('mirrors the dirty-script flag to Electron whenever it changes', () => {
    const setUnsavedScripts = vi.fn();
    nativeMock = { setUnsavedScripts };

    const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedScriptsCloseGuard(dirty), {
      initialProps: { dirty: false },
    });

    expect(setUnsavedScripts).toHaveBeenLastCalledWith(false);
    rerender({ dirty: true });
    expect(setUnsavedScripts).toHaveBeenLastCalledWith(true);
    unmount();
    expect(setUnsavedScripts).toHaveBeenLastCalledWith(false);
  });

  it('registers beforeunload only while scripts are dirty', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedScriptsCloseGuard(dirty), {
      initialProps: { dirty: false },
    });

    expect(add).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));

    rerender({ dirty: true });
    expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    const handler = add.mock.calls.find(([type]) => type === 'beforeunload')?.[1] as (event: BeforeUnloadEvent) => void;
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    handler(event);
    expect(event.defaultPrevented).toBe(true);

    rerender({ dirty: false });
    expect(remove).toHaveBeenCalledWith('beforeunload', handler);
    unmount();
  });

  it('never registers beforeunload under Electron (native dialog owns close)', () => {
    nativeMock = { setUnsavedScripts: vi.fn() };
    const add = vi.spyOn(window, 'addEventListener');

    const { unmount } = renderHook(({ dirty }) => useUnsavedScriptsCloseGuard(dirty), {
      initialProps: { dirty: true },
    });

    expect(add).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));
    unmount();
  });
});
