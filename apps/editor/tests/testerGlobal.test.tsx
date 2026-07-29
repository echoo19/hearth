// @vitest-environment jsdom
/**
 * The Tester screen as a place of its own.
 *
 * A playtest belongs to a game. The HISTORY of playtests belongs to you, so
 * this screen spans every game: it used to show only whichever project
 * happened to be open, silently, with a Play button aimed at a game it never
 * named. Reaching yesterday's run meant guessing which project it came from,
 * opening that project, then coming back.
 *
 * Two things have to hold, and the second one is the subtle one:
 *
 *   1. Runs from more than one game appear on one list, each wearing its own
 *      game's name, and opening a report does not switch project.
 *   2. A verdict is only ever read against the session BEFORE it IN THE SAME
 *      GAME. `testerRows` compares neighbours to say "last time you were told
 *      the opposite", so building rows from the mixed list would have session 4
 *      of one game answering session 9 of another. That is exactly the kind of
 *      confident wrong sentence the tester exists not to produce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiTesterHistory: vi.fn(async () => null),
  apiTesterHistoryAll: vi.fn(async () => null),
  apiRecentWorkspaces: vi.fn(async () => []),
  apiTesterPlay: vi.fn(async () => ({ ok: true })),
  apiGameStatus: vi.fn(async () => null),
  apiCloseWorkspace: vi.fn(async () => {}),
  // Play aims at a project that is usually not the open one, so this screen is
  // the one surface whose main act opens a folder. Everything that open reads
  // is answered here rather than over a socket that does not exist.
  apiOpenWorkspace: vi.fn(async (path: string) => ({
    ok: true,
    info: { path, name: path.split('/').pop() ?? path, isHearthProject: true },
  })),
  apiListChats: vi.fn(async () => []),
  apiRecentChats: vi.fn(async () => []),
  apiProbeStatus: vi.fn(async () => null),
  apiAppSettings: vi.fn(async () => null),
  apiChatProviders: vi.fn(async () => null),
  apiPermissionMode: vi.fn(async () => null),
}));

/** A socket that goes nowhere: these tests are about state, not frames. */
class DeadSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

import {
  TesterHistory,
  historyEmptyLead,
  runRows,
  skippedProjectsLine,
} from '../src/components/tester/TesterHistory';
import { ProjectSelector, selectorLabel, whereHints } from '../src/projects/ProjectSelector';
import { OPEN_FOLDER_EVENT } from '../src/components/shell/useOpenFolder';
import { FOCUS_SEARCH_EVENT } from '../src/components/shell/ShortcutLayer';
import { useApp } from '../src/store';
import {
  apiCloseWorkspace,
  apiGameStatus,
  apiOpenWorkspace,
  apiRecentWorkspaces,
  apiTesterPlay,
} from '../src/api';
import { currentToast, resetToasts } from '../src/toast';
import type { TesterNote } from '../server/tester/types';
import type { TesterRun } from '../src/types';

const LIGHTHOUSE = '/work/lighthouse';
const HARBOUR = '/work/harbour';

function note(session: number, verdict: 'better' | 'worse', finishedAt: string): TesterNote {
  return {
    session,
    startedAt: '2026-07-27T10:00:00.000Z',
    finishedAt,
    onTheChange: { seen: 'you changed the jump', verdict, why: 'it reads that way' },
    regression: 'nothing',
    observations: [],
    openQuestions: [],
    steps: 4,
    stopped: 'done',
  } as TesterNote;
}

const run = (path: string, name: string, note: TesterNote): TesterRun => ({ note, project: { path, name } });

beforeEach(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  useApp.setState({ projectPath: null, projectName: null, testerRuns: null, testerTarget: null });
  vi.stubGlobal('WebSocket', DeadSocket);
  // Re-armed here rather than only in the mock factory: `restoreAllMocks`
  // below strips the implementation off every one of these between tests.
  vi.mocked(apiOpenWorkspace).mockImplementation(async (path: string) => ({
    ok: true,
    info: { path, name: path.split('/').pop() ?? path, isHearthProject: true },
  }));
  vi.mocked(apiTesterPlay).mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useApp.setState({ tester: { ...useApp.getState().tester, running: false, starting: false } });
});

