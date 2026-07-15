import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store';

/**
 * Play-mode session continuity (L-067): switching the Game tab away from a
 * running preview must PAUSE it (halt rAF/audio, keep the run + its state),
 * not Stop it, so the "open Code, edit, hot-reload while playing" workflow is
 * reachable. Switching back auto-resumes UNLESS the user explicitly paused
 * first. These pin setGameTabVisible / setPaused's ownership handoff purely at
 * the store level (no DOM, no runtime).
 */
describe('play-mode session continuity — setGameTabVisible', () => {
  beforeEach(() => {
    // A clean running session: playing, not paused, nobody owns a pause yet.
    useEditor.setState({ playing: true, paused: false, pausedByTab: false, runNonce: 1 });
  });
  afterEach(() => {
    useEditor.setState({ playing: false, paused: false, pausedByTab: false });
  });

  it('pauses (not stops) a running preview when the Game tab is hidden', () => {
    const before = useEditor.getState().runNonce;
    useEditor.getState().setGameTabVisible(false);
    const s = useEditor.getState();
    expect(s.playing).toBe(true); // still a live run — NOT a Stop
    expect(s.paused).toBe(true);
    expect(s.pausedByTab).toBe(true);
    expect(s.runNonce).toBe(before); // no remount was triggered
  });

  it('auto-resumes when the Game tab is shown again after a tab-pause', () => {
    useEditor.getState().setGameTabVisible(false);
    useEditor.getState().setGameTabVisible(true);
    const s = useEditor.getState();
    expect(s.playing).toBe(true);
    expect(s.paused).toBe(false);
    expect(s.pausedByTab).toBe(false);
  });

  it('preserves an explicit pause across a hide/show round trip', () => {
    useEditor.getState().setPaused(true); // user explicitly paused
    expect(useEditor.getState().pausedByTab).toBe(false);
    useEditor.getState().setGameTabVisible(false); // tab away
    expect(useEditor.getState().paused).toBe(true);
    expect(useEditor.getState().pausedByTab).toBe(false); // still user-owned
    useEditor.getState().setGameTabVisible(true); // tab back
    const s = useEditor.getState();
    expect(s.paused).toBe(true); // NOT auto-resumed
    expect(s.pausedByTab).toBe(false);
  });

  it('an explicit Resume while tab-paused takes ownership (no re-pause churn)', () => {
    useEditor.getState().setGameTabVisible(false); // tab-paused
    expect(useEditor.getState().pausedByTab).toBe(true);
    useEditor.getState().setPaused(false); // user resumes from the (global) toolbar
    const s = useEditor.getState();
    expect(s.paused).toBe(false);
    expect(s.pausedByTab).toBe(false);
  });

  it('is a no-op when nothing is playing', () => {
    useEditor.setState({ playing: false, paused: false, pausedByTab: false });
    useEditor.getState().setGameTabVisible(false);
    const s = useEditor.getState();
    expect(s.playing).toBe(false);
    expect(s.paused).toBe(false);
    expect(s.pausedByTab).toBe(false);
  });

  it('Play and Stop both clear a tab-pause', () => {
    useEditor.getState().setGameTabVisible(false);
    expect(useEditor.getState().pausedByTab).toBe(true);
    useEditor.getState().setPlaying(false); // Stop
    expect(useEditor.getState().pausedByTab).toBe(false);
    expect(useEditor.getState().paused).toBe(false);
  });

  it('restartPlay while tab-paused restarts unpaused and bumps runNonce (the Workspace surface trigger)', () => {
    // Restart clicked from another tab (e.g. Code) while the run is tab-paused:
    // the new run must come up unpaused, and runNonce must bump — Workspace's
    // surface-Game effect keys on [playing, runNonce], so the bump is what
    // brings the Game tab forward (review I2).
    useEditor.getState().setGameTabVisible(false);
    expect(useEditor.getState().pausedByTab).toBe(true);
    const before = useEditor.getState().runNonce;
    useEditor.getState().restartPlay();
    const s = useEditor.getState();
    expect(s.playing).toBe(true);
    expect(s.paused).toBe(false);
    expect(s.pausedByTab).toBe(false);
    expect(s.runNonce).toBe(before + 1);
  });

  it('live dispatch still applies while tab-paused (playing-gate passes)', async () => {
    // The hot-reload/live-patch path is gated on `playing`, not `paused`: a
    // tab-paused run must still receive journal entries (this is what makes
    // edit-on-the-Code-tab-then-return work). A structural external entry is
    // the cheapest network-free probe — it must raise the restart badge.
    useEditor.setState({ pendingRestart: false });
    useEditor.getState().setGameTabVisible(false); // tab-paused, still playing
    await useEditor.getState().applyExternalJournalEntry({
      seq: 1,
      ts: new Date().toISOString(),
      source: 'cli',
      command: 'createEntity',
      summary: 'created entity',
      ok: true,
    });
    expect(useEditor.getState().pendingRestart).toBe(true);
    // Contrast: when stopped, the same entry is ignored.
    useEditor.setState({ playing: false, paused: false, pausedByTab: false, pendingRestart: false });
    await useEditor.getState().applyExternalJournalEntry({
      seq: 2,
      ts: new Date().toISOString(),
      source: 'cli',
      command: 'createEntity',
      summary: 'created entity',
      ok: true,
    });
    expect(useEditor.getState().pendingRestart).toBe(false);
  });

  it('repeated hide/show cycles stay consistent (no ownership drift)', () => {
    const s = () => useEditor.getState();
    s().setGameTabVisible(false);
    expect([s().paused, s().pausedByTab]).toEqual([true, true]);
    s().setGameTabVisible(true);
    expect([s().paused, s().pausedByTab]).toEqual([false, false]);
    s().setGameTabVisible(false);
    expect([s().paused, s().pausedByTab]).toEqual([true, true]);
    s().setGameTabVisible(true);
    expect([s().paused, s().pausedByTab]).toEqual([false, false]);
    expect(s().playing).toBe(true); // never stopped across the cycles
  });
});
