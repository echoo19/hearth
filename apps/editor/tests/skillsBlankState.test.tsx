// @vitest-environment jsdom
/**
 * What the Skills screen says before it knows anything.
 *
 * The rule this app holds itself to: never render "there is nothing" when the
 * truth is "we have not looked yet". The Tester screen already does this ("Looking
 * for past sessions…" until the read lands); Skills did not. It opened on
 * "No skills yet." plus a paragraph explaining what a skill is — to someone
 * with twelve of them, for as long as the round trip took — and then swapped
 * both for the list, which is the screen taking back what it just said.
 *
 * `loading` could not carry this on its own: it is false before the effect
 * that reads has even run, so an empty list plus `loading: false` was BOTH "you
 * have none" and "nobody has looked".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { SkillsScreen } from '../src/components/skills/SkillsScreen';
import { useApp } from '../src/store';

/** One answer from /api/skills, handed over when the test decides. */
function deferredSkills(): { answer: (skills: unknown[]) => void } {
  let release: ((value: Response) => void) | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          if (!String(input).includes('/api/skills')) {
            resolve({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response);
            return;
          }
          release = resolve;
        }),
    ),
  );
  return {
    answer: (skills) => {
      release?.({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, skills, root: '/home/dev/.hearth/skills' }),
      } as Response);
    },
  };
}

beforeEach(() => {
  useApp.setState({ projectPath: null, projectName: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Skills screen before the list arrives', () => {
  it('says it is looking, not that there is nothing', async () => {
    const pending = deferredSkills();
    render(<SkillsScreen />);

    expect(screen.getByText(/Looking for your skills/i)).toBeTruthy();
    expect(screen.queryByText('No skills yet.')).toBeNull();
    // The explainer belongs to a real emptiness, not to a pending read.
    expect(screen.queryByText(/A skill is a folder with a SKILL\.md/i)).toBeNull();

    pending.answer([]);
    await waitFor(() => expect(screen.getByText('No skills yet.')).toBeTruthy());
    expect(screen.getByText(/A skill is a folder with a SKILL\.md/i)).toBeTruthy();
  });

  it('never claims emptiness in front of a list that was on its way', async () => {
    const pending = deferredSkills();
    render(<SkillsScreen />);
    expect(screen.queryByText('No skills yet.')).toBeNull();

    pending.answer([
      {
        id: 'pixel-art',
        name: 'Pixel art',
        description: 'Drawing sprites.',
        path: '/home/dev/.hearth/skills/pixel-art',
        enabled: true,
        files: 1,
        updatedAt: '2026-07-20T10:00:00.000Z',
        editable: true,
      },
    ]);

    await waitFor(() => expect(screen.getByText('Pixel art')).toBeTruthy());
    expect(screen.queryByText('No skills yet.')).toBeNull();
    expect(screen.queryByText(/Looking for your skills/i)).toBeNull();
  });
});
