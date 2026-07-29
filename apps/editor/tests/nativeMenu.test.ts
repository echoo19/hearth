// @vitest-environment jsdom
/**
 * The native-menu bridge. `useNativeAppMenu` ships the serialized model to the
 * main process and routes a `menu:invoke <id>` echo back to the matching
 * model item's live `onSelect` — the half that only exists in the renderer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useNativeAppMenu, useNativeMenu } from '../src/menu/nativeMenu';
import { useApp } from '../src/store';
import type { AppMenuSection } from '../src/menu/appMenu';

interface NativeStub {
  platform: string;
  setAppMenu?: ReturnType<typeof vi.fn>;
  onMenuInvoke?: ReturnType<typeof vi.fn>;
}

function installNative(native: NativeStub | null): NativeStub | null {
  if (native) (window as unknown as { hearthNative?: NativeStub }).hearthNative = native;
  else delete (window as unknown as { hearthNative?: NativeStub }).hearthNative;
  return native;
}

function macNative(): NativeStub & { invoke: (id: string) => void } {
  let handler: ((id: string) => void) | null = null;
  const native = {
    platform: 'darwin',
    setAppMenu: vi.fn(),
    onMenuInvoke: vi.fn((cb: (id: string) => void) => {
      handler = cb;
      return () => {
        handler = null;
      };
    }),
    invoke: (id: string) => handler?.(id),
  };
  installNative(native);
  return native;
}

function sections(onSelect: () => void): AppMenuSection[] {
  return [
    {
      id: 'file',
      label: 'File',
      items: [
        { id: 'open-folder', label: 'Open folder…', enabled: true, onSelect },
        { separator: true },
        { id: 'close-folder', label: 'Close folder', enabled: false, onSelect: () => undefined },
      ],
    },
  ];
}

afterEach(() => {
  cleanup();
  installNative(null);
});

describe('useNativeAppMenu', () => {
  it('pushes the serialized model to the main process', () => {
    const native = macNative();
    renderHook(() => useNativeAppMenu(sections(vi.fn())));
    expect(native.setAppMenu).toHaveBeenCalledTimes(1);
    const pushed = native.setAppMenu!.mock.calls[0][0];
    expect(pushed[0].label).toBe('File');
    expect(pushed[0].items[0]).toMatchObject({ id: 'open-folder', enabled: true });
    expect(pushed[0].items[1]).toEqual({ type: 'separator' });
  });

  it('routes a menu:invoke echo to the matching item onSelect', () => {
    const native = macNative();
    const onSelect = vi.fn();
    renderHook(() => useNativeAppMenu(sections(onSelect)));
    native.invoke('open-folder');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('ignores an id no item claims', () => {
    const native = macNative();
    const onSelect = vi.fn();
    renderHook(() => useNativeAppMenu(sections(onSelect)));
    native.invoke('not-a-menu-item');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('restores the baseline menu on unmount', () => {
    const native = macNative();
    const view = renderHook(() => useNativeAppMenu(sections(vi.fn())));
    view.unmount();
    expect(native.setAppMenu).toHaveBeenLastCalledWith(null);
  });

  it('does nothing in the browser, where there is no application menu', () => {
    installNative(null);
    expect(() => renderHook(() => useNativeAppMenu(sections(vi.fn())))).not.toThrow();
  });
});

/**
 * The ticks in the View menu are a claim about the app, so they have to be
 * rebuilt out of the state they are a claim about.
 *
 * The hook subscribes to every field the model reads. `paneOpen` was not one
 * of them, which is three items at once: the playtest column itself and both
 * of the column's surfaces, whose ticks are `paneOpen && paneTab === …`. So
 * opening or closing the column from anywhere else in the app left the menu
 * ticking the opposite of what was on screen until something unrelated
 * happened to move.
 */
describe('useNativeMenu', () => {
  /** The View item for the playtest column, out of the last model pushed. */
  const paneItem = (native: NativeStub): { checked?: boolean } => {
    const calls = native.setAppMenu!.mock.calls;
    const pushed = calls[calls.length - 1][0] as { label: string; items: { id?: string; checked?: boolean }[] }[];
    const view = pushed.find((section) => section.label === 'View');
    const item = view?.items.find((entry) => entry.id === 'pane');
    if (!item) throw new Error('no playtest-column item in the View menu');
    return item;
  };

  it('follows the playtest column, which is the tick it is about', () => {
    const native = macNative();
    useApp.setState({ projectPath: '/work/ember', projectName: 'ember', paneOpen: false, paneTab: 'game' });

    renderHook(() => useNativeMenu());
    expect(paneItem(native).checked).toBe(false);

    act(() => {
      useApp.setState({ paneOpen: true });
    });
    expect(paneItem(native).checked).toBe(true);
  });
});
