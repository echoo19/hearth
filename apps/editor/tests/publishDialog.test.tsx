// @vitest-environment jsdom
/**
 * The publish dialog, tested for the things that are true regardless of how it
 * looks — which is the only kind of claim this file is allowed to make. jsdom
 * has no layout, so nothing here proves the dialog is not visually broken; the
 * one layout-shaped rule it CAN check is that the error line is not inserted
 * and removed from the DOM (the reflow that eats a click), and that is asserted
 * as a DOM-presence fact rather than a measurement.
 *
 * The cases are the ones where being wrong is expensive:
 *   - a republish that reads as a first publish (a second listing at `my-game-2`)
 *   - "there is nothing to publish" when the truth is "we could not look"
 *   - a token prompt that pretends this dialog can take a token
 *   - anything a person typed disappearing
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiCatalogAccount: vi.fn(),
  apiCatalogProject: vi.fn(),
  apiCatalogPublish: vi.fn(),
  apiListFiles: vi.fn(async () => []),
}));

import { apiCatalogAccount, apiCatalogProject, apiCatalogPublish } from '../src/api';
import type { CatalogAccount, CatalogProjectInfo, PublishResult } from '../src/api';
import { PublishDialog } from '../src/components/publish/PublishDialog';
import {
  addTag,
  draftToRequest,
  emptyDraft,
  formatBytes,
  formatFileCount,
  imageFiles,
  resetDrafts,
  titleProblem,
} from '../src/components/publish/publishDraft';
import { OPEN_SETTINGS_EVENT } from '../src/components/shell/SettingsDialog';
import { useApp } from '../src/store';

const PROJECT = '/Users/someone/Hearth/lighthouse';

const CONNECTED: CatalogAccount = {
  connected: true,
  username: 'jake',
  api: 'https://catalog.hearthengine.com',
};

function projectInfo(patch: Partial<CatalogProjectInfo> = {}): CatalogProjectInfo {
  return {
    entry: 'index.html',
    fileCount: 24,
    totalBytes: 1_258_291,
    suggestedTitle: 'Lighthouse',
    published: null,
    ...patch,
  };
}

const RESULT: PublishResult = {
  url: 'https://catalog.hearthengine.com/g/lighthouse',
  slug: 'lighthouse',
  gameId: 'g_123',
  fileCount: 24,
  totalBytes: 1_258_291,
  status: 'published',
};

/** Render the dialog open, and wait for both loads to land. */
async function open(): Promise<ReturnType<typeof render>> {
  const view = render(<PublishDialog open onClose={() => {}} />);
  await waitFor(() => expect(apiCatalogProject).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  resetDrafts();
  // jsdom implements neither of these, and Modal calls them on every open.
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
  useApp.setState({ projectPath: PROJECT } as Partial<ReturnType<typeof useApp.getState>>);
  vi.mocked(apiCatalogAccount).mockResolvedValue(CONNECTED);
  vi.mocked(apiCatalogProject).mockResolvedValue(projectInfo());
  vi.mocked(apiCatalogPublish).mockResolvedValue({ ok: true, result: RESULT });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetDrafts();
});

// ---------------------------------------------------------------------------
// The rules, without a DOM
// ---------------------------------------------------------------------------

