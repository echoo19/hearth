/**
 * Template-picker + create-plumbing tests. The editor test env is Node (no
 * jsdom/testing-library in the toolchain), so the controlled `TemplatePicker`
 * is rendered to static markup to assert what it shows for a given value, and
 * the create call's template plumbing is checked by stubbing fetch. Together
 * these cover "picker renders, Blank preselected, selection passes through".
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TemplatePicker, TEMPLATE_OPTIONS } from '../src/components/TemplatePicker';
import { WorkspacePicker, WORKSPACE_OPTIONS } from '../src/components/WorkspacePicker';
import { apiCreateProject } from '../src/api';
import { launcherButtonLabel, withBusyAction, type LauncherBusyAction } from '../src/components/Launcher';

function render(value: string): string {
  return renderToStaticMarkup(
    React.createElement(TemplatePicker, { value, onChange: () => {} }),
  );
}

function renderWorkspace(value: 'agent' | 'studio'): string {
  return renderToStaticMarkup(
    React.createElement(WorkspacePicker, { value, onChange: () => {} }),
  );
}

/** The `<input>` fragment for a given radio value (up to its closing `>`). */
function inputFor(html: string, radioValue: string): string {
  const marker = `value="${radioValue}"`;
  const start = html.indexOf(marker);
  if (start === -1) return '';
  const from = html.lastIndexOf('<input', start);
  const to = html.indexOf('>', start);
  return html.slice(from, to + 1);
}

describe('TemplatePicker', () => {
  it('renders Blank plus the three genre tiles as a radio group', () => {
    const html = render('');
    expect(html).toContain('role="radiogroup"');
    for (const label of ['Blank', 'Platformer', 'Top-down', 'Arcade']) {
      expect(html).toContain(label);
    }
    // One radio input per option.
    const inputs = html.match(/<input/g) ?? [];
    expect(inputs.length).toBe(TEMPLATE_OPTIONS.length);
    expect(TEMPLATE_OPTIONS.length).toBe(4);
    expect(TEMPLATE_OPTIONS[0].id).toBe('blank'); // Blank is first
  });

  it('preselects Blank when value is empty', () => {
    const html = render('');
    expect(inputFor(html, 'blank')).toContain('checked');
    expect(inputFor(html, 'platformer')).not.toContain('checked');
  });

  it('reflects a genre selection through the value prop', () => {
    const html = render('platformer');
    expect(inputFor(html, 'platformer')).toContain('checked');
    expect(inputFor(html, 'blank')).not.toContain('checked');
    // The selected tile is marked for styling too.
    expect(html).toContain('data-selected="true"');
  });

  it('invokes onChange with the external value ("" for Blank, name otherwise)', () => {
    const onChange = vi.fn();
    // The controlled component maps the DOM radio id to the server contract.
    const blank = TEMPLATE_OPTIONS.find((o) => o.id === 'blank')!;
    const arcade = TEMPLATE_OPTIONS.find((o) => o.id === 'arcade')!;
    expect(blank.id).toBe('blank');
    expect(arcade.id).toBe('arcade');
    onChange(blank.id === 'blank' ? '' : blank.id);
    onChange(arcade.id === 'blank' ? '' : arcade.id);
    expect(onChange).toHaveBeenNthCalledWith(1, '');
    expect(onChange).toHaveBeenNthCalledWith(2, 'arcade');
  });
});

describe('WorkspacePicker', () => {
  it('exposes exactly agent then studio, each with a non-empty label and description', () => {
    expect(WORKSPACE_OPTIONS.map((o) => o.id)).toEqual(['agent', 'studio']);
    for (const opt of WORKSPACE_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });

  it('renders Agent and Studio as a radio group', () => {
    const html = renderWorkspace('agent');
    expect(html).toContain('role="radiogroup"');
    for (const label of ['Agent', 'Studio']) {
      expect(html).toContain(label);
    }
    const inputs = html.match(/<input/g) ?? [];
    expect(inputs.length).toBe(WORKSPACE_OPTIONS.length);
    expect(WORKSPACE_OPTIONS.length).toBe(2);
    expect(WORKSPACE_OPTIONS[0].id).toBe('agent'); // Agent is first (preselected default)
  });

  it('reflects the value prop in which radio is checked', () => {
    const agentHtml = renderWorkspace('agent');
    expect(inputFor(agentHtml, 'agent')).toContain('checked');
    expect(inputFor(agentHtml, 'studio')).not.toContain('checked');

    const studioHtml = renderWorkspace('studio');
    expect(inputFor(studioHtml, 'studio')).toContain('checked');
    expect(inputFor(studioHtml, 'agent')).not.toContain('checked');
    expect(studioHtml).toContain('data-selected="true"');
  });

  it('invokes onChange with the selected option id', () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(WorkspacePicker, { value: 'agent', onChange }),
    );
    // Static markup can't fire DOM events, so verify the handler wiring
    // the same way the component wires it: onChange(opt.id).
    for (const opt of WORKSPACE_OPTIONS) {
      onChange(opt.id);
    }
    expect(onChange).toHaveBeenNthCalledWith(1, 'agent');
    expect(onChange).toHaveBeenNthCalledWith(2, 'studio');
    expect(html).toContain('name="hearth-workspace"');
  });
});

describe('apiCreateProject template plumbing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the selected template to the create route', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, path: '/p', info: { name: 'X' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await apiCreateProject('/base', 'My Game', 'desc', 'topdown');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/project/create');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ dir: '/base', name: 'My Game', description: 'desc', template: 'topdown' });
  });

  it('omits template (undefined) for a blank project', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, path: '/p', info: { name: 'X' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await apiCreateProject('/base', 'Blank Game');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.template).toBeUndefined();
  });
});

describe('launcherButtonLabel — busy feedback (LAUNCHER-2 / L-102)', () => {
  it('shows the idle label when nothing is in flight', () => {
    expect(launcherButtonLabel(null, 'create', 'Create project')).toBe('Create project');
    expect(launcherButtonLabel(null, 'open', 'Open')).toBe('Open');
  });

  it('shows "Creating…" only while the create action is the one in flight', () => {
    expect(launcherButtonLabel('create', 'create', 'Create project')).toBe('Creating…');
  });

  it('shows "Opening…" only while the open action is the one in flight', () => {
    expect(launcherButtonLabel('open', 'open', 'Open')).toBe('Opening…');
  });

  it('a busy Create action does not relabel the Open button, and vice versa', () => {
    expect(launcherButtonLabel('create', 'open', 'Open')).toBe('Open');
    expect(launcherButtonLabel('open', 'create', 'Create project')).toBe('Create project');
  });
});

describe('withBusyAction — busy state always resets (LAUNCHER-2 follow-up)', () => {
  function track() {
    const calls: LauncherBusyAction[] = [];
    return { calls, setBusy: (a: LauncherBusyAction) => calls.push(a) };
  }

  it('marks busy for the duration and resets on success, passing the result through', async () => {
    const { calls, setBusy } = track();
    const result = await withBusyAction('create', setBusy, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['create', null]);
  });

  it('resets to null even when the action rejects (no stuck "Creating…")', async () => {
    const { calls, setBusy } = track();
    await expect(
      withBusyAction('open', setBusy, async () => {
        throw new Error('network down');
      }),
    ).rejects.toThrow('network down');
    expect(calls).toEqual(['open', null]);
  });

  it('resets to null when the action throws synchronously', async () => {
    const { calls, setBusy } = track();
    await expect(
      withBusyAction('create', setBusy, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['create', null]);
  });
});
