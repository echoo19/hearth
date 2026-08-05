// @vitest-environment jsdom
/**
 * The end of a turn is the one moment publishing means anything.
 *
 * Someone has just watched their game work. That is when "put it online" is a
 * thought they might have, and it is the only time the app gets to have it for
 * them. Ten minutes later they are back inside the next change and an offer to
 * publish is an interruption.
 *
 * So this file is mostly about restraint. The offer arrives on the edge where
 * work stops, once per folder for as long as the app is running, and every
 * reason not to make it wins: no game in the folder, already on the catalog,
 * the dialog already open, the server refusing to answer. The last one matters
 * most — a suggestion nobody asked for must never be able to produce an error
 * message.
 *
 * The toast slot is checked directly rather than on screen: TopBar does not
 * render the toaster, and what is being proved here is that the offer was
 * raised with a way to act on it, not how a card looks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiCatalogAccount: vi.fn(),
  apiCatalogProject: vi.fn(),
  apiListFiles: vi.fn(async () => []),
}));

import { apiCatalogAccount, apiCatalogProject } from '../src/api';
import type { CatalogAccount, CatalogProjectInfo } from '../src/api';
import { resetPublishNudge, TopBar } from '../src/components/shell/TopBar';
import { useApp } from '../src/store';
import { currentToast, resetToasts, subscribeToast, type Toast } from '../src/toast';
import type { DevTeamSnapshot } from '../src/types';

const PROJECT = '/work/lighthouse';
const OTHER = '/work/harbour';

const CONNECTED: CatalogAccount = {
  connected: true,
  username: 'jake',
  api: 'https://catalog.hearthengine.com',
};

function projectInfo(patch: Partial<CatalogProjectInfo> = {}): CatalogProjectInfo {
  return {
    entry: 'index.html',
    fileCount: 12,
    totalBytes: 4096,
    suggestedTitle: 'Lighthouse',
    published: null,
    ...patch,
  };
}

function snapshot(phase: DevTeamSnapshot['phase']): DevTeamSnapshot {
  return {
    version: 1,
    runId: 'run-1',
    phase,
    phaseSince: null,
    steering: [],
    plan: null,
    tasks: [],
    approvals: [],
    history: [],
    currentMilestone: 0,
    spec: null,
    specVersion: 1,
    summary: null,
    wrap: null,
    error: null,
  };
}

/** Every toast raised since the case began, in order. */
let raised: Toast[] = [];

function state(over: Partial<ReturnType<typeof useApp.getState>> = {}): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'lighthouse',
    chats: [],
    activeChatId: null,
    composing: false,
    projectView: false,
    screen: null,
    chatBusy: false,
    devTeam: null,
    ...over,
  } as Partial<ReturnType<typeof useApp.getState>>);
}

/** Render the strip with a turn already running. */
function open(): ReturnType<typeof render> {
  return render(<TopBar narrow={false} />);
}

/** The turn ends. */
async function finishTurn(): Promise<void> {
  await act(async () => {
    useApp.setState({ chatBusy: false } as Partial<ReturnType<typeof useApp.getState>>);
  });
}

beforeEach(() => {
  resetToasts();
  resetPublishNudge();
  raised = [];
  subscribeToast((toast) => {
    if (toast !== null) raised.push(toast);
  });
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.show = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  vi.mocked(apiCatalogAccount).mockResolvedValue(CONNECTED);
  vi.mocked(apiCatalogProject).mockResolvedValue(projectInfo());
  state({ chatBusy: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetToasts();
  resetPublishNudge();
});

describe('a turn that ends on a game nobody has published', () => {
  it('offers the catalog, with a way to act on it', async () => {
    open();
    await finishTurn();

    await waitFor(() => expect(currentToast()).not.toBeNull());
    const toast = currentToast()!;
    expect(toast.message).toContain('online');
    expect(toast.action?.label).toBe('Publish');
    expect(vi.mocked(apiCatalogProject).mock.calls[0][0]).toBe(PROJECT);
  });

  it('opens the publish dialog when the offer is taken', async () => {
    open();
    await finishTurn();
    await waitFor(() => expect(currentToast()).not.toBeNull());

    await act(async () => {
      currentToast()!.action!.run();
    });

    expect(await screen.findByText('Publish to the catalog')).toBeTruthy();
  });

  it('offers once per folder, however many turns end after it', async () => {
    open();
    await finishTurn();
    await waitFor(() => expect(raised).toHaveLength(1));

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        useApp.setState({ chatBusy: true } as Partial<ReturnType<typeof useApp.getState>>);
      });
      await finishTurn();
    }

    expect(raised).toHaveLength(1);
  });

  it('is a fact about a folder, not about the app: another folder is still asked', async () => {
    open();
    await finishTurn();
    await waitFor(() => expect(raised).toHaveLength(1));

    await act(async () => {
      state({ projectPath: OTHER, chatBusy: true });
    });
    await finishTurn();

    await waitFor(() => expect(raised).toHaveLength(2));
    expect(vi.mocked(apiCatalogProject).mock.calls.at(-1)?.[0]).toBe(OTHER);
  });
});

