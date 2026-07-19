/**
 * Auto-update policy — a pure decision, kept free of Electron imports so the
 * behavior is unit-testable (tests/updaterPolicy.test.ts).
 *
 * Windows and Linux self-update fully: electron-updater works against the
 * unsigned NSIS installer / AppImage the release workflow already builds
 * (Windows code signing only affects the first manual install's SmartScreen
 * prompt, not updater-applied updates).
 *
 * macOS is notify-only for now: Squirrel.Mac validates the downloaded app's
 * code signature against the running app's, and the release builds are ad-hoc
 * signed — they can never pass that check. Flip MAC_AUTO_UPDATE once CI ships
 * Developer-ID-signed, notarized builds (MAC_CSC_LINK + notarization secrets
 * in the release workflow); users on older ad-hoc builds still need one
 * manual re-download to get onto the signed line.
 */

export const MAC_AUTO_UPDATE = false;

export interface UpdatePolicy {
  mode: 'off' | 'auto' | 'notify';
}

export function resolveUpdatePolicy(opts: {
  platform: NodeJS.Platform;
  packaged: boolean;
  env: Record<string, string | undefined>;
}): UpdatePolicy {
  const { platform, packaged, env } = opts;
  if (!packaged) return { mode: 'off' };
  if (env.HEARTH_SMOKE === '1') return { mode: 'off' };
  if (env.HEARTH_DISABLE_UPDATES === '1') return { mode: 'off' };
  if (platform === 'win32' || platform === 'linux') return { mode: 'auto' };
  if (platform === 'darwin') return { mode: MAC_AUTO_UPDATE ? 'auto' : 'notify' };
  return { mode: 'off' };
}
