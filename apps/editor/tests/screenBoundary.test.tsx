// @vitest-environment jsdom
/**
 * The boundary that stops one bad row blanking the window.
 *
 * A tester note missing `onTheChange` threw while the history was being drawn.
 * React's answer to a throw during render is to unmount the tree, so the whole
 * app went white, stayed white across a reload, and only came back when the
 * file was deleted, which a person looking at a white window cannot know to do.
 * The note itself is fixed where it is read; this is what makes the NEXT one a
 * panel rather than a blank window.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { ScreenBoundary } from '../src/components/ScreenBoundary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Throws({ message }: { message: string }): React.ReactElement {
  throw new Error(message);
}

describe('ScreenBoundary', () => {
  it('draws what it wraps when nothing goes wrong', () => {
    render(
      <ScreenBoundary surface="Tester">
        <p>a session</p>
      </ScreenBoundary>,
    );
    expect(screen.getByText('a session')).toBeTruthy();
  });

  it('keeps the window alive when its child throws while rendering', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <ScreenBoundary surface="Tester">
          <Throws message="Cannot read properties of undefined (reading 'verdict')" />
        </ScreenBoundary>,
      ),
    ).not.toThrow();
    expect(screen.getByRole('alert').textContent).toMatch(/Tester could not be drawn/);
  });

  it('shows the message verbatim, because it is the only detail worth acting on', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ScreenBoundary surface="Tester">
        <Throws message="note.onTheChange is undefined" />
      </ScreenBoundary>,
    );
    expect(screen.getByText(/note\.onTheChange is undefined/)).toBeTruthy();
  });

  it('says the rest of Hearth is still running, because it is', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ScreenBoundary surface="Tester">
        <Throws message="boom" />
      </ScreenBoundary>,
    );
    expect(screen.getByText(/rest of Hearth is still running/i)).toBeTruthy();
  });

  it('offers a way out when the caller has somewhere to send them', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onLeave = vi.fn();
    render(
      <ScreenBoundary surface="Tester" onLeave={onLeave}>
        <Throws message="boom" />
      </ScreenBoundary>,
    );
    act(() => {
      screen.getByRole('button', { name: /go back/i }).click();
    });
    expect(onLeave).toHaveBeenCalled();
  });

  it('offers no way out when there is nowhere to go, rather than a dead button', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ScreenBoundary surface="Tester">
        <Throws message="boom" />
      </ScreenBoundary>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
