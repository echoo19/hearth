/**
 * Auto-update policy — a pure decision, kept free of Electron imports so the
 * behavior is unit-testable (tests/updaterPolicy.test.ts).
 *
 * Windows and Linux self-update fully: electron-updater works against the
 * unsigned NSIS installer / AppImage the release workflow already builds
 * (Windows code signing only affects the first manual install's SmartScreen
 * prompt, not updater-applied updates).
 *
 * macOS self-updates in place too: Squirrel.Mac validates the downloaded app's
 * code signature against the running app's, and CI now ships Developer-ID-
 * signed, notarized builds (MAC_CSC_LINK + Apple notarization secrets are set
 * on the release workflow), so the check passes. Users on older ad-hoc builds
 * still need one manual re-download to get onto the signed line.
 */

export const MAC_AUTO_UPDATE = true;

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
