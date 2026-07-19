/**
 * Auto-updater behavior, with every Electron-touching piece injected
 * (electron-updater's autoUpdater, the native message box, shell.openExternal)
 * so the flows are unit-testable without an Electron process — see
 * tests/updater.test.ts. main.ts owns the real glue.
 *
 * Modes (electron/updaterPolicy.ts):
 *  - auto (Windows/Linux): download silently, install on quit; one
 *    "Restart now?" prompt when the download lands.
 *  - notify (macOS until CI ships signed builds): never download — offer the
 *    download page once per version, plus whenever the user asks explicitly.
 *
 * Background checks are quiet on failure (being offline is normal); only a
 * user-invoked check surfaces "up to date" / errors in a dialog.
 */
import type { UpdatePolicy } from './updaterPolicy.js';

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // Node EventEmitter-shaped on purpose (electron-updater extends it); any[]
  // matches @types/node's listener signature so real and fake emitters fit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdatePrompt {
  title: string;
  message: string;
  detail?: string;
  /** Index 0 is the primary action; the last index is the safe dismissal. */
  buttons: string[];
}

export interface UpdaterDeps {
  updater: UpdaterLike;
  policy: UpdatePolicy;
  /** Show a native message box; resolves to the clicked button index. */
  prompt: (p: UpdatePrompt) => Promise<number>;
  openDownloadPage: () => void;
  log: (message: string) => void;
}

export interface UpdaterHandle {
  /** User-invoked check (Help → Check for updates…); resolves when answered. */
  checkNow(): Promise<void>;
  /** Startup check: silent unless an update actually turns up. */
  checkBackground(): void;
}

interface UpdateInfoLike {
  version?: string;
}

export function wireUpdater(deps: UpdaterDeps): UpdaterHandle | null {
  const { updater, policy, prompt, openDownloadPage, log } = deps;
  if (policy.mode === 'off') return null;

  updater.autoDownload = policy.mode === 'auto';
  updater.autoInstallOnAppQuit = policy.mode === 'auto';

  const promptedVersions = new Set<string>();
  let interactive = false;
  let settle: (() => void) | null = null;
  const finishInteractive = (): void => {
    const s = settle;
    settle = null;
    interactive = false;
    s?.();
  };

  updater.on('update-available', (info: UpdateInfoLike) => {
    const version = info?.version ?? 'a new version';
    if (policy.mode === 'notify') {
      if (!promptedVersions.has(version) || interactive) {
        promptedVersions.add(version);
        void prompt({
          title: 'Update available',
          message: `Hearth ${version} is available.`,
          detail: 'Download the new version from hearthengine.com.',
          buttons: ['Download', 'Later'],
        }).then((choice) => {
          if (choice === 0) openDownloadPage();
        });
      }
    } else if (interactive) {
      void prompt({
        title: 'Downloading update',
        message: `Hearth ${version} is downloading.`,
        detail: "You'll be asked to restart once it's ready.",
        buttons: ['OK'],
      });
    }
    finishInteractive();
  });

  updater.on('update-not-available', () => {
    if (interactive) {
      void prompt({
        title: 'No updates',
        message: "You're up to date.",
        buttons: ['OK'],
      });
    }
    finishInteractive();
  });

  updater.on('update-downloaded', (info: UpdateInfoLike) => {
    if (policy.mode !== 'auto') return;
    const version = info?.version ?? 'A new version';
    void prompt({
      title: 'Update ready',
      message: `Hearth ${version} has been downloaded.`,
      detail: 'Restart to apply it now, or it installs when you quit.',
      buttons: ['Restart now', 'Later'],
    }).then((choice) => {
      if (choice === 0) updater.quitAndInstall();
    });
  });

  updater.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log(`update check failed: ${message}`);
    if (interactive) {
      void prompt({
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: message,
        buttons: ['OK'],
      });
    }
    finishInteractive();
  });

  return {
    checkNow(): Promise<void> {
      if (interactive) return Promise.resolve();
      interactive = true;
      return new Promise<void>((resolve) => {
        settle = resolve;
        // Failures also arrive via the 'error' event (which settles the
        // dialog flow); the rejection itself just needs defusing.
        Promise.resolve(updater.checkForUpdates()).catch(() => finishInteractive());
      });
    },
    checkBackground(): void {
      Promise.resolve(updater.checkForUpdates()).catch(() => {
        // Quiet by design: the 'error' listener above already logged it.
      });
    },
  };
}
