/**
 * L-058: closing a project must not silently discard unsaved script buffers.
 * The "Close project" menu item routes through requestCloseProject(), which
 * closes immediately when nothing is dirty but defers to a confirm (bumping
 * closeProjectRequest for the Code panel to surface) when there are unsaved
 * scripts. CodePanel publishes the dirty state via setUnsavedScripts().
 *
 * Pure store coverage — no project needs to be open for these signals.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store';

beforeEach(() => {
  useEditor.setState({
    projectPath: '/tmp/proj',
    info: { name: 'Demo' } as never,
    hasUnsavedScripts: false,
    closeProjectRequest: 0,
  });
});

describe('requestCloseProject (L-058)', () => {
  it('closes immediately when there are no unsaved scripts', () => {
    useEditor.setState({ hasUnsavedScripts: false });
    const before = useEditor.getState().closeProjectRequest;
    useEditor.getState().requestCloseProject();
    // closeProject() clears projectPath and does NOT bump the confirm counter.
    expect(useEditor.getState().projectPath).toBeNull();
    expect(useEditor.getState().closeProjectRequest).toBe(before);
  });

  it('defers to a confirm (bumps closeProjectRequest, leaves the project open) when scripts are unsaved', () => {
    useEditor.setState({ hasUnsavedScripts: true });
    const before = useEditor.getState().closeProjectRequest;
    useEditor.getState().requestCloseProject();
    expect(useEditor.getState().projectPath).toBe('/tmp/proj'); // still open — waiting on the user
    expect(useEditor.getState().closeProjectRequest).toBe(before + 1);
  });

  it('a second close attempt after a cancel re-bumps the counter (re-triggers the dialog)', () => {
    useEditor.setState({ hasUnsavedScripts: true });
    useEditor.getState().requestCloseProject();
    const after1 = useEditor.getState().closeProjectRequest;
    useEditor.getState().requestCloseProject();
    expect(useEditor.getState().closeProjectRequest).toBe(after1 + 1);
  });
});

describe('setUnsavedScripts (L-058)', () => {
  it('publishes the dirty flag', () => {
    useEditor.getState().setUnsavedScripts(true);
    expect(useEditor.getState().hasUnsavedScripts).toBe(true);
    useEditor.getState().setUnsavedScripts(false);
    expect(useEditor.getState().hasUnsavedScripts).toBe(false);
  });

  it('closeProject() resets the unsaved-scripts flag', () => {
    useEditor.setState({ hasUnsavedScripts: true });
    useEditor.getState().closeProject();
    expect(useEditor.getState().hasUnsavedScripts).toBe(false);
  });
});