describe('publish draft rules', () => {
  it('requires a title and nothing else', () => {
    expect(titleProblem('   ')).not.toBeNull();
    expect(titleProblem('Lighthouse')).toBeNull();
  });

  it('leaves untouched optional fields off the request rather than blanking them', () => {
    const request = draftToRequest(PROJECT, { ...emptyDraft(), title: '  Lighthouse  ' });
    expect(request).toEqual({ project: PROJECT, title: 'Lighthouse' });
    // The keys must be ABSENT, not empty: on an update, `tagline: ''` would be
    // a request to erase the tagline that is already live.
    expect('tagline' in request).toBe(false);
    expect('description' in request).toBe(false);
    expect('tags' in request).toBe(false);
    expect('coverPath' in request).toBe(false);
  });

  it('commits a half-typed tag into the request', () => {
    const request = draftToRequest(PROJECT, {
      ...emptyDraft(),
      title: 'Lighthouse',
      tags: ['puzzle'],
      tagText: 'co-op',
    });
    expect(request.tags).toEqual(['puzzle', 'co-op']);
  });

  it('refuses duplicate tags case-insensitively and keeps the casing on screen', () => {
    expect(addTag(['Puzzle'], 'puzzle')).toEqual(['Puzzle']);
    expect(addTag(['puzzle'], '  co-op ')).toEqual(['puzzle', 'co-op']);
    expect(addTag(['puzzle'], '   ')).toEqual(['puzzle']);
  });

  it('formats sizes and counts the way a person reads them', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1_258_291)).toBe('1.2 MB');
    expect(formatFileCount(1)).toBe('1 file');
    expect(formatFileCount(24)).toBe('24 files');
  });

  it('picks image files out of a project listing', () => {
    expect(imageFiles(['index.html', 'art/hero.PNG', 'main.js', 'cover.jpg'])).toEqual([
      'art/hero.PNG',
      'cover.jpg',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Publish vs update
// ---------------------------------------------------------------------------

describe('a folder that has never been published', () => {
  it('offers Publish, and says nothing about an existing listing', async () => {
    await open();
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update listing' })).toBeNull();
    expect(screen.queryByText(/already on the catalog/i)).toBeNull();
  });

  it('defaults the title from the folder', async () => {
    await open();
    const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
    expect(title.value).toBe('Lighthouse');
  });

  it('states what would be sent before it is sent', async () => {
    await open();
    expect(await screen.findByText('index.html')).toBeTruthy();
    expect(screen.getByText('24 files')).toBeTruthy();
    expect(screen.getByText('1.2 MB')).toBeTruthy();
  });
});

describe('a folder that has been published before', () => {
  const published = projectInfo({
    published: {
      gameId: 'g_123',
      slug: 'lighthouse',
      url: 'https://catalog.hearthengine.com/g/lighthouse',
      publishedAt: '2026-07-01T10:00:00.000Z',
    },
  });

  it('is an update, and says so in the button and the heading', async () => {
    vi.mocked(apiCatalogProject).mockResolvedValue(published);
    await open();
    expect(await screen.findByRole('button', { name: 'Update listing' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.getByText('Update your listing')).toBeTruthy();
  });

  it('shows the address it already has, and promises not to make a second one', async () => {
    vi.mocked(apiCatalogProject).mockResolvedValue(published);
    await open();
    expect(await screen.findByText(/does not make a second one/i)).toBeTruthy();
    expect(
      screen.getAllByText('https://catalog.hearthengine.com/g/lighthouse').length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The states that are not the form
// ---------------------------------------------------------------------------

describe('a folder with no game in it', () => {
  it('says there is nothing to publish, and offers nothing else', async () => {
    vi.mocked(apiCatalogProject).mockResolvedValue(projectInfo({ entry: null }));
    await open();
    expect(await screen.findByText(/no game in this folder to publish yet/i)).toBeTruthy();
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    // Scoped to the action row: Modal draws its own X, which is also named
    // Close. Both do the same thing, so the duplicate name is honest — but the
    // point here is that the footer is not a dead end with nothing in it.
    const actions = document.querySelector('.modal-actions') as HTMLElement;
    expect(within(actions).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(within(actions).queryAllByRole('button')).toHaveLength(1);
  });
});

describe('a server that will not answer (today: 501 on everything)', () => {
  it('says it could not look, NOT that there is nothing there', async () => {
    // getJson turns a 501 into null — the same null a missing folder gives.
    vi.mocked(apiCatalogProject).mockResolvedValue(null);
    await open();
    expect(await screen.findByText(/could not read what this folder would publish/i)).toBeTruthy();
    // The lie this test exists to prevent.
    expect(screen.queryByText(/no game in this folder/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('does not claim the machine is disconnected when it could not ask', async () => {
    vi.mocked(apiCatalogAccount).mockResolvedValue(null);
    await open();
    expect(await screen.findByText(/could not check whether a catalog token is stored/i)).toBeTruthy();
    // The form stays usable: the publish itself will carry the real refusal.
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.queryByText(/does not have one/i)).toBeNull();
  });
});

describe('no catalog token stored', () => {
  const absent: CatalogAccount = { connected: false, username: null, api: 'https://catalog.hearthengine.com' };

  it('says a token is needed and points at Settings, without collecting one', async () => {
    vi.mocked(apiCatalogAccount).mockResolvedValue(absent);
    await open();
    expect(await screen.findByText(/needs a catalog token/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Settings → Publishing' })).toBeTruthy();
    // This dialog must never grow a token field — that pane owns it.
    expect(screen.queryByLabelText(/token/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('asks Settings for the publishing pane by name', async () => {
    vi.mocked(apiCatalogAccount).mockResolvedValue(absent);
    const heard: unknown[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, listener);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Settings → Publishing' }));
    window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
    expect(heard).toEqual([{ pane: 'publishing' }]);
  });

  it('reports a stored token the catalog has stopped accepting, in the server’s words', async () => {
    vi.mocked(apiCatalogAccount).mockResolvedValue({
      connected: true,
      username: 'jake',
      api: 'https://catalog.hearthengine.com',
      error: 'that token was revoked',
    });
    await open();
    expect(await screen.findByText(/that token was revoked/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Refusals, and the words that come back
// ---------------------------------------------------------------------------

describe('a publish that is refused', () => {
  it('shows the server’s own sentence and keeps every field', async () => {
    vi.mocked(apiCatalogPublish).mockResolvedValue({
      ok: false,
      error: 'Publishing is not wired up yet.',
    });
    await open();
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Lighthouse Keeper' } });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'A long thing nobody wants to type twice.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('Publishing is not wired up yet.')).toBeTruthy();
    // Nothing typed may be lost — least of all by the failure itself.
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Lighthouse Keeper');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
      'A long thing nobody wants to type twice.',
    );
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
  });
});

describe('a publish that lands', () => {
  it('ends on the address, with a way to copy it and a link that opens it', async () => {
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('Published to the catalog')).toBeTruthy();
    const link = screen.getByRole('link', { name: RESULT.url }) as HTMLAnchorElement;
    expect(link.href).toBe(RESULT.url);
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open' })).toBeTruthy();
  });

  it('sends the typed listing, not the defaults', async () => {
    await open();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Lighthouse Keeper' } });
    fireEvent.change(screen.getByLabelText('Tagline'), { target: { value: 'Keep the light burning.' } });
    const tags = screen.getByLabelText('Tags');
    fireEvent.change(tags, { target: { value: 'puzzle' } });
    fireEvent.keyDown(tags, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(apiCatalogPublish).toHaveBeenCalled());
    expect(vi.mocked(apiCatalogPublish).mock.calls[0][0]).toEqual({
      project: PROJECT,
      title: 'Lighthouse Keeper',
      tagline: 'Keep the light burning.',
      tags: ['puzzle'],
    });
  });
});

// ---------------------------------------------------------------------------
// Validation, and the click it must not eat
// ---------------------------------------------------------------------------

describe('the title is missing', () => {
  it('says so instead of publishing, and clears as soon as typing fixes it', async () => {
    await open();
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText(/Give the listing a title/i)).toBeTruthy();
    expect(apiCatalogPublish).not.toHaveBeenCalled();

    // Clears on the keystroke, not on blur and not on a second press of the
    // button — a message that waits for blur is the one that moves the layout
    // out from under a pointer already on its way to Publish.
    fireEvent.change(title, { target: { value: 'L' } });
    expect(screen.queryByText(/Give the listing a title/i)).toBeNull();
  });

  it('keeps the error line in the DOM at all times, so nothing below it moves', async () => {
    await open();
    await screen.findByLabelText('Title');
    // Present, and empty, before anything has gone wrong.
    const slot = document.getElementById('publish-title-error');
    expect(slot).not.toBeNull();
    expect(slot?.textContent).toBe('');

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByText(/Give the listing a title/i);

    // The SAME element, now with words in it — not a new node inserted into
    // the flow, which is what shifts everything below it downward.
    expect(document.getElementById('publish-title-error')).toBe(slot);
  });

  it('leaves the submit button pressable rather than dead', async () => {
    await open();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: '' } });
    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

describe('the tag field', () => {
  it('turns text into chips on Enter and takes them back on Backspace', async () => {
    await open();
    const tags = await screen.findByLabelText('Tags');
    fireEvent.change(tags, { target: { value: 'puzzle' } });
    fireEvent.keyDown(tags, { key: 'Enter' });
    expect(await screen.findByText('puzzle')).toBeTruthy();
    expect((tags as HTMLInputElement).value).toBe('');

    expect(screen.getByRole('button', { name: 'Remove tag puzzle' })).toBeTruthy();

    fireEvent.keyDown(tags, { key: 'Backspace' });
    await waitFor(() => expect(screen.queryByText('puzzle')).toBeNull());
  });

  it('removes a chip from its own button', async () => {
    await open();
    const tags = await screen.findByLabelText('Tags');
    fireEvent.change(tags, { target: { value: 'co-op' } });
    fireEvent.keyDown(tags, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove tag co-op' }));
    await waitFor(() => expect(screen.queryByText('co-op')).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// Nothing typed may be lost
// ---------------------------------------------------------------------------

describe('closing and reopening', () => {
  it('keeps the draft', async () => {
    const view = render(<PublishDialog open onClose={() => {}} />);
    await waitFor(() => expect(apiCatalogProject).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Lighthouse Keeper' } });
    fireEvent.change(screen.getByLabelText('How to play'), {
      target: { value: 'Arrow keys, then space.' },
    });

    view.rerender(<PublishDialog open={false} onClose={() => {}} />);
    // Modal unmounts its children, so the fields are genuinely gone.
    expect(screen.queryByLabelText('Title')).toBeNull();

    view.rerender(<PublishDialog open onClose={() => {}} />);
    const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
    expect(title.value).toBe('Lighthouse Keeper');
    expect((screen.getByLabelText('How to play') as HTMLTextAreaElement).value).toBe(
      'Arrow keys, then space.',
    );
  });

  it('does not re-suggest a title that was deliberately cleared', async () => {
    const view = render(<PublishDialog open onClose={() => {}} />);
    await waitFor(() => expect(apiCatalogProject).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: '' } });

    view.rerender(<PublishDialog open={false} onClose={() => {}} />);
    view.rerender(<PublishDialog open onClose={() => {}} />);

    const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
    expect(title.value).toBe('');
  });
});
