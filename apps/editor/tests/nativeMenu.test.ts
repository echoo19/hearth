// @vitest-environment jsdom
/**
 * useShowInWindowMenuBar — Wave L Task 6 review fix.
 *
 * Pins the platform gate documented at nativeMenu.ts:55: the in-window
 * MenuBar renders everywhere except Electron on macOS, where the native
 * application menu (menu/nativeMenu.ts's useNativeAppMenu) takes over.
 * `native === null` covers both the plain browser and the not-yet-detected
 * startup tick, including a macOS browser tab — the in-window bar must still
 * show there since there's no native menu to fall back to.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

let nativeMock: { platform: string } | null = null;

vi.mock('../src/native', () => ({
  hearthNative: () => nativeMock,
}));

import { useShowInWindowMenuBar } from '../src/menu/nativeMenu';

describe('useShowInWindowMenuBar', () => {
  it('shows the in-window bar when there is no native bridge (browser)', () => {
    nativeMock = null;
    const { result } = renderHook(() => useShowInWindowMenuBar());
    expect(result.current).toBe(true);
  });

  it('hides the in-window bar on Electron macOS (native menu takes over)', () => {
    nativeMock = { platform: 'darwin' };
    const { result } = renderHook(() => useShowInWindowMenuBar());
    expect(result.current).toBe(false);
  });

  it('shows the in-window bar on Electron Windows', () => {
    nativeMock = { platform: 'win32' };
    const { result } = renderHook(() => useShowInWindowMenuBar());
    expect(result.current).toBe(true);
  });
});