describe('runRows', () => {
  it('compares a session only against the one before it in the same game', () => {
    // Interleaved in time, so a naive pass over the mixed list would read
    // lighthouse 2 against harbour 1.
    const rows = runRows([
      run(LIGHTHOUSE, 'lighthouse', note(2, 'worse', '2026-07-28T04:00:00.000Z')),
      run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T03:00:00.000Z')),
      run(LIGHTHOUSE, 'lighthouse', note(1, 'better', '2026-07-28T02:00:00.000Z')),
    ]);

    const lighthouse2 = rows.find((r) => r.run.project.path === LIGHTHOUSE && r.row.session === 2)!;
    const harbour1 = rows.find((r) => r.run.project.path === HARBOUR)!;

    // Lighthouse said better, then worse: a real change of mind, within one
    // game, and the row is allowed to say so.
    expect(lighthouse2.row.reversal).toBeTruthy();
    // Harbour has played once. It has nothing to be compared against, and
    // borrowing lighthouse's verdict would be inventing a history.
    expect(harbour1.row.previously).toBeFalsy();
    expect(harbour1.row.reversal).toBeFalsy();
  });

  it('keeps the order it was given, which is newest first', () => {
    const rows = runRows([
      run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z')),
      run(LIGHTHOUSE, 'lighthouse', note(9, 'worse', '2026-07-28T01:00:00.000Z')),
    ]);
    expect(rows.map((r) => r.run.project.name)).toEqual(['harbour', 'lighthouse']);
  });

  it('drops nothing on the floor', () => {
    const runs = [
      run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z')),
      run(LIGHTHOUSE, 'lighthouse', note(9, 'worse', '2026-07-28T01:00:00.000Z')),
    ];
    expect(runRows(runs)).toHaveLength(runs.length);
  });
});

describe('Play aimed at a game that is not there', () => {
  it('hands the folder back to the server rather than leaving it served', async () => {
    // Asking whether a project has a game means asking the server to serve
    // that project first. A question answered "no" must not leave the server
    // authorized to serve someone's folder for the rest of the session: that
    // set is the jail every file route and socket upgrade is checked against,
    // and it was growing on a press that did nothing.
    vi.mocked(apiOpenWorkspace).mockResolvedValue({
      ok: true,
      info: { path: HARBOUR, name: 'harbour', isHearthProject: false },
    });
    vi.mocked(apiGameStatus).mockResolvedValue({ present: false, entry: null, mtime: 0 });
    useApp.setState({ projectPath: LIGHTHOUSE, projectName: 'lighthouse' });

    await act(async () => {
      await useApp.getState().playTesterIn(HARBOUR);
    });

    expect(apiCloseWorkspace).toHaveBeenCalledWith(HARBOUR);
    // And the project the person was actually in is untouched.
    expect(useApp.getState().projectPath).toBe(LIGHTHOUSE);
  });

  it('does not hand back a folder it did not open', async () => {
    // Already the open project: this call is not what served it, so closing it
    // would take away a folder the person is standing in.
    vi.mocked(apiGameStatus).mockResolvedValue({ present: false, entry: null, mtime: 0 });
    useApp.setState({ projectPath: HARBOUR, projectName: 'harbour' });

    await act(async () => {
      await useApp.getState().playTesterIn(HARBOUR);
    });

    expect(apiCloseWorkspace).not.toHaveBeenCalled();
  });
});

