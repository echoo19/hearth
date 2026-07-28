// @vitest-environment jsdom
/**
 * The Context card, on the project screen.
 *
 * One rule here, and it is the only destructive act on the whole screen:
 * removing a context file deletes a real file out of `.hearth/context/`. No
 * trash, no undo, no toast, and the X sits a few pixels from the card you meant
 * to read. Deleting a chat asks first and so does deleting a skill; this used to
 * be one click and gone.
 *
 * jsdom implements no `<dialog>` top layer, so showModal/close are polyfilled
 * as plain open/close toggles the same way modalShowModal.test.tsx does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiContextFiles: vi.fn(async () => []),
  apiDeleteContextFile: vi.fn(async () => []),
  apiSaveContextFiles: vi.fn(async () => []),
}));

import { apiContextFiles, apiDeleteContextFile } from '../src/api';
import { ProjectContext } from '../src/components/project/ProjectContext';
import type { ContextFile } from '../src/types';

const PROJECT = '/work/lighthouse';
const DESIGN: ContextFile = {
  name: 'design.md',
  bytes: 2048,
  lines: 84,
  ext: 'md',
  modifiedAt: '2026-07-01T10:00:00.000Z',
};

beforeEach(() => {
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
  vi.mocked(apiContextFiles).mockResolvedValue([DESIGN]);
  vi.mocked(apiDeleteContextFile).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('removing a context file', () => {
  it('asks before it deletes anything', async () => {
    render(<ProjectContext projectPath={PROJECT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove design.md' }));

    // Named, and honest about where the file goes and that it does not come
    // back. Nothing has been deleted yet.
    expect(screen.getByText('Remove context file')).toBeTruthy();
    const body = screen.getByText(/will be deleted from/);
    expect(body.textContent).toContain('design.md');
    expect(body.textContent).toContain('.hearth/context');
    expect(apiDeleteContextFile).not.toHaveBeenCalled();
  });

  it('deletes nothing when the ask is cancelled', async () => {
    render(<ProjectContext projectPath={PROJECT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove design.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Remove context file')).toBeNull());
    expect(apiDeleteContextFile).not.toHaveBeenCalled();
    expect(screen.getByText('design.md')).toBeTruthy();
  });

  it('deletes it once, and only once it has been confirmed', async () => {
    render(<ProjectContext projectPath={PROJECT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove design.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(apiDeleteContextFile).toHaveBeenCalledWith(PROJECT, 'design.md'));
    expect(apiDeleteContextFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('design.md')).toBeNull());
  });
});
