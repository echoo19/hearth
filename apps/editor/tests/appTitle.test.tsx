// @vitest-environment jsdom
/**
 * App shell — document.title project sync (review fix).
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

vi.mock('../src/components/Launcher', () => ({
  Launcher: () => React.createElement('div', { 'data-testid': 'launcher' }),
}));
vi.mock('../src/components/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('../src/components/ShortcutSheet', () => ({ ShortcutSheet: () => null }));
vi.mock('../src/workspace/Workspace', () => ({
  Workspace: () => React.createElement('div', { 'data-testid': 'workspace' }),
}));
vi.mock('../src/keybinds', () => ({ installKeybinds: () => () => {} }));

import App from '../src/App';

function projectInfo(name: string): ProjectInfo {
  return { name } as unknown as ProjectInfo;
}

describe('App — document.title tracks the open project', () => {
  beforeEach(() => {
    nativeMock = null;
    setWindowMode.mockClear();
    setWindowMode.mockResolvedValue(undefined);
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
    expect(document.title).toBe('Ember Quest · Hearth');
  });

  it('restores the baseline again after the project is closed', async () => {
    useEditor.setState({ projectPath: '/proj', info: projectInfo('Ember Quest') } as any);
    await act(async () => {
      render(<App />);
    });
    expect(document.title).toBe('Ember Quest · Hearth');

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
    expect(document.title).toBe('Ember Quest · Hearth');
  });

  it('waits for Electron editor mode before mounting the workspace', async () => {
    let finishWindowMode!: () => void;
    setWindowMode.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishWindowMode = resolve;
      }),
    );
    nativeMock = { setWindowMode, platform: 'darwin' };
    useEditor.setState({ projectPath: '/proj', info: projectInfo('Ember Quest') } as any);

    const view = render(<App />);

    expect(setWindowMode).toHaveBeenCalledWith('editor', 'Ember Quest');
    expect(view.queryByTestId('workspace')).toBeNull();

    await act(async () => finishWindowMode());
    expect(view.getByTestId('workspace')).toBeTruthy();
  });

  it('mounts the browser workspace immediately', () => {
    useEditor.setState({ projectPath: '/proj', info: projectInfo('Ember Quest') } as any);

    const view = render(<App />);

    expect(view.getByTestId('workspace')).toBeTruthy();
    expect(setWindowMode).not.toHaveBeenCalled();
  });

  it('does not let a stale native transition unlock a switched project', async () => {
    const finishWindowModes: Array<() => void> = [];
    setWindowMode.mockImplementation(
      () => new Promise<void>((resolve) => finishWindowModes.push(resolve)),
    );
    nativeMock = { setWindowMode, platform: 'darwin' };
    useEditor.setState({ projectPath: '/first', info: projectInfo('First') } as any);
    const view = render(<App />);

    await act(async () => {
      useEditor.setState({ projectPath: '/second', info: projectInfo('Second') } as any);
    });
    expect(finishWindowModes).toHaveLength(2);

    await act(async () => finishWindowModes[0]());
    expect(view.queryByTestId('workspace')).toBeNull();

    await act(async () => finishWindowModes[1]());
    expect(view.getByTestId('workspace')).toBeTruthy();
  });

  it('waits for the latest native transition when the project name arrives', async () => {
    const finishWindowModes: Array<() => void> = [];
    setWindowMode.mockImplementation(
      () => new Promise<void>((resolve) => finishWindowModes.push(resolve)),
    );
    nativeMock = { setWindowMode, platform: 'darwin' };
    useEditor.setState({ projectPath: '/proj', info: null } as any);
    const view = render(<App />);

    await act(async () => {
      useEditor.setState({ info: projectInfo('Ember Quest') } as any);
    });
    expect(finishWindowModes).toHaveLength(2);

    await act(async () => finishWindowModes[0]());
    expect(view.queryByTestId('workspace')).toBeNull();

    await act(async () => finishWindowModes[1]());
    expect(view.getByTestId('workspace')).toBeTruthy();
  });

  it('waits again when the same project is closed and reopened', async () => {
    const finishEditorModes: Array<() => void> = [];
    setWindowMode.mockImplementation((mode) =>
      mode === 'editor'
        ? new Promise<void>((resolve) => finishEditorModes.push(resolve))
        : Promise.resolve(),
    );
    nativeMock = { setWindowMode, platform: 'darwin' };
    useEditor.setState({ projectPath: '/proj', info: projectInfo('Ember Quest') } as any);
    const view = render(<App />);

    await act(async () => finishEditorModes[0]());
    expect(view.getByTestId('workspace')).toBeTruthy();

    await act(async () => {
      useEditor.setState({ projectPath: null, info: null } as any);
    });
    await act(async () => {
      useEditor.setState({ projectPath: '/proj', info: projectInfo('Ember Quest') } as any);
    });

    expect(finishEditorModes).toHaveLength(2);
    expect(view.queryByTestId('workspace')).toBeNull();

    await act(async () => finishEditorModes[1]());
    expect(view.getByTestId('workspace')).toBeTruthy();
  });

  it('reports a native editor-mode failure and mounts the workspace as a fallback', async () => {
    const error = new Error('window resize failed');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setWindowMode.mockRejectedValue(error);
    nativeMock = { setWindowMode, platform: 'darwin' };
    useEditor.setState({ projectPath: '/proj', info: projectInfo('Ember Quest') } as any);

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<App />);
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to enter editor window mode.', error);
    expect(view.getByTestId('workspace')).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('reports a native launcher-mode failure without hiding the launcher', async () => {
    const error = new Error('window resize failed');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setWindowMode.mockRejectedValue(error);
    nativeMock = { setWindowMode, platform: 'darwin' };

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<App />);
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to enter launcher window mode.', error);
    expect(view.getByTestId('launcher')).toBeTruthy();
    errorSpy.mockRestore();
  });
});