describe('the Tester screen', () => {
  it('lists runs from more than one game, each saying which', async () => {
    useApp.setState({
      testerRuns: {
        runs: [
          run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z')),
          run(LIGHTHOUSE, 'lighthouse', note(9, 'worse', '2026-07-28T01:00:00.000Z')),
        ],
        dropped: 0,
        skippedProjects: 0,
      },
    });
    render(<TesterHistory />);
    await act(async () => {});

    expect(document.querySelectorAll('.tester-run')).toHaveLength(2);
    expect(screen.getByText(/harbour · Session 1/)).toBeTruthy();
    expect(screen.getByText(/lighthouse · Session 9/)).toBeTruthy();
  });

  it('opens a report without switching project', async () => {
    useApp.setState({
      projectPath: LIGHTHOUSE,
      projectName: 'lighthouse',
      testerRuns: { runs: [run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z'))], dropped: 0, skippedProjects: 0 },
    });
    render(<TesterHistory />);
    await act(async () => {});

    await act(async () => {
      (document.querySelector('.tester-run') as HTMLElement).click();
    });

    expect(document.querySelector('dialog')).toBeTruthy();
    // Reading what your tester said about one game is not a reason to tear
    // down the game you have running.
    expect(useApp.getState().projectPath).toBe(LIGHTHOUSE);
  });

  it('aims at the most recently played game, not at whatever is open', async () => {
    useApp.setState({
      projectPath: LIGHTHOUSE,
      projectName: 'lighthouse',
      testerRuns: {
        runs: [
          run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z')),
          run(LIGHTHOUSE, 'lighthouse', note(9, 'worse', '2026-07-28T01:00:00.000Z')),
        ],
        dropped: 0,
        skippedProjects: 0,
      },
    });
    render(<TesterHistory />);
    await act(async () => {});

    // Named out loud on the control, so the aim is never something you have to
    // infer from which project you last clicked.
    expect(screen.getByRole('button', { name: /^Project: / })).toBeTruthy();
    expect(useApp.getState().testerTarget).toBeNull();
  });

  it('tells "never played" apart from "not read yet"', async () => {
    render(<TesterHistory />);
    // Nothing read yet: saying "your tester has not played this game" here
    // would be a claim the screen has to take back a moment later.
    expect(screen.queryByText(/has not played/i)).toBeNull();

    await act(async () => {
      useApp.setState({ testerRuns: { runs: [], dropped: 0, skippedProjects: 0 } });
    });
    expect(screen.getByText(/has not played/i)).toBeTruthy();
    // And it names what it looked at. "this game" points at nothing on a
    // screen that spans every game and is reached from outside any project.
    expect(screen.queryByText(/has not played this game/i)).toBeNull();
    expect(screen.getByText(/has not played any of your games/i)).toBeTruthy();
  });

  /**
   * A place is left, not dismissed, and the way out has to say where it comes
   * out. This screen's said "Back" — the one thing it must not say — while
   * Skills, which is the same kind of screen, named the project. One rule now,
   * in ScreenHeader, for both.
   */
  describe('the way out', () => {
    it('names the project waiting underneath', async () => {
      useApp.setState({ projectPath: LIGHTHOUSE, projectName: 'lighthouse' });
      render(<TesterHistory />);
      await act(async () => {});
      expect(screen.getByRole('button', { name: 'lighthouse' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('names the blank surface when there is no project open', async () => {
      render(<TesterHistory />);
      await act(async () => {});
      // Never "Chats": that is a list in the rail, not a screen anyone can be
      // sent to. Leaving with no folder open lands on the blank surface, which
      // this app calls New chat.
      expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    });

    it('leaves the screen and nothing else', async () => {
      useApp.setState({ projectPath: LIGHTHOUSE, projectName: 'lighthouse', projectView: true });
      render(<TesterHistory />);
      await act(async () => {});
      await act(async () => {
        screen.getByRole('button', { name: 'lighthouse' }).click();
      });
      expect(useApp.getState().screen).toBeNull();
      expect(useApp.getState().projectView).toBe(true);
    });
  });

  /**
   * Arriving from a game is the one case where the app knows which game is
   * meant. The screen's Play otherwise defaults to whichever game played most
   * recently ANYWHERE — and pressing it closes the open project and plays that
   * one, so "Every session" on lighthouse's own screen could put a Play for
   * harbour under the pointer.
   */
  describe('openTesterFor', () => {
    it('opens the screen with the aim already set', () => {
      useApp.getState().openTesterFor(LIGHTHOUSE);
      expect(useApp.getState().screen).toBe('tester');
      expect(useApp.getState().testerTarget).toBe(LIGHTHOUSE);
    });

    it('shows that game in the picker rather than the newest run’s', async () => {
      useApp.setState({
        testerRuns: { runs: [run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z'))], dropped: 0, skippedProjects: 0 },
      });
      useApp.getState().openTesterFor(LIGHTHOUSE);
      render(<TesterHistory />);
      await act(async () => {});
      expect(useApp.getState().testerTarget).toBe(LIGHTHOUSE);
    });
  });

  it('says out loud what the cap left out', async () => {
    useApp.setState({
      testerRuns: { runs: [run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z'))], dropped: 14, skippedProjects: 0 },
    });
    render(<TesterHistory />);
    await act(async () => {});
    // A capped list that looks complete is a list that lies about your history.
    expect(screen.getByText(/14 older sessions are not shown/i)).toBeTruthy();
  });

  it('says out loud which games it never looked in, beside a list of runs', async () => {
    useApp.setState({
      testerRuns: {
        runs: [run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z'))],
        dropped: 0,
        skippedProjects: 3,
      },
    });
    render(<TesterHistory />);
    await act(async () => {});
    expect(screen.getByText(/3 more games were not looked in/i)).toBeTruthy();
  });

  it('says the same thing when the list came back empty', async () => {
    // The admission cannot live inside the "there are runs" branch. An empty
    // list plus games nobody opened is precisely when a screen claiming to
    // span every game is most wrong, and least able to be corrected later.
    useApp.setState({ testerRuns: { runs: [], dropped: 0, skippedProjects: 2 } });
    render(<TesterHistory />);
    await act(async () => {});
    expect(screen.getByText(/2 more games were not looked in/i)).toBeTruthy();
    expect(screen.queryByText(/has not played any of your games yet/i)).toBeNull();
  });

  it('names the game it is aimed at even when the picker cannot find it', async () => {
    // `apiRecentWorkspaces` answers [] here, which is also what it answers when
    // the request fails. Play is armed and aimed at harbour, so the control
    // beside it must not read "Pick a game".
    useApp.setState({
      testerRuns: { runs: [run(HARBOUR, 'harbour', note(1, 'better', '2026-07-28T05:00:00.000Z'))], dropped: 0, skippedProjects: 0 },
    });
    render(<TesterHistory />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Project: harbour' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Project: Pick a game' })).toBeNull();
  });

  it('keeps two sessions claiming the same number apart on the list', async () => {
    // The session number comes off a folder people are told they may edit. Two
    // notes numbered 3 used to collapse onto one row, so a session it called
    // worse and one it called better both said "made things worse", under
    // duplicate React keys.
    useApp.setState({
      testerRuns: {
        runs: [
          run(HARBOUR, 'harbour', note(3, 'worse', '2026-07-28T05:00:00.000Z')),
          run(HARBOUR, 'harbour', note(3, 'better', '2026-07-28T01:00:00.000Z')),
        ],
        dropped: 0,
        skippedProjects: 0,
      },
    });
    render(<TesterHistory />);
    await act(async () => {});
    expect(document.querySelectorAll('.tester-run')).toHaveLength(2);
    const said = [...document.querySelectorAll('.tester-run-verdict')].map((n) => n.textContent);
    expect(said.some((text) => /made things worse/.test(text ?? ''))).toBe(true);
    expect(said.some((text) => /helped/.test(text ?? ''))).toBe(true);
  });
});

describe('what the global list is allowed to claim about itself', () => {
  it('does not say your tester never played when it did not look everywhere', () => {
    expect(historyEmptyLead(0)).toMatch(/has not played any of your games yet/i);
    // "this game" names nothing on a list that spans every game.
    expect(historyEmptyLead(0)).not.toMatch(/this game/i);
    expect(historyEmptyLead(2)).not.toMatch(/has not played/i);
    expect(historyEmptyLead(2)).toMatch(/could not open/i);
  });

  it('keeps "did not fit" and "did not look" as two different sentences', () => {
    expect(skippedProjectsLine(0)).toBeNull();
    expect(skippedProjectsLine(1)).toMatch(/one more game was not looked in/i);
    expect(skippedProjectsLine(4)).toMatch(/4 more games were not looked in/i);
    // Not about sessions that did not fit. That is the other admission.
    expect(skippedProjectsLine(4)).not.toMatch(/older session/i);
  });
});

describe('selectorLabel', () => {
  it('never says nothing is picked while something is', () => {
    // The picker names the current project from its own fetch of recents,
    // which answers an empty list when it fails and is capped besides. The
    // caller picks the target from somewhere else, so the two can disagree,
    // and the disagreement armed a Play button beside a control reading
    // "Pick a game".
    expect(selectorLabel('/work/harbour', null, 'harbour', 'Pick a game')).toBe('harbour');
    // Nothing knows its name: the folder's own name is still true.
    expect(selectorLabel('/work/harbour', null, null, 'Pick a game')).toBe('harbour');
    expect(selectorLabel('/work/harbour', null, null, 'Pick a game')).not.toBe('Pick a game');
  });

  it('prefers the name the control itself knows', () => {
    expect(selectorLabel('/work/harbour', 'Harbour Lights', 'harbour', 'Pick a game')).toBe('Harbour Lights');
  });

  it('still says nothing is picked when nothing is', () => {
    expect(selectorLabel(null, null, null, 'Pick a game')).toBe('Pick a game');
    expect(selectorLabel(undefined, null, null, 'New project')).toBe('New project');
  });
});

describe('whereHints', () => {
  it('hints only the rows whose names collide', () => {
    const hints = whereHints([
      { path: '/work/games/proj', name: 'proj' },
      { path: '/work/experiments/proj', name: 'proj' },
      { path: '/work/lighthouse', name: 'lighthouse' },
    ]);
    // The folder alone would restate the name, so both reach up a segment to
    // say something the name has not already said.
    expect(hints.get('/work/games/proj')).toBe('games/proj');
    expect(hints.get('/work/experiments/proj')).toBe('experiments/proj');
    // A lone name explains nothing, because nothing about it needs explaining.
    expect(hints.has('/work/lighthouse')).toBe(false);
  });

  it('stops at the folder when the folder already tells them apart', () => {
    // The dedupe-suffix case: same display name, sibling folders. The second
    // folder is not the name, so it stands; the first would restate it and
    // reaches up to where it lives instead.
    const hints = whereHints([
      { path: '/Users/a/Hearth/mini-platformer', name: 'mini-platformer' },
      { path: '/Users/a/Hearth/mini-platformer-2', name: 'mini-platformer' },
    ]);
    expect(hints.get('/Users/a/Hearth/mini-platformer')).toBe('Hearth/mini-platformer');
    expect(hints.get('/Users/a/Hearth/mini-platformer-2')).toBe('mini-platformer-2');
  });

  it('handles Windows separators the way the rest of the path code does', () => {
    const hints = whereHints([
      { path: 'C:\\games\\proj', name: 'proj' },
      { path: 'C:\\other\\proj', name: 'proj' },
    ]);
    expect(hints.get('C:\\games\\proj')).toBe('games/proj');
    expect(hints.get('C:\\other\\proj')).toBe('other/proj');
  });
});

/**
 * A picker with nothing in it is a control that does nothing, with nothing
 * saying why.
 *
 * On the Tester screen this control offers no "New project" (there is nothing
 * to play in a folder that does not exist yet), so on a first run its menu was
 * literally empty: you pressed "Pick a game", a blank panel opened, and that
 * was the whole of the app's answer. A menu must always say what is going on
 * and always have something to press.
 */
describe('the picker with nothing to offer', () => {
  const openMenu = async (): Promise<void> => {
    const trigger = await screen.findByRole('button', { name: /^Project:/ });
    await act(async () => {
      trigger.click();
    });
  };

  it('says there are no projects yet, and offers the one act that makes that false', async () => {
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([]);
    render(<ProjectSelector allowNew={false} emptyLabel="Pick a game" />);
    await openMenu();

    const menu = screen.getByRole('menu');
    expect(menu.textContent).toMatch(/no projects yet/i);
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(0);

    const asked = vi.fn();
    window.addEventListener(OPEN_FOLDER_EVENT, asked);
    await act(async () => {
      items[0].click();
    });
    window.removeEventListener(OPEN_FOLDER_EVENT, asked);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('leaves a menu that has projects in it alone', async () => {
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([
      { path: LIGHTHOUSE, name: 'lighthouse', exists: true },
    ]);
    render(<ProjectSelector allowNew={false} emptyLabel="Pick a game" />);
    await openMenu();

    expect(screen.getByRole('menu').textContent).not.toMatch(/no projects yet/i);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['lighthouse']);
  });

  it('tells two same-named games apart by where they live', async () => {
    // The composer's picker and the rail's Projects list are two views of one
    // list: a reader who cannot tell two "proj"s apart here is aiming a
    // message (or a playtest) at a coin flip.
    vi.mocked(apiRecentWorkspaces).mockResolvedValue([
      { path: '/work/games/proj', name: 'proj', exists: true },
      { path: '/work/experiments/proj', name: 'proj', exists: true },
    ]);
    render(<ProjectSelector allowNew={false} emptyLabel="Pick a game" />);
    await openMenu();

    const rows = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(rows.some((text) => text?.includes('games/proj'))).toBe(true);
    expect(rows.some((text) => text?.includes('experiments/proj'))).toBe(true);
  });

  it('ends in a way to reach the older projects, not a label with nothing to press', async () => {
    // The menu is capped, and the cap used to end in a bare header: "9 older
    // projects not listed" named the problem and offered no way to any of
    // them. The row is now a real item that opens the rail's search, which is
    // the one surface that reaches every project on the machine.
    vi.mocked(apiRecentWorkspaces).mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => ({ path: `/work/game-${i}`, name: `game-${i}`, exists: true })),
    );
    render(<ProjectSelector allowNew={false} emptyLabel="Pick a game" />);
    await openMenu();

    const row = screen.getByRole('menuitem', { name: /Search 1 older project…/ });
    expect(row).toBeTruthy();
    // And nothing in the menu is a dead-end header about the cut any more.
    expect(document.querySelector('.menu-header')).toBeNull();

    const asked = vi.fn();
    window.addEventListener(FOCUS_SEARCH_EVENT, asked);
    await act(async () => {
      row.click();
    });
    window.removeEventListener(FOCUS_SEARCH_EVENT, asked);
    expect(asked).toHaveBeenCalledTimes(1);
  });
});

describe('playTesterIn', () => {
  afterEach(() => resetToasts());

  it('does not report a failed status read as a folder with no game', async () => {
    // `game.present` is false both when there is no game and when the last
    // status read failed, and refreshGame returns early on a null answer. So a
    // dropped request became "there is no game in that project": a definite
    // claim about someone's disk, from a question that was never answered.
    useApp.setState({ projectPath: HARBOUR, projectName: 'harbour' });
    vi.mocked(apiGameStatus).mockResolvedValueOnce(null);
    await useApp.getState().playTesterIn(HARBOUR);
    expect(currentToast()?.message).toMatch(/could not check/i);
    expect(currentToast()?.message).not.toMatch(/there is no game/i);
  });

  it('still says plainly when the folder really has no game', async () => {
    useApp.setState({ projectPath: HARBOUR, projectName: 'harbour' });
    vi.mocked(apiGameStatus).mockResolvedValueOnce({ present: false, entry: null, mtime: 0 });
    await useApp.getState().playTesterIn(HARBOUR);
    expect(currentToast()?.message).toMatch(/there is no game/i);
  });

  /**
   * Aiming Play at a game that is not there must not cost you the one you had
   * open.
   *
   * This used to navigate first and ask afterwards: the window switched
   * folders, the conversation, console and chat list of the project you were
   * in were cleared, and only then did it read the status and tell you there
   * was nothing to play. The screen is a global one, so the target is usually
   * NOT the open project, which makes it the common case rather than the edge.
   *
   * The status read needs the server to be serving that folder (`gameStatus`
   * answers 403 for a folder it does not have open), so asking first means
   * asking the server to serve it first. That is a fact about the server, not
   * a move by the window, and nothing the person is looking at changes until
   * the answer is in.
   */
  it('keeps the project you had open when the target has no game', async () => {
    useApp.setState({ projectPath: LIGHTHOUSE, projectName: 'lighthouse', screen: 'tester' });
    vi.mocked(apiGameStatus).mockResolvedValue({ present: false, entry: null, mtime: 0 });

    await useApp.getState().playTesterIn(HARBOUR);

    expect(useApp.getState().projectPath).toBe(LIGHTHOUSE);
    expect(useApp.getState().screen).toBe('tester');
    expect(currentToast()?.message).toMatch(/there is no game/i);
  });

  it('keeps it just as firmly when the status read failed', async () => {
    useApp.setState({ projectPath: LIGHTHOUSE, projectName: 'lighthouse', screen: 'tester' });
    vi.mocked(apiGameStatus).mockResolvedValue(null);

    await useApp.getState().playTesterIn(HARBOUR);

    expect(useApp.getState().projectPath).toBe(LIGHTHOUSE);
    expect(useApp.getState().screen).toBe('tester');
    expect(currentToast()?.message).toMatch(/could not check/i);
  });

  it('still opens the folder and plays when there really is a game', async () => {
    useApp.setState({ projectPath: LIGHTHOUSE, projectName: 'lighthouse', screen: 'tester' });
    vi.mocked(apiGameStatus).mockResolvedValue({ present: true, entry: 'index.html', mtime: 7 });

    await useApp.getState().playTesterIn(HARBOUR);

    expect(useApp.getState().projectPath).toBe(HARBOUR);
    // Watching is the point: Play from the history screen leaves the history.
    expect(useApp.getState().screen).toBeNull();
    expect(vi.mocked(apiTesterPlay)).toHaveBeenCalledWith(HARBOUR);
  });
});