describe('turns that end with nothing to offer', () => {
  it('says nothing while the turn is still running', async () => {
    open();
    await act(async () => {});
    expect(currentToast()).toBeNull();
    expect(apiCatalogProject).not.toHaveBeenCalled();
  });

  it('says nothing when the folder has no game in it', async () => {
    vi.mocked(apiCatalogProject).mockResolvedValue(projectInfo({ entry: null }));
    open();
    await finishTurn();

    await waitFor(() => expect(apiCatalogProject).toHaveBeenCalled());
    expect(currentToast()).toBeNull();
  });

  it('says nothing when the game is already on the catalog', async () => {
    vi.mocked(apiCatalogProject).mockResolvedValue(
      projectInfo({
        published: {
          gameId: 'g_1',
          slug: 'lighthouse',
          url: 'https://catalog.hearthengine.com/g/lighthouse',
          publishedAt: '2026-07-01T10:00:00.000Z',
        },
      }),
    );
    open();
    await finishTurn();

    await waitFor(() => expect(apiCatalogProject).toHaveBeenCalled());
    expect(currentToast()).toBeNull();
  });

  it('never turns a failed check into something a person has to read', async () => {
    // Both shapes of failure: the null the app server gives for a 501, and a
    // request that rejects outright.
    vi.mocked(apiCatalogProject).mockResolvedValueOnce(null);
    open();
    await finishTurn();
    await waitFor(() => expect(apiCatalogProject).toHaveBeenCalled());
    expect(currentToast()).toBeNull();

    vi.mocked(apiCatalogProject).mockRejectedValueOnce(new Error('no'));
    await act(async () => {
      useApp.setState({ chatBusy: true } as Partial<ReturnType<typeof useApp.getState>>);
    });
    await finishTurn();
    await waitFor(() => expect(apiCatalogProject).toHaveBeenCalledTimes(2));
    expect(currentToast()).toBeNull();
  });

  it('does not interrupt a publish dialog that is already open', async () => {
    open();
    // The dialog is opened from the button, the way a person would.
    await act(async () => {
      screen.getByRole('button', { name: 'Publish to the catalog' }).click();
    });
    await finishTurn();

    // The dialog reads the folder for its own manifest; the nudge did not.
    expect(currentToast()).toBeNull();
    expect(raised).toHaveLength(0);
  });
});

describe('a dev team run, which never touches chatBusy', () => {
  it('offers the catalog when the run reaches done', async () => {
    state({ chatBusy: false, devTeam: snapshot('building') });
    open();

    await act(async () => {
      useApp.setState({ devTeam: snapshot('done') } as Partial<ReturnType<typeof useApp.getState>>);
    });

    await waitFor(() => expect(currentToast()).not.toBeNull());
    expect(currentToast()?.action?.label).toBe('Publish');
  });

  it('says nothing while the run is still going', async () => {
    state({ chatBusy: false, devTeam: snapshot('planning') });
    open();

    await act(async () => {
      useApp.setState({ devTeam: snapshot('building') } as Partial<ReturnType<typeof useApp.getState>>);
    });

    expect(apiCatalogProject).not.toHaveBeenCalled();
    expect(currentToast()).toBeNull();
  });
});
