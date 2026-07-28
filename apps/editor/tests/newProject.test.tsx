// @vitest-environment jsdom
/**
 * Starting a project from the rail.
 *
 * Home creates projects from the first message; this is the other door, for
 * when someone knows what they want to call it before they know what to say.
 * Four things have to hold, and all of them are about not lying:
 *
 *   1. the name typed is the name sent — trimmed, and as the `name` argument,
 *      never smuggled in as a prompt the slug rule would then edit;
 *   2. Create is dead until there is a name, and stays dead while a request is
 *      out, so nobody makes two folders by double-clicking;
 *   3. a refused create keeps the dialog, the typed name and the server's own
 *      reason — a dialog that closes on an error reads exactly like one that
 *      worked;
 *   4. a create that lands opens the project, which is the whole point of
 *      having asked.
 *
 * jsdom implements neither the dialog top layer nor showModal/close, so both
 * are polyfilled as plain open/close toggles (same approach as
 * modalShowModal.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/harness/HarnessSections', () => ({ HarnessSections: () => null }));

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiCreateWorkspace: vi.fn(),
  apiRecentWorkspaces: vi.fn(async () => []),
  apiRecentChats: vi.fn(async () => []),
}));

import { apiCreateWorkspace, apiRecentWorkspaces } from '../src/api';
import { NewProjectDialog, canCreateProject } from '../src/components/shell/NewProjectDialog';
import { Sidebar } from '../src/components/shell/Sidebar';
import { useApp } from '../src/store';

const MADE = '/Users/someone/Hearth/lighthouse';

/** What a successful create answers with. */
function created(path = MADE) {
  return { ok: true as const, info: { path, name: path.split('/').pop()!, isHearthProject: false } };
}

function nameField(): HTMLInputElement {
  return screen.getByLabelText('Project name') as HTMLInputElement;
}

function createButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Create project|Creating/ }) as HTMLButtonElement;
}

function reset(over: Partial<ReturnType<typeof useApp.getState>> = {}): void {
  useApp.setState({
    projectPath: null,
    projectName: null,
    chats: [],
    recentChats: [],
    activeChatId: null,
    providers: null,
    updateReady: null,
    sidebarCollapsed: false,
    ...over,
  } as Partial<ReturnType<typeof useApp.getState>>);
}

beforeEach(() => {
  localStorage.clear();
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  vi.mocked(apiRecentWorkspaces).mockResolvedValue([]);
  vi.mocked(apiCreateWorkspace).mockResolvedValue(created());
  reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The rule, on its own
// ---------------------------------------------------------------------------

describe('canCreateProject', () => {
  it('needs a name that is more than whitespace', () => {
    expect(canCreateProject('', false)).toBe(false);
    expect(canCreateProject('   ', false)).toBe(false);
    expect(canCreateProject('Lighthouse', false)).toBe(true);
  });

  it('stays false while a request is already out', () => {
    expect(canCreateProject('Lighthouse', true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

describe('the dialog', () => {
  it('sends the typed name, trimmed, as a name rather than a prompt', async () => {
    const onCreated = vi.fn();
    render(<NewProjectDialog open onCancel={() => {}} onCreated={onCreated} />);

    fireEvent.change(nameField(), { target: { value: '  Lighthouse keeper  ' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(apiCreateWorkspace).toHaveBeenCalledWith(undefined, 'Lighthouse keeper'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(MADE));
  });

  it('answers Enter in the field the same way as the button', async () => {
    render(<NewProjectDialog open onCancel={() => {}} onCreated={() => {}} />);
    fireEvent.change(nameField(), { target: { value: 'Lighthouse' } });
    // Enter in a single-field form is a submit; the handler is the form's.
    fireEvent.submit(nameField().closest('form')!);
    await waitFor(() => expect(apiCreateWorkspace).toHaveBeenCalledWith(undefined, 'Lighthouse'));
  });

  it('will not create anything until there is a name to create it under', () => {
    render(<NewProjectDialog open onCancel={() => {}} onCreated={() => {}} />);
    expect(createButton().disabled).toBe(true);

    fireEvent.change(nameField(), { target: { value: '   ' } });
    expect(createButton().disabled).toBe(true);

    fireEvent.change(nameField(), { target: { value: 'Lighthouse' } });
    expect(createButton().disabled).toBe(false);
  });

  it('goes dead while the request is out, so one click cannot make two folders', async () => {
    let land: (value: ReturnType<typeof created>) => void = () => {};
    vi.mocked(apiCreateWorkspace).mockReturnValue(new Promise((resolve) => (land = resolve)));

    render(<NewProjectDialog open onCancel={() => {}} onCreated={() => {}} />);
    fireEvent.change(nameField(), { target: { value: 'Lighthouse' } });
    fireEvent.click(createButton());

    await screen.findByRole('button', { name: 'Creating…' });
    expect(createButton().disabled).toBe(true);
    fireEvent.click(createButton());
    expect(apiCreateWorkspace).toHaveBeenCalledTimes(1);

    land(created());
    await waitFor(() => expect(apiCreateWorkspace).toHaveBeenCalledTimes(1));
  });

  it('keeps the dialog, the name and the server’s reason when the create is refused', async () => {
    vi.mocked(apiCreateWorkspace).mockResolvedValue({ ok: false, error: 'Disk is full.' });
    const onCreated = vi.fn();
    render(<NewProjectDialog open onCancel={() => {}} onCreated={onCreated} />);

    fireEvent.change(nameField(), { target: { value: 'Lighthouse' } });
    fireEvent.click(createButton());

    expect(await screen.findByText('Disk is full.')).toBeTruthy();
    // Still open, still holding what was typed, and nothing was opened.
    expect(nameField().value).toBe('Lighthouse');
    expect(createButton().disabled).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('says what the create will actually do to their computer', () => {
    render(<NewProjectDialog open onCancel={() => {}} onCreated={() => {}} />);
    expect(screen.getByText(/A folder with this name is made under ~\/Hearth/)).toBeTruthy();
  });

  it('forgets a name typed into a dialog that was closed', () => {
    const { rerender } = render(<NewProjectDialog open onCancel={() => {}} onCreated={() => {}} />);
    fireEvent.change(nameField(), { target: { value: 'Abandoned' } });

    rerender(<NewProjectDialog open={false} onCancel={() => {}} onCreated={() => {}} />);
    rerender(<NewProjectDialog open onCancel={() => {}} onCreated={() => {}} />);

    expect(nameField().value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

describe('the control on the Projects heading', () => {
  it('is there, named, and opens the question', () => {
    render(<Sidebar />);
    const add = screen.getByRole('button', { name: 'New project…' });
    expect(add).toBeTruthy();
    // Nothing is asked before it is clicked.
    expect(screen.queryByLabelText('Project name')).toBeNull();

    fireEvent.click(add);
    expect(nameField()).toBeTruthy();
  });

  it('creates the folder and lands on that project', async () => {
    const openProject = vi.fn(async () => {});
    reset({ openProject });
    render(<Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'New project…' }));
    fireEvent.change(nameField(), { target: { value: 'Lighthouse' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(openProject).toHaveBeenCalledWith(MADE));
    // The question is done being asked.
    await waitFor(() => expect(screen.queryByLabelText('Project name')).toBeNull());
  });

  it('leaves the two general acts at two', () => {
    render(<Sidebar />);
    // The act belongs to the Projects list, not to the rail's nav.
    expect(screen.getByRole('button', { name: 'New project…' }).closest('.sidebar-nav')).toBeNull();
    expect(screen.getByRole('button', { name: 'New project…' }).closest('.sidebar-section-head')).toBeTruthy();
  });
});
