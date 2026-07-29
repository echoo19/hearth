// @vitest-environment jsdom
/**
 * How much the agent asks before it acts: the composer pill, and the project
 * state behind it.
 *
 * Four things have to hold, and they are the four ways this feature can lie
 * about what the agent is allowed to do:
 *
 *   1. the pill names the mode the project is really on, at rest, without
 *      being opened;
 *   2. choosing one writes it to the project rather than only to the window;
 *   3. `skip` explains itself the first time a project chooses it and never
 *      again, and nothing is written until that explanation is accepted;
 *   4. a read that does not land leaves the default standing. That is the
 *      first run against a server that has not learned the route yet, and it
 *      is also what a user hits any time the request fails, so it must show
 *      today's behaviour rather than an empty or broken control.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import type { PermissionModeInfo } from '../src/types';

// Hoisted, because `vi.mock` is: the factory runs while this file's own
// imports are still being evaluated, and a plain `const` up here would not
// exist yet when it does.
const { readMode, writeMode } = vi.hoisted(() => ({
  readMode: vi.fn(),
  writeMode: vi.fn(),
}));

// Only the two routes under test are replaced. The rest of api.ts still has to
// be itself, because store.ts imports half of it.
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return { ...actual, apiPermissionMode: readMode, apiSetPermissionMode: writeMode };
});

import { Composer } from '../src/components/chat/Composer';
import {
  PERMISSION_CHOICES,
  needsSkipConfirm,
  permissionChoice,
} from '../src/components/chat/PermissionSelector';
import { setModelChoice } from '../src/chat/modelChoice';
import { DEFAULT_PERMISSION_MODE, useApp } from '../src/store';

type State = ReturnType<typeof useApp.getState>;

const PROJECT = '/tmp/game';

function patchStore(over: Partial<State> = {}): void {
  useApp.setState({
    projectPath: PROJECT,
    projectName: 'game',
    messages: [],
    chatBusy: false,
    wsStatus: 'connected',
    providers: null,
    permissionMode: 'auto',
    permissionSkipAcknowledged: false,
    ...over,
  } as unknown as Partial<State>);
}

beforeEach(() => {
  // jsdom implements neither showModal nor close; the ConfirmDialog only needs
  // them to be open/close toggles.
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  localStorage.clear();
  // The model choice is a module-level store shared with the pill beside this
  // one; clearing storage alone would leave one test's pick standing.
  setModelChoice(null);
  readMode.mockReset();
  writeMode.mockReset();
  // The server's normal answer: it stores what it was asked for and says so.
  writeMode.mockImplementation(async (_project: string, patch: Partial<PermissionModeInfo>) => ({
    mode: patch.mode ?? DEFAULT_PERMISSION_MODE,
    skipAcknowledged: patch.skipAcknowledged === true,
  }));
  patchStore();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const pill = () => screen.getByRole('button', { name: 'Permissions' });

describe('the permission pill at rest', () => {
  it('says which mode the project is on without being opened', () => {
    for (const choice of PERMISSION_CHOICES) {
      patchStore({ permissionMode: choice.mode });
      render(<Composer />);
      expect(pill().textContent).toContain(choice.pill);
      cleanup();
    }
  });

  // Not a warning colour and not a badge: skip is marked by holding the state
  // the other pills only show while open. The class is what carries it, so it
  // is the thing worth pinning.
  it('marks skip, and only skip, as the state that is switched on', () => {
    for (const choice of PERMISSION_CHOICES) {
      patchStore({ permissionMode: choice.mode });
      render(<Composer />);
      expect(pill().classList.contains('is-skipping')).toBe(choice.mode === 'skip');
      // Whatever else it is, it is still the same pill as the model one.
      expect(pill().classList.contains('model-pill')).toBe(true);
      cleanup();
    }
  });

  // At rest, only the mode that switched something OFF wears a sign. The
  // resting pill used to carry every menu row's glyph, which put an amber
  // warning triangle on the DEFAULT in every composer: alarm iconography on
  // the safe, recommended state, and a warning that is always on is a warning
  // nobody reads. The dial of three signs still lives in the menu, where it
  // is read top to bottom and the between-ness means something.
  it('keeps the resting pill quiet on the modes that still ask', () => {
    for (const choice of PERMISSION_CHOICES.filter((row) => row.mode !== 'skip')) {
      patchStore({ permissionMode: choice.mode });
      render(<Composer />);
      expect(pill().querySelector('.permission-sign')).toBeNull();
      cleanup();
    }
  });

  it('reserves the resting sign for skip, the mode that never asks', () => {
    // The hazard glyph's path fragment (ui.tsx's ICON_PATHS), so this also
    // proves the sign is not the menu's amber warning slipping back in.
    patchStore({ permissionMode: 'skip' });
    render(<Composer />);

    const sign = pill().querySelector('.permission-sign');
    expect(sign).toBeTruthy();
    expect(sign!.classList.contains('is-danger')).toBe(true);
    expect(sign!.innerHTML).toContain('M3.2 3.2l5.6 5.6');
    // Decorative only: the pill's accessible name stays "Permissions"
    // (asserted by `pill()` itself resolving via that name), and the sign
    // does not add words of its own into the accessible tree.
    expect(sign!.getAttribute('aria-hidden')).toBe('true');
  });

  // The menu, unlike the pill, keeps all three signs: reading down the list
  // is reading one dial being turned up, and each mode still declares one.
  it('still gives every menu row its own sign and tone', () => {
    for (const choice of PERMISSION_CHOICES) {
      expect(choice.icon).toBeTruthy();
      expect(choice.tone).toBeTruthy();
    }
  });

  it('is absent with no folder open, because there is nothing for it to be about', () => {
    patchStore({ projectPath: null });
    render(<Composer variant="home" />);
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull();
  });

  // The strictest row is the one that can lie, and the lie would be believed
  // by exactly the person who chose it in order to watch. An approval here is
  // a command or a file change (ApprovalKind); a read has no kind it could be
  // raised as, so a row promising to ask every time is broken by the first
  // file the agent opens.
  it('does not promise to stop for reads it has no way to stop for', () => {
    const strictest = permissionChoice('ask');
    const words = `${strictest.pill} ${strictest.label} ${strictest.note}`.toLowerCase();
    expect(words).not.toContain('every');
    expect(words).not.toContain('everything');
    expect(strictest.label).toContain('writing');
    expect(strictest.note.toLowerCase()).toContain('read');
  });

  // Neither the tester (always the middle setting, so an unattended session
  // cannot wedge on an approval nobody is there to answer) nor a CLI running
  // in the terminal follows this, and a control that looked like it governed
  // the whole app would be read as covering both.
  it('says what it reaches, next to the modes it offers', () => {
    render(<Composer />);
    fireEvent.click(pill());
    const blurb = (document.querySelector('.permission-menu-blurb')?.textContent ?? '').toLowerCase();
    expect(blurb).toContain('this project');
    expect(blurb).toContain('tester');
    expect(blurb).toContain('terminal');
  });

  it('ticks the row the project is actually on', () => {
    patchStore({ permissionMode: 'ask' });
    render(<Composer />);
    fireEvent.click(pill());
    const ticked = screen
      .getAllByRole('menuitemcheckbox')
      .filter((row) => row.getAttribute('aria-checked') === 'true')
      .map((row) => row.textContent);
    expect(ticked).toHaveLength(1);
    expect(ticked[0]).toContain(permissionChoice('ask').label);
  });
});

describe('choosing a mode', () => {
  it('writes it to the project, then shows it', async () => {
    render(<Composer />);
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Ask before writing or running/ }));

    await waitFor(() => expect(writeMode).toHaveBeenCalledWith(PROJECT, { mode: 'ask' }));
    await waitFor(() => expect(useApp.getState().permissionMode).toBe('ask'));
    expect(pill().textContent).toContain(permissionChoice('ask').pill);
  });

  // The server first, the mirror second: a pill claiming a mode the project
  // never stored is a claim about what the agent may do.
  it('leaves the pill where it was when the write does not land', async () => {
    writeMode.mockResolvedValue(null);
    render(<Composer />);
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Ask before writing or running/ }));

    await waitFor(() => expect(writeMode).toHaveBeenCalled());
    expect(useApp.getState().permissionMode).toBe('auto');
    expect(pill().textContent).toContain(permissionChoice('auto').pill);
  });
});

describe('skip is confirmed once per project', () => {
  function chooseSkip(): void {
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Skip all checks/ }));
  }

  it('explains what it means, and writes nothing until that is accepted', async () => {
    render(<Composer />);
    chooseSkip();

    expect(screen.getByText('Skip all checks?')).toBeTruthy();
    // What it says, not just that it says something: the row of the dialog
    // that matters is the sentence about this machine.
    expect(document.querySelector('.modal-body')?.textContent).toContain('anywhere on this machine');
    expect(writeMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Skip all checks' }));
    // The mode and the acknowledgement in one write, so a project can never be
    // on skip having never been told what that is.
    await waitFor(() =>
      expect(writeMode).toHaveBeenCalledWith(PROJECT, { mode: 'skip', skipAcknowledged: true }),
    );
    await waitFor(() => expect(useApp.getState().permissionSkipAcknowledged).toBe(true));
  });

  it('leaves the project where it was when the dialog is cancelled', () => {
    render(<Composer />);
    chooseSkip();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(writeMode).not.toHaveBeenCalled();
    expect(useApp.getState().permissionMode).toBe('auto');
    expect(screen.queryByText('Skip all checks?')).toBeNull();
  });

  it('does not ask again in a project that has already been told', async () => {
    patchStore({ permissionSkipAcknowledged: true });
    render(<Composer />);
    chooseSkip();

    expect(screen.queryByText('Skip all checks?')).toBeNull();
    await waitFor(() => expect(writeMode).toHaveBeenCalledWith(PROJECT, { mode: 'skip' }));
  });

  it('asks exactly when the project has not acknowledged it', () => {
    expect(needsSkipConfirm('skip', false)).toBe(true);
    expect(needsSkipConfirm('skip', true)).toBe(false);
    expect(needsSkipConfirm('ask', false)).toBe(false);
    expect(needsSkipConfirm('auto', false)).toBe(false);
  });
});

describe('reading the project’s mode', () => {
  it('adopts what the project stored', async () => {
    readMode.mockResolvedValue({ mode: 'skip', skipAcknowledged: true });
    await act(async () => {
      await useApp.getState().refreshPermissionMode();
    });
    expect(useApp.getState().permissionMode).toBe('skip');
    expect(useApp.getState().permissionSkipAcknowledged).toBe(true);
  });

  it('falls back to the default when the read does not land', async () => {
    readMode.mockResolvedValue(null);
    await act(async () => {
      await useApp.getState().refreshPermissionMode();
    });
    expect(useApp.getState().permissionMode).toBe(DEFAULT_PERMISSION_MODE);

    render(<Composer />);
    // The point of the fallback: a control that still names a real behaviour.
    expect(pill().textContent).toContain(permissionChoice(DEFAULT_PERMISSION_MODE).pill);
    expect(pill().classList.contains('is-skipping')).toBe(false);
  });

  it('does not let a slow answer land in a folder you have already left', async () => {
    let settle = (_info: PermissionModeInfo | null): void => {};
    readMode.mockImplementation(
      () => new Promise<PermissionModeInfo | null>((resolve) => (settle = resolve)),
    );
    const pending = useApp.getState().refreshPermissionMode();
    // Away to another folder while the first one's read is still in flight.
    patchStore({ projectPath: '/tmp/other-game' });
    await act(async () => {
      settle({ mode: 'skip', skipAcknowledged: true });
      await pending;
    });
    expect(useApp.getState().permissionMode).toBe(DEFAULT_PERMISSION_MODE);
  });
});

/**
 * The one property of this control a rendered test cannot reach.
 *
 * jsdom does not apply stylesheets, so every assertion above can pass while
 * the sign renders in the wrong colour, and that is exactly what happened:
 * `.model-pill svg` in chat.css sets `color: var(--ink-mute)` for the chevron
 * that used to be the only glyph in the pill. A `color` declared on the svg
 * itself beats anything the toned wrapper would pass down, so the caution sign
 * came out grey while `permission-sign is-caution` was sitting right there on
 * its parent, and a test asserting the class name went green.
 *
 * Reading the rule out of the file is the only place this can be pinned short
 * of a real browser. It is narrow on purpose: it does not check the colour, it
 * checks that the override which lets the colour through is still there.
 */
describe('the sign’s colour survives the pill’s own svg rule', () => {
  it('lets the toned wrapper reach the glyph', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'styles', 'app', 'permissions.css'),
      'utf8',
    );
    const block = css.match(/\.permission-pill\s+\.permission-sign\s+svg\s*\{([^}]*)\}/);
    expect(block).not.toBeNull();
    // Both halves of what chat.css imposes have to be undone: the rotation
    // meant for the chevron, and the colour that would otherwise win.
    expect(block?.[1]).toMatch(/color:\s*inherit/);
    expect(block?.[1]).toMatch(/transform:\s*none/);
  });
});
