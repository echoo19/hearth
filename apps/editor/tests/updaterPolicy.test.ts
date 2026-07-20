import { describe, it, expect } from 'vitest';
import { resolveUpdatePolicy } from '../electron/updaterPolicy';

/**
 * Auto-update policy: which platforms self-update, which only notify, and
 * when the updater must stay off entirely. macOS is notify-only until CI
 * ships Developer-ID-signed builds — Squirrel.Mac refuses to swap an app
 * whose signature it can't validate, and the ad-hoc-signed release builds
 * can never pass that check (see electron/updaterPolicy.ts).
 */
describe('resolveUpdatePolicy', () => {
  const base = { platform: 'win32' as NodeJS.Platform, packaged: true, env: {} as Record<string, string | undefined> };

  it('is off in unpackaged (dev) runs', () => {
    expect(resolveUpdatePolicy({ ...base, packaged: false })).toEqual({ mode: 'off' });
  });

  it('is off in smoke self-test runs', () => {
    expect(resolveUpdatePolicy({ ...base, env: { HEARTH_SMOKE: '1' } })).toEqual({ mode: 'off' });
  });

  it('is off when the user opts out via HEARTH_DISABLE_UPDATES', () => {
    expect(resolveUpdatePolicy({ ...base, env: { HEARTH_DISABLE_UPDATES: '1' } })).toEqual({ mode: 'off' });
  });

  it('fully auto-updates on Windows and Linux', () => {
    expect(resolveUpdatePolicy({ ...base, platform: 'win32' })).toEqual({ mode: 'auto' });
    expect(resolveUpdatePolicy({ ...base, platform: 'linux' })).toEqual({ mode: 'auto' });
  });

  it('fully auto-updates on macOS now that CI ships notarized builds', () => {
    expect(resolveUpdatePolicy({ ...base, platform: 'darwin' })).toEqual({ mode: 'auto' });
  });

  it('is off on platforms the release workflow does not build for', () => {
    expect(resolveUpdatePolicy({ ...base, platform: 'freebsd' })).toEqual({ mode: 'off' });
  });
});
