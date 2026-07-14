// @vitest-environment jsdom
/**
 * App shell — document.title project sync (Wave L Task 6 review fix).
 *
 * App.tsx's window-mode effect drives both the Electron native title bar
 * (via hearthNative().setWindowMode) and document.title. The latter is what
 * a browser tab actually shows, and it's cheap/harmless in Electron too (the
 * native title bar wins there regardless). This pins:
 *   - no project open -> document.title is the 'Hearth Editor' baseline
 *   - project open    -> document.title is "<project name> — Hearth"
 *   - closing a project restores the baseline
 *
 * Toolbar/Workspace/ShortcutSheet/Launcher/installKeybinds are stubbed: this
 * test only cares about the effect in App() itself, not the full editor
 * shell (dockview, panels, keybind wiring), which are covered elsewhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { useEditor } from '../src/store';
import type { ProjectInfo } from '../src/types';

const setWindowMode = vi.fn().mockResolvedValue(undefined);
let nativeMock: { setWindowMode: typeof setWindowMode; platform: string } | null = null;

vi.mock('../src/native', () => ({
  hearthNative: () => nativeMock,
}));

vi.mock('../src/components/Launcher', () => ({ Launcher: () => null }));
vi.mock('../src/components/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('../src/components/ShortcutSheet', () => ({ ShortcutSheet: () => null }));
vi.mock('../src/workspace/Workspace', () => ({ Workspace: () => null }));
vi.mock('../src/keybinds', () => ({ installKeybinds: () => () => {} }));

import App from '../src/App';

function projectInfo(name: string): ProjectInfo {
  return { name } as unknown as ProjectInfo;
}

describe('App — document.title tracks the open project', () => {
  beforeEach(() => {
    nativeMock = null;
    setWindowMode.mockClear();
    document.title = 'stale title from a previous test';
    // Avoid the mount-time loadMeta() network call (apiMeta/apiOpenProject) —
    // irrelevant to the title-sync effect under test.
    useEditor.setState({
      loadMeta: vi.fn().mockResolvedValue(undefined),
      projectPath: null,
      info: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('restores "Hearth Editor" when no project is open', async () => {
    await act(async () => {
      render(<App />);
    });
    expect(document.title).toBe('Hearth Editor');
  });

  it('sets "<name> — Hearth" once a project is open', async () => {
    useEditor.setState({ projectPath: '/proj', info: projectInfo('Ember Quest') } as any);
    await act(async () => {
      render(<App />);
    });
    expect(document.title).toBe('Ember Quest — Hearth');
  });

  it('restores the baseline again after the project is closed', async () => {
    useEditor.setState({ projectPath: '/proj', info: projectInfo('Ember Quest') } as any);
    await act(async () => {
      render(<App />);
    });
    expect(document.title).toBe('Ember Quest — Hearth');

    await act(async () => {
      useEditor.setState({ projectPath: null, info: null } as any);
    });
    expect(document.title).toBe('Hearth Editor');
  });

  it('drives the same title in Electron (native title bar already handled separately)', async () => {
    nativeMock = { setWindowMode, platform: 'darwin' };
    useEditor.setState({ projectPath: '/proj', info: projectInfo('Ember Quest') } as any);
    await act(async () => {
      render(<App />);
    });
    expect(setWindowMode).toHaveBeenCalledWith('editor', 'Ember Quest');
    expect(document.title).toBe('Ember Quest — Hearth');
  });
});
