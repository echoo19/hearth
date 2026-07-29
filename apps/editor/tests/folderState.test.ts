// @vitest-environment jsdom
/**
 * What belongs to the open folder, and what happens to it when the folder
 * changes or goes away.
 *
 * Two rules, both about the app never claiming something it does not know:
 *
 *   1. **A read that did not land changes nothing.** `GET /api/chat/providers`
 *      answers 403 for a root the server has not marked open yet, which
 *      includes the gap in the middle of a project switch. Writing that null
 *      through flipped the account row to "Not signed in" and the top bar to
 *      "No agent connected" while the very same endpoint was answering
 *      `loggedIn: true` on the calls either side of it. Uncertainty must never
 *      resolve into a confident "not connected".
 *
 *   2. **A closed folder leaves nothing of itself behind, including WHERE the
 *      window is.** `closeWorkspace` reset about twenty fields and neither of
 *      the two that say what is on screen, so closing a project from the Tester
 *      screen left the Tester screen up: no game open, an empty history, and a
 *      live Play button. The same halves of state must not lend themselves from
 *      one project to the next either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiChatProviders: vi.fn(async () => null),
  apiOpenWorkspace: vi.fn(),
  apiListChats: vi.fn(async () => []),
  apiRecentChats: vi.fn(async () => []),
  apiAppSettings: vi.fn(async () => null),
  apiGameStatus: vi.fn(async () => null),
  apiProbeStatus: vi.fn(async () => null),
  apiTesterHistory: vi.fn(async () => null),
  apiPermissionMode: vi.fn(async () => null),
}));

import { apiChatProviders, apiOpenWorkspace } from '../src/api';
import { useApp } from '../src/store';
import type { ChatProviderStatus, ConsoleEntry } from '../src/types';
import type { TesterNote } from '../server/tester/types';

const HERE = '/work/lighthouse';
const THERE = '/work/ember';

/** A signed-in ChatGPT, which is what the failing reads were talking over. */
const SIGNED_IN: ChatProviderStatus = {
  anthropic: { hasKey: false, source: null },
  openai: {
    installed: true,
    version: '0.9.0',
    loggedIn: true,
    authMode: 'chatgpt',
    email: 'me@example.com',
    planType: 'plus',
    hasKey: false,
  },
  active: 'openai',
};

const entry = (message: string): ConsoleEntry => ({
  id: 1,
  time: '10:00:00',
  level: 'error',
  source: 'game',
  message,
});

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

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('WebSocket', DeadSocket);
  vi.mocked(apiChatProviders).mockResolvedValue(null);
});

afterEach(() => {
  useApp.getState().closeWorkspace();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('refreshProviders', () => {
  it('leaves the last known answer standing when the read does not land', async () => {
    useApp.setState({ projectPath: HERE, providers: SIGNED_IN });
    vi.mocked(apiChatProviders).mockResolvedValue(null);

    await useApp.getState().refreshProviders();

    expect(useApp.getState().providers).toEqual(SIGNED_IN);
  });

  it('still takes a read that did land', async () => {
    useApp.setState({ projectPath: HERE, providers: null });
    vi.mocked(apiChatProviders).mockResolvedValue(SIGNED_IN);

    await useApp.getState().refreshProviders();

    expect(useApp.getState().providers).toEqual(SIGNED_IN);
  });

  it('settles the folder on a real answer and not on a failed one', async () => {
    // Choosing chat or terminal for a folder on an answer nobody got is the
    // same lie one step later, so a failed read must not pin the column either.
    useApp.setState({
      projectPath: HERE,
      providers: null,
      settings: { hasKey: true, source: 'project' },
      conversationModePinned: false,
    });
    vi.mocked(apiChatProviders).mockResolvedValue(null);
    await useApp.getState().refreshProviders();
    expect(useApp.getState().conversationModePinned).toBe(false);

    vi.mocked(apiChatProviders).mockResolvedValue(SIGNED_IN);
    await useApp.getState().refreshProviders();
    expect(useApp.getState().conversationModePinned).toBe(true);
  });
});

describe('closeWorkspace', () => {
  // Only the fields this test reads. The shape is the tester's own and has a
  // dozen more, none of which say anything about closing a folder.
  const note = { session: 1, startedAt: '2026-07-01T10:00:00.000Z' } as unknown as TesterNote;

  function openOnTheTesterScreen(): void {
    useApp.setState({
      projectPath: HERE,
      projectName: 'lighthouse',
      screen: 'tester',
      projectView: true,
      composing: true,
      composeTarget: HERE,
      tester: { ...useApp.getState().tester, sessions: [note], historyLoaded: true },
      consoleEntries: [entry('undefined is not a function')],
      consoleUnread: 1,
    });
  }

  it('takes the project’s own view down with the folder it was a view of', () => {
    openOnTheTesterScreen();

    useApp.getState().closeWorkspace();

    expect(useApp.getState().projectView).toBe(false);
    expect(useApp.getState().composing).toBe(false);
  });

  it('leaves a global screen standing, because it is not a view of the folder', () => {
    // This used to clear `screen` too, from when the Tester screen showed only
    // the open project and survived a close reading "your tester has not played
    // this game yet" with no game open. That screen is gone: Tester is a
    // history across every game and Skills is the person's library, so closing
    // one project is not a reason to throw the reader off either of them. See
    // `globalPlace`.
    openOnTheTesterScreen();

    useApp.getState().closeWorkspace();

    expect(useApp.getState().screen).toBe('tester');
    expect(useApp.getState().projectPath).toBeNull();
  });

  it('takes the folder’s tester, console and composer target with it', () => {
    openOnTheTesterScreen();

    useApp.getState().closeWorkspace();

    expect(useApp.getState().tester.sessions).toEqual([]);
    expect(useApp.getState().tester.historyLoaded).toBe(false);
    expect(useApp.getState().consoleEntries).toEqual([]);
    expect(useApp.getState().consoleUnread).toBe(0);
    // The blank composer aimed at a folder nobody has open would start the next
    // message inside it.
    expect(useApp.getState().composeTarget).toBeNull();
  });
});

describe('openWorkspace', () => {
  it('does not lend one project’s key state or errors to the next', async () => {
    vi.mocked(apiOpenWorkspace).mockResolvedValue({
      ok: true,
      info: { path: THERE, name: 'ember', isHearthProject: true },
    });
    useApp.setState({
      projectPath: HERE,
      projectName: 'lighthouse',
      settings: { hasKey: true, source: 'project' },
      providers: SIGNED_IN,
      consoleEntries: [entry('lighthouse blew up')],
      consoleUnread: 1,
    });

    // What the window is claiming at the moment the new folder's own reads go
    // out, which is the whole window in which the wrong answer would be on
    // screen. Asserting afterwards would only prove the read landed.
    let duringSwitch: { settings: unknown; providers: unknown } | null = null;
    vi.mocked(apiChatProviders).mockImplementation(async () => {
      const state = useApp.getState();
      duringSwitch = { settings: state.settings, providers: state.providers };
      return null;
    });

    await useApp.getState().openWorkspace(THERE);

    expect(useApp.getState().projectPath).toBe(THERE);
    // Null is the honest pre-read value for both: whether a key answers for a
    // folder is that folder's own answer, and it must not be vouched for by the
    // folder being left for the length of a round trip.
    expect(duringSwitch).toEqual({ settings: null, providers: null });
    // Project A's stack traces are not a record of anything that happened in
    // project B. Nothing re-reads these, so the reset is the only thing there
    // is to check.
    expect(useApp.getState().consoleEntries).toEqual([]);
    expect(useApp.getState().consoleUnread).toBe(0);
  });
});
