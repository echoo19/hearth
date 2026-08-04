// @vitest-environment jsdom
/**
 * Agent prose, on screen.
 *
 * The parse is pinned next door in markdown.test.ts. What is pinned here is
 * everything that only exists once it reaches the DOM: that plain prose lands
 * in the element it always landed in, that a local path is a control rather
 * than a link and reaches the app's own handlers, that an http link is the
 * kind of link Electron's window-open handler is watching for, and that none
 * of this is built out of an HTML string.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Markdown, pathIsInside, projectRelative } from '../src/components/chat/Markdown';
import { MessageList } from '../src/components/chat/MessageList';
import { useApp } from '../src/store';
import type { ChatMessage } from '../src/types';

const ROOT = '/Users/jake/Hearth/space-shooter';

const openCodePeek = vi.fn();
const revealInFolder = vi.fn();

beforeEach(() => {
  openCodePeek.mockReset();
  revealInFolder.mockReset();
  useApp.setState({ projectPath: ROOT, openCodePeek });
  window.hearthNative = { revealInFolder } as unknown as Window['hearthNative'];
});

afterEach(() => {
  cleanup();
  delete window.hearthNative;
  vi.restoreAllMocks();
});

function show(text: string, live = false): HTMLElement {
  const { container } = render(<Markdown text={text} live={live} />);
  return container;
}

describe('prose with nothing in it to render', () => {
  it('lands in the same element it always did, holding the same characters', () => {
    // The whole point of the fast path. An agent that emits plain prose must
    // look exactly as it did before any of this existed, so the plain case
    // takes the old code path outright rather than a reconstruction of it.
    const container = show('The player ship now fires\nwhen you hold space.');
    const paragraphs = container.querySelectorAll('p.msg-text');
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].textContent).toBe('The player ship now fires\nwhen you hold space.');
    expect(paragraphs[0].className).toBe('msg-text');
  });
});

describe('what the reader can press', () => {
  it('opens a path inside the project in the app viewer, not through an href', () => {
    const container = show(`I changed ${ROOT}/src/game.js to fix it.`);
    const control = screen.getByRole('button', { name: `${ROOT}/src/game.js` });
    expect(control.tagName).toBe('BUTTON');
    expect(container.querySelector('a[href*="game.js"]')).toBeNull();

    fireEvent.click(control);
    expect(openCodePeek).toHaveBeenCalledWith('src/game.js');
    expect(revealInFolder).not.toHaveBeenCalled();
  });

  it('reveals a path outside the project, since there is nothing to peek at', () => {
    show('Your config lives at /etc/hearth/settings.json now.');
    fireEvent.click(screen.getByRole('button', { name: '/etc/hearth/settings.json' }));
    expect(revealInFolder).toHaveBeenCalledWith('/etc/hearth/settings.json');
    expect(openCodePeek).not.toHaveBeenCalled();
  });

  it('drops a line number before opening, but keeps it in the words', () => {
    show(`See ${ROOT}/src/game.js:132 for the loop.`);
    fireEvent.click(screen.getByRole('button', { name: `${ROOT}/src/game.js:132` }));
    expect(openCodePeek).toHaveBeenCalledWith('src/game.js');
  });

  it('sends an http link to the window-open handler by asking for a new window', () => {
    // Electron's setWindowOpenHandler is what turns this into a system browser
    // window, and target="_blank" is the only thing it watches. An in-place
    // navigation would replace the app with the page.
    const container = show('The docs are at https://hearthengine.com/docs today.');
    const link = container.querySelector('a.md-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://hearthengine.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('refuses to make a link out of a script destination', () => {
    const container = show('[press here](javascript:alert(1))');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('press here');
  });
});

describe('a fenced block', () => {
  it('names its language and offers the code, not the fence', () => {
    const container = show('```js\nconst x = 1;\n```');
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('js');
    expect(container.querySelector('.md-code-body')?.textContent).toBe('const x = 1;');
  });

  it('says text when the agent named no language', () => {
    const container = show('```\nplain\n```');
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('text');
  });

  it('copies the code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    show('```js\nconst x = 1;\n```');
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const x = 1;');
  });

  it('withholds the copy button while the block is still filling', () => {
    // Same reason the turn's own copy control stays hidden mid answer: half a
    // function is not worth taking away, and a control that appears part way
    // through invites pressing it too early.
    show('```js\nconst x = 1;', true);
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull();
  });

  it('offers it again once the closing fence lands', () => {
    show('```js\nconst x = 1;\n```', true);
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });
});

describe('the shapes a message can take', () => {
  it('renders headings, lists and emphasis as themselves', () => {
    const container = show('## What changed\n\n- made it **fast**\n- and `tidy`');
    expect(container.querySelector('h2')?.textContent).toBe('What changed');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toBe('fast');
    expect(container.querySelector('code.md-code-span')?.textContent).toBe('tidy');
  });

  it('never builds an element out of a string of markup', () => {
    // No dangerouslySetInnerHTML anywhere in the path, so there is no
    // sanitiser to get wrong: markup is simply never what the text becomes.
    const container = show('Watch out for <img src=x onerror=alert(1)> in prose.');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('working out where a path sits', () => {
  it('will not mistake a sibling folder for a child of the project', () => {
    expect(pathIsInside(`${ROOT}/src/game.js`, ROOT)).toBe(true);
    expect(pathIsInside(`${ROOT}-backup/src/game.js`, ROOT)).toBe(false);
    expect(pathIsInside('/etc/hosts', ROOT)).toBe(false);
    expect(pathIsInside('/etc/hosts', null)).toBe(false);
  });

  it('strips the project root when the separators lean the other way', () => {
    // The Windows case, and the reason this does not reuse ToolChip's
    // relativeTo: that one compares the raw strings, so a path genuinely under
    // the project would be judged inside it and then handed to the viewer
    // still absolute, which finds nothing.
    const winRoot = 'C:\\Users\\jake\\Hearth\\space-shooter';
    const winFile = 'C:\\Users\\jake\\Hearth\\space-shooter\\src\\game.js';
    expect(pathIsInside(winFile, winRoot)).toBe(true);
    expect(projectRelative(winFile, winRoot)).toBe('src/game.js');
  });

  it('leaves a path that is not under the project alone', () => {
    expect(projectRelative('/etc/hosts', ROOT)).toBe('/etc/hosts');
  });
});

describe('a table wider than the column it sits in', () => {
  it('gives its scroller a tab stop and a name, so the far columns are reachable', () => {
    // The box scrolls sideways. Without a tab stop, everything past the right
    // edge is available to a mouse and to nothing else — and a focusable box
    // with no name is announced as an unlabelled group, which is barely
    // better than being unreachable.
    const container = show('| # | Who |\n|---|---|\n| 1 | Mochi |\n');
    const scroller = container.querySelector('.md-table-scroll');
    expect(scroller).toBeTruthy();
    expect(scroller?.getAttribute('tabindex')).toBe('0');
    expect(scroller?.getAttribute('role')).toBe('group');
    expect(scroller?.getAttribute('aria-label')).toBeTruthy();
  });
});

describe('in the transcript', () => {
  function turn(role: ChatMessage['role'], text: string): ChatMessage {
    return { id: `m-${role}`, role, parts: [{ kind: 'text', text }], streaming: false };
  }

  it('reads the agent as markdown and leaves your own words alone', () => {
    // You can see what you typed. Restyling it after the fact is the app
    // editing your words, and asterisks you meant literally would vanish.
    useApp.setState({
      messages: [turn('user', 'make the ship **fast**'), turn('agent', 'Made it **fast**.')],
      chatDriver: 'codex',
    });
    const { container } = render(<MessageList />);

    expect(container.querySelector('.msg-user strong')).toBeNull();
    expect(container.querySelector('.msg-user .msg-text')?.textContent).toBe('make the ship **fast**');
    expect(container.querySelector('.msg-agent strong')?.textContent).toBe('fast');
  });
});
