// @vitest-environment jsdom
/**
 * useShowInWindowMenuBar — review fix.
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

let nativeMock: { platform: string; setAppMenu?: () => void } | null = null;

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

  it('hides the in-window bar on a healthy Electron macOS build (native menu takes over)', () => {
    // Healthy build: the preload exposes setAppMenu, so the native menu owns it.
    nativeMock = { platform: 'darwin', setAppMenu: () => {} };
    const { result } = renderHook(() => useShowInWindowMenuBar());
    expect(result.current).toBe(false);
  });

  it('shows the in-window bar on macOS when the preload lacks setAppMenu (stale preload, L-123 hardening)', () => {
    // A stale/failed preload can't install the native menu — fall back to the
    // in-window bar instead of stranding the user with no menu at all.
    nativeMock = { platform: 'darwin' };
    const { result } = renderHook(() => useShowInWindowMenuBar());
    expect(result.current).toBe(true);
  });

  it('shows the in-window bar on Electron Windows', () => {
    nativeMock = { platform: 'win32' };
    const { result } = renderHook(() => useShowInWindowMenuBar());
    expect(result.current).toBe(true);
  });
});
