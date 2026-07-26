/**
 * Launcher plumbing: the busy-label contract (a slow filesystem must never
 * look like nothing happened) and the reset guarantee (a rejected picker must
 * never strand the launcher disabled).
 */
import { describe, expect, it, vi } from 'vitest';
import { launcherButtonLabel, withBusy, type LauncherBusy } from '../src/components/Launcher';

describe('launcherButtonLabel', () => {
  it('shows the idle label while nothing is in flight', () => {
    expect(launcherButtonLabel(null, 'start', 'Choose a folder…')).toBe('Choose a folder…');
    expect(launcherButtonLabel(null, 'open', 'Open')).toBe('Open');
  });

  it('only changes the door that is actually working', () => {
    expect(launcherButtonLabel('open', 'start', 'Choose a folder…')).toBe('Choose a folder…');
    expect(launcherButtonLabel('open', 'open', 'Open')).toBe('Opening…');
    expect(launcherButtonLabel('start', 'start', 'Choose a folder…')).toBe('Opening…');
  });
});

describe('withBusy', () => {
  it('marks busy for the run, then clears', async () => {
    const seen: LauncherBusy[] = [];
    const setBusy = (busy: LauncherBusy): void => void seen.push(busy);
    const result = await withBusy('open', setBusy, async () => 'done');
    expect(result).toBe('done');
    expect(seen).toEqual(['open', null]);
  });

  it('clears even when the work rejects', async () => {
    const setBusy = vi.fn();
    await expect(
      withBusy('start', setBusy, async () => {
        throw new Error('picker cancelled');
      }),
    ).rejects.toThrow('picker cancelled');
    expect(setBusy).toHaveBeenNthCalledWith(1, 'start');
    expect(setBusy).toHaveBeenLastCalledWith(null);
  });
});
