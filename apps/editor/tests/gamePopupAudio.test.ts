/**
 * GamePopupAudio (electron/main.ts) is the fix for the game-mute gap: muting
 * the pane only ever reached the main window's webContents, and Play opens
 * the same game again in its own top-level popup window — a second
 * webContents the old handler never touched, so a muted pane still played the
 * game out loud the moment someone hit Play.
 *
 * These pin the class on its own, the same way electron/updater.ts's
 * UpdaterLike lets wireUpdater be tested without an Electron process:
 * GamePopupAudio takes only the two webContents calls it needs (setAudioMuted,
 * isDestroyed) as a structural interface, so no window-open handler, no real
 * BrowserWindow, and no 'electron' import is needed to exercise it.
 *
 * electron/main.ts itself still touches real Electron APIs at module scope
 * (app.on('window-all-closed', ...), the trailing main().catch(...)) the way
 * every other file in electron/ that isn't DI-shaped does, so 'electron' is
 * stubbed just enough that importing the module doesn't throw — whenReady
 * never resolving keeps main() parked on its first line and nothing past that
 * point (server startup, window creation, the IPC handlers) ever runs.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    // Never resolves: main() awaits this first, so nothing past it (real
    // server/window/IPC setup) executes just because the module was imported.
    whenReady: () => new Promise(() => {}),
    quit: vi.fn(),
    exit: vi.fn(),
    isPackaged: false,
  },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: vi.fn() },
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('electron-updater', () => ({ autoUpdater: {} }));

import { GamePopupAudio, type MutableWebContents } from '../electron/main';

function fakeWebContents(): MutableWebContents & { setAudioMuted: ReturnType<typeof vi.fn> } {
  let destroyed = false;
  return {
    setAudioMuted: vi.fn(),
    isDestroyed: () => destroyed,
    // Test-only escape hatch to simulate a popup that closed on its own.
    _destroy(): void {
      destroyed = true;
    },
  } as unknown as MutableWebContents & { setAudioMuted: ReturnType<typeof vi.fn>; _destroy(): void };
}

describe('GamePopupAudio', () => {
  it('starts unmuted, so a popup opened before any toggle is not silenced by default', () => {
    const audio = new GamePopupAudio();
    const wc = fakeWebContents();
    audio.track(wc);
    expect(wc.setAudioMuted).toHaveBeenCalledWith(false);
  });

  it('mutes a popup that opens while already muted, not just future ones', () => {
    // This is the bug: a popup opened after the pane was muted used to come
    // up making noise, because nothing ever told the new window about the
    // state that already existed.
    const audio = new GamePopupAudio();
    audio.setMuted(true);
    const wc = fakeWebContents();
    audio.track(wc);
    expect(wc.setAudioMuted).toHaveBeenCalledWith(true);
  });

  it('propagates a live toggle to every popup already open', () => {
    const audio = new GamePopupAudio();
    const a = fakeWebContents();
    const b = fakeWebContents();
    audio.track(a);
    audio.track(b);
    audio.setMuted(true);
    expect(a.setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(b.setAudioMuted).toHaveBeenLastCalledWith(true);
    audio.setMuted(false);
    expect(a.setAudioMuted).toHaveBeenLastCalledWith(false);
    expect(b.setAudioMuted).toHaveBeenLastCalledWith(false);
  });

  it('does not chase a popup after it closes', () => {
    const audio = new GamePopupAudio();
    const wc = fakeWebContents();
    audio.track(wc);
    (wc as unknown as { _destroy(): void })._destroy();
    wc.setAudioMuted.mockClear();
    audio.setMuted(true);
    expect(wc.setAudioMuted).not.toHaveBeenCalled();
  });

  it('keeps a second popup independent of a first that already closed', () => {
    const audio = new GamePopupAudio();
    const closed = fakeWebContents();
    const open = fakeWebContents();
    audio.track(closed);
    (closed as unknown as { _destroy(): void })._destroy();
    audio.track(open);
    open.setAudioMuted.mockClear();
    audio.setMuted(true);
    expect(open.setAudioMuted).toHaveBeenCalledWith(true);
  });
});
