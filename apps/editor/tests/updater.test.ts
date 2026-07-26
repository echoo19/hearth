import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireUpdater, type UpdaterLike, type UpdaterDeps } from '../electron/updater';

/**
 * wireUpdater is the whole updater behavior with the Electron pieces injected
 * (the electron-updater autoUpdater instance, the native dialog, and
 * shell.openExternal), so every flow is testable without an Electron process:
 *
 *  - auto mode (Windows/Linux): silent download, install on quit, one
 *    "restart now?" prompt when the download lands;
 *  - notify mode (macOS until signed builds ship): never downloads, one
 *    prompt per version offering the download page;
 *  - background failures log and stay quiet; only a user-invoked
 *    "Check for updates…" surfaces results (up to date / error) in a dialog;
 *  - downgrades are permitted in every live mode, because the 0.1.0 pivot
 *    reset the version line below the retired 1.x engine's.
 */

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = false;
  checkForUpdates = vi.fn(async () => null);
  quitAndInstall = vi.fn();
}

function deps(over: Partial<UpdaterDeps> = {}): UpdaterDeps & { updater: FakeUpdater } {
  return {
    updater: new FakeUpdater(),
    policy: { mode: 'auto' },
    prompt: vi.fn(async () => 1),
    openDownloadPage: vi.fn(),
    log: vi.fn(),
    ...over,
  } as UpdaterDeps & { updater: FakeUpdater };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('wireUpdater', () => {
  it('does nothing when the policy is off', () => {
    const d = deps({ policy: { mode: 'off' } });
    const handle = wireUpdater(d);
    expect(handle).toBeNull();
    expect(d.updater.listenerCount('update-available')).toBe(0);
    expect(d.updater.checkForUpdates).not.toHaveBeenCalled();
    // Nothing is configured at all when updates are off — including the
    // downgrade allowance, which only matters once a feed is being consulted.
    expect(d.updater.allowDowngrade).toBe(false);
  });

  // The 0.1.0 pivot published a version *lower* than the retired 1.x engine's
  // 1.2.1. electron-updater rejects a lower feed version as a downgrade unless
  // this is set, which would strand every 1.x install permanently.
  it.each(['auto', 'notify'] as const)('allows deliberate downgrades in %s mode', (mode) => {
    const d = deps({ policy: { mode } });
    wireUpdater(d);
    expect(d.updater.allowDowngrade).toBe(true);
  });

  it('auto mode downloads silently and installs on quit', () => {
    const d = deps({ policy: { mode: 'auto' } });
    wireUpdater(d);
    expect(d.updater.autoDownload).toBe(true);
    expect(d.updater.autoInstallOnAppQuit).toBe(true);
    // A background "update available" stays silent — the download just runs.
    d.updater.emit('update-available', { version: '9.9.9' });
    expect(d.prompt).not.toHaveBeenCalled();
  });

  // No modal on download: the sidebar banner is the one surface for "restart
  // when you like", and a dialog on top of it would ask the same question
  // twice. The update still installs on quit either way.
  it('auto mode stays quiet when the download lands — the banner carries it', async () => {
    const d = deps({ policy: { mode: 'auto' }, prompt: vi.fn(async () => 0) });
    wireUpdater(d);
    d.updater.emit('update-downloaded', { version: '9.9.9' });
    await flush();
    expect(d.prompt).not.toHaveBeenCalled();
    expect(d.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  // The sidebar's "Relaunch to update" banner is driven from here: the modal
  // can only be answered once, but the banner stays until it is acted on.
  it('announces a downloaded update to the renderer', async () => {
    const onUpdateReady = vi.fn();
    const d = deps({ policy: { mode: 'auto' }, prompt: vi.fn(async () => 1), onUpdateReady });
    wireUpdater(d);
    d.updater.emit('update-downloaded', { version: '9.9.9' });
    await flush();
    expect(onUpdateReady).toHaveBeenCalledWith({ version: '9.9.9' });
  });

  it('never announces a download in notify mode, where nothing was downloaded', async () => {
    const onUpdateReady = vi.fn();
    const d = deps({ policy: { mode: 'notify' }, prompt: vi.fn(async () => 1), onUpdateReady });
    wireUpdater(d);
    d.updater.emit('update-downloaded', { version: '9.9.9' });
    await flush();
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('relaunches only once an update has actually landed', async () => {
    const d = deps({ policy: { mode: 'auto' }, prompt: vi.fn(async () => 1) });
    const handle = wireUpdater(d)!;
    // Quitting with nothing staged would just close the app on someone who
    // asked to be updated.
    handle.relaunchToUpdate();
    expect(d.updater.quitAndInstall).not.toHaveBeenCalled();
    d.updater.emit('update-downloaded', { version: '9.9.9' });
    await flush();
    handle.relaunchToUpdate();
    expect(d.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('notify mode never downloads and points at the download page', async () => {
    const d = deps({ policy: { mode: 'notify' }, prompt: vi.fn(async () => 0) });
    wireUpdater(d);
    expect(d.updater.autoDownload).toBe(false);
    d.updater.emit('update-available', { version: '2.0.0' });
    await flush();
    expect(d.prompt).toHaveBeenCalledTimes(1);
    expect(d.openDownloadPage).toHaveBeenCalledTimes(1);
    expect(d.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('notify mode prompts once per version per session', async () => {
    const d = deps({ policy: { mode: 'notify' }, prompt: vi.fn(async () => 1) });
    wireUpdater(d);
    d.updater.emit('update-available', { version: '2.0.0' });
    await flush();
    d.updater.emit('update-available', { version: '2.0.0' });
    await flush();
    expect(d.prompt).toHaveBeenCalledTimes(1);
    // A genuinely newer version prompts again.
    d.updater.emit('update-available', { version: '2.1.0' });
    await flush();
    expect(d.prompt).toHaveBeenCalledTimes(2);
  });

  it('background errors log and never open a dialog', async () => {
    const d = deps({ policy: { mode: 'auto' } });
    wireUpdater(d);
    d.updater.emit('error', new Error('offline'));
    await flush();
    expect(d.log).toHaveBeenCalled();
    expect(d.prompt).not.toHaveBeenCalled();
  });

  it('an interactive check reports "up to date" in a dialog', async () => {
    const d = deps({ policy: { mode: 'auto' } });
    const handle = wireUpdater(d)!;
    d.updater.checkForUpdates.mockImplementation(async () => {
      d.updater.emit('update-not-available', { version: '1.0.0' });
      return null;
    });
    await handle.checkNow();
    expect(d.prompt).toHaveBeenCalledTimes(1);
    const p = (d.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(p.message.toLowerCase()).toContain('up to date');
  });

  it('an interactive check surfaces failures in a dialog', async () => {
    const d = deps({ policy: { mode: 'auto' } });
    const handle = wireUpdater(d)!;
    d.updater.checkForUpdates.mockImplementation(async () => {
      d.updater.emit('error', new Error('feed unreachable'));
      return null;
    });
    await handle.checkNow();
    expect(d.prompt).toHaveBeenCalledTimes(1);
    const p = (d.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(`${p.message} ${p.detail ?? ''}`).toContain('feed unreachable');
  });

  it('a background check runs without prompting even when the check rejects', async () => {
    const d = deps({ policy: { mode: 'auto' } });
    const handle = wireUpdater(d)!;
    d.updater.checkForUpdates.mockRejectedValue(new Error('offline'));
    handle.checkBackground();
    await flush();
    expect(d.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(d.prompt).not.toHaveBeenCalled();
  });

  it('an interactive check in auto mode acknowledges that the download started', async () => {
    const d = deps({ policy: { mode: 'auto' } });
    const handle = wireUpdater(d)!;
    d.updater.checkForUpdates.mockImplementation(async () => {
      d.updater.emit('update-available', { version: '3.0.0' });
      return null;
    });
    await handle.checkNow();
    expect(d.prompt).toHaveBeenCalledTimes(1);
    const p = (d.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(p.message).toContain('3.0.0');
    expect(d.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('an interactive check in notify mode re-offers an already-seen version', async () => {
    const d = deps({ policy: { mode: 'notify' }, prompt: vi.fn(async () => 1) });
    const handle = wireUpdater(d)!;
    d.updater.emit('update-available', { version: '2.0.0' });
    await flush();
    expect(d.prompt).toHaveBeenCalledTimes(1);
    d.updater.checkForUpdates.mockImplementation(async () => {
      d.updater.emit('update-available', { version: '2.0.0' });
      return null;
    });
    await handle.checkNow();
    expect(d.prompt).toHaveBeenCalledTimes(2);
  });
});
