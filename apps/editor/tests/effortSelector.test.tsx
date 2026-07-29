// @vitest-environment jsdom
/**
 * The effort control, which is not there most of the time.
 *
 * Effort is the model's vocabulary and not ours: codex answers it per model
 * from `model/list`, and today's Claude models declare none at all. So a
 * permanent third pill in the composer would be a dial wired to nothing for
 * half the agents in the app — present, greyed, and a promise the turn does not
 * keep. It disappears instead, and the rule is evidence rather than vendor:
 * whatever the RESOLVED model declared, nothing when it declared nothing. The
 * check it replaced was `provider === 'openai'`, which was true of every model
 * with efforts on the day it was written and would hide a working dial the
 * moment a Claude model shipped one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EffortSelector } from '../src/components/chat/ModelSelector';
import { setModelChoice } from '../src/chat/modelChoice';
import { useApp } from '../src/store';
import type { ChatProviderStatus } from '../src/types';

/**
 * Both catalogues as the two backends really report them: the codex model
 * declares its efforts and which one it falls back to, the Claude models
 * declare no efforts at all. The asymmetry is the subject here.
 */
function bothReady(): ChatProviderStatus {
  return {
    anthropic: {
      hasKey: true,
      source: 'project',
      cli: false,
      loggedIn: false,
      email: null,
      planType: null,
      models: [{ id: 'claude-opus-5', label: 'Opus 5' }],
    },
    openai: {
      installed: true,
      version: '0.144.5',
      loggedIn: true,
      authMode: 'chatgpt',
      email: null,
      planType: null,
      hasKey: false,
      models: [
        {
          id: 'gpt-5.6-sol',
          label: 'GPT-5.6-Sol',
          isDefault: true,
          efforts: [{ id: 'low' }, { id: 'high' }],
          defaultEffort: 'low',
        },
      ],
    },
    active: 'anthropic',
  };
}

const pill = () => screen.queryByRole('button', { name: 'Effort' });

beforeEach(() => {
  localStorage.clear();
  // Module-level store: a pick made in one test outlives it otherwise.
  setModelChoice(null);
  useApp.setState({ providers: bothReady() } as Partial<ReturnType<typeof useApp.getState>>);
});

afterEach(() => {
  cleanup();
  setModelChoice(null);
  localStorage.clear();
});

describe('when the model declared no efforts', () => {
  it('renders nothing at all, rather than a dial nothing is wired to', () => {
    // The case that matters: every Claude model today. A control that is
    // present and inert is worse than no control, because it reads as a setting
    // the turn will honour.
    setModelChoice({ provider: 'anthropic', model: 'claude-opus-5', effort: null });
    const { container } = render(<EffortSelector />);
    expect(pill()).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing before a catalogue has landed', () => {
    // Home has no folder open, so nothing has described any model yet. A dial
    // drawn on a guess would be a guess about what the turn carries.
    setModelChoice({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' });
    useApp.setState({ providers: null } as Partial<ReturnType<typeof useApp.getState>>);
    render(<EffortSelector />);
    expect(pill()).toBeNull();
  });

  it('renders nothing when no model has been chosen at all', () => {
    render(<EffortSelector />);
    expect(pill()).toBeNull();
  });
});

describe('when the model declared efforts', () => {
  it('appears, and reads Automatic until one is picked', () => {
    setModelChoice({ provider: 'openai', model: 'gpt-5.6-sol', effort: null });
    render(<EffortSelector />);
    expect(pill()?.textContent).toContain('Automatic');
  });

  it('offers exactly what that model declared, plus the row that hands it back', () => {
    setModelChoice({ provider: 'openai', model: 'gpt-5.6-sol', effort: null });
    render(<EffortSelector />);
    fireEvent.click(pill() as HTMLElement);

    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(3);
    for (const name of ['Automatic', 'Low', 'High']) {
      expect(screen.getByRole('menuitemcheckbox', { name })).toBeTruthy();
    }
    // Nothing this model did not declare. `medium` is real on other codex
    // builds, and offering it here would be a row whose turn fails on send.
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Medium' })).toBeNull();
    // Named with what it resolves to. "Automatic" on its own is the one row
    // here that does not say what it does.
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Automatic' }).querySelector('.menu-shortcut')?.textContent,
    ).toBe('Low');
  });

  it('stores the pick and says it on the pill', () => {
    setModelChoice({ provider: 'openai', model: 'gpt-5.6-sol', effort: null });
    render(<EffortSelector />);
    fireEvent.click(pill() as HTMLElement);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /High/ }));

    expect(JSON.parse(localStorage.getItem('hearth:modelChoice') ?? 'null')).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(pill()?.textContent).toContain('High');
  });

  it('shows the effort a turn would actually carry, not the one storage holds', () => {
    // Stored while a bigger model was selected; this one does not take `ultra`,
    // so the turn runs at the model's default. The tick has to agree with that
    // or the control is describing a setting the send path already dropped.
    setModelChoice({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'ultra' });
    render(<EffortSelector />);
    expect(pill()?.textContent).toContain('Automatic');
    fireEvent.click(pill() as HTMLElement);
    expect(screen.getByRole('menuitemcheckbox', { name: /Automatic/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('appears for a Claude model the moment one declares efforts', () => {
    // Nothing in the control knows about vendors, and this is the proof: the
    // same fixture with efforts on the Claude side draws the same dial.
    const status = bothReady();
    status.anthropic.models = [
      { id: 'claude-opus-5', label: 'Opus 5', efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' },
    ];
    useApp.setState({ providers: status } as Partial<ReturnType<typeof useApp.getState>>);
    setModelChoice({ provider: 'anthropic', model: 'claude-opus-5', effort: 'high' });
    render(<EffortSelector />);
    expect(pill()?.textContent).toContain('High');
  });
});
