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
 *    "Check for updates…" surfaces results (up to date / error) in a dialog.
 */

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
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

  it('auto mode offers a restart once the download lands, and restarts on accept', async () => {
    const d = deps({ policy: { mode: 'auto' }, prompt: vi.fn(async () => 0) });
    wireUpdater(d);
    d.updater.emit('update-downloaded', { version: '9.9.9' });
    await flush();
    expect(d.prompt).toHaveBeenCalledTimes(1);
    const p = (d.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(p.message).toContain('9.9.9');
    expect(p.buttons[0]).toBe('Restart now');
    expect(d.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('auto mode leaves the update for quit when the restart is declined', async () => {
    const d = deps({ policy: { mode: 'auto' }, prompt: vi.fn(async () => 1) });
    wireUpdater(d);
    d.updater.emit('update-downloaded', { version: '9.9.9' });
    await flush();
    expect(d.updater.quitAndInstall).not.toHaveBeenCalled();
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
