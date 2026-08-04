/**
 * The parse, on its own.
 *
 * Two properties matter more than any individual construct here, and most of
 * these cases exist to pin one of them: plain prose has to survive untouched,
 * and nothing may be recognised until the thing that closes it has arrived.
 * The second is what keeps a message from flickering while it streams in.
 */
import { describe, it, expect } from 'vitest';
import { isPlainProse, parseInline, parseMarkdown, type MdFence, type MdList } from '../src/chat/markdown';

/** The text of a parse, with the structure discarded. */
function flatten(spans: ReturnType<typeof parseInline>): string {
  return spans
    .map((span) => {
      switch (span.kind) {
        case 'text':
        case 'code':
          return span.text;
        case 'path':
          return span.text;
        default:
          return flatten(span.spans);
      }
    })
    .join('');
}

describe('prose that carries no markdown', () => {
  it('comes out as one paragraph holding exactly what went in', () => {
    const blocks = parseMarkdown('Just a sentence about the game.');
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'Just a sentence about the game.' }] },
    ]);
    expect(isPlainProse(blocks, 'Just a sentence about the game.')).toBe(true);
  });

  it('keeps single newlines rather than folding them into spaces', () => {
    // The transcript has always shown the agent's line breaks where the agent
    // put them, because the element is pre-wrap. A document renderer would
    // join these two lines into one, which would move text on the screen for
    // every plain message in the app.
    const blocks = parseMarkdown('Line one\nLine two');
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'Line one\nLine two' }] },
    ]);
    expect(isPlainProse(blocks, 'Line one\nLine two')).toBe(true);
  });

  it('splits on a blank line, which is the one gap the renderer has to match', () => {
    expect(parseMarkdown('First.\n\nSecond.')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'First.' }] },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'Second.' }] },
    ]);
  });

  it('does not read a hash inside a word as a heading', () => {
    expect(parseMarkdown('#hashtag')[0].kind).toBe('paragraph');
  });

  it('leaves an underscored identifier alone', () => {
    // Every agent message about code is full of these, and treating the inner
    // underscores as emphasis turned half of each name italic.
    expect(parseInline('call read_input_names first')).toEqual([
      { kind: 'text', text: 'call read_input_names first' },
    ]);
  });

  it('leaves a lone asterisk alone', () => {
    expect(parseInline('a * b * c')).toEqual([{ kind: 'text', text: 'a * b * c' }]);
  });

  it('is not called plain when something was taken out of it', () => {
    // The trap this guards. A dropped link leaves a paragraph of nothing but
    // text spans, so the shape says untouched while the characters say
    // otherwise, and reprinting the source would put the brackets back.
    const source = '[press here](javascript:alert(1))';
    expect(isPlainProse(parseMarkdown(source), source)).toBe(false);
  });
});

describe('a message that is still arriving', () => {
  it('does not open a code block on a fence whose line is half typed', () => {
    // The characters land one at a time, so there is a moment where the info
    // string is `js` and a moment before that where it is `j`. Opening on
    // either would put the rest of the message in a code block and then take
    // it back out again.
    const blocks = parseMarkdown('Here is the fix:\n\n```js', true);
    expect(blocks.every((block) => block.kind !== 'fence')).toBe(true);
  });

  it('opens the block once the newline after the info line lands', () => {
    const blocks = parseMarkdown('Here is the fix:\n\n```js\n', true);
    expect(blocks[1]).toEqual({ kind: 'fence', lang: 'js', text: '', closed: false });
  });

  it('keeps an unclosed block a block, so it never snaps into one later', () => {
    // The opposite choice, holding the lines as prose until the closing fence
    // arrives, is the flash: a paragraph would reflow into a code block the
    // instant the closer landed. Once the fence is real the lines under it are
    // code, and `closed` is how the renderer knows to hold the copy button.
    const blocks = parseMarkdown('```ts\nconst x = 1;\nconst y = 2;', true);
    expect(blocks[0]).toEqual({
      kind: 'fence',
      lang: 'ts',
      text: 'const x = 1;\nconst y = 2;',
      closed: false,
    });
  });

  it('treats a half-written fence as real once the turn is finished', () => {
    const blocks = parseMarkdown('```js', false);
    expect((blocks[0] as MdFence).kind).toBe('fence');
  });

  it('shows an opening backtick with no partner as a backtick', () => {
    expect(parseInline('run `hearth swe')).toEqual([{ kind: 'text', text: 'run `hearth swe' }]);
  });

  it('shows a half-written bold marker as asterisks', () => {
    expect(flatten(parseInline('this is **impor'))).toBe('this is **impor');
    expect(parseInline('this is **impor').every((span) => span.kind === 'text')).toBe(true);
  });

  it('does not turn a half-written link into anything', () => {
    expect(flatten(parseInline('see [the docs](https://hearth'))).toBe('see [the docs](https://hearth');
  });
});

describe('blocks', () => {
  it('reads headings and caps nothing on the way in', () => {
    expect(parseMarkdown('## What changed')).toEqual([
      { kind: 'heading', level: 2, spans: [{ kind: 'text', text: 'What changed' }] },
    ]);
  });

  it('reads a bullet list', () => {
    const list = parseMarkdown('- one\n- two')[0] as MdList;
    expect(list.kind).toBe('list');
    expect(list.ordered).toBe(false);
    expect(list.items.map((item) => flatten(item.spans))).toEqual(['one', 'two']);
  });

  it('keeps the number an ordered list actually starts at', () => {
    const list = parseMarkdown('3. three\n4. four')[0] as MdList;
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
  });

  it('nests a list that is indented under an item', () => {
    const list = parseMarkdown('- outer\n  - inner\n- second')[0] as MdList;
    expect(list.items).toHaveLength(2);
    expect(flatten(list.items[0].children!.items[0].spans)).toBe('inner');
  });

  it.each([
    ['ordered', '1. first\nMore about the first.\n\n2. second\nMore about the second.'],
    ['unordered', '- first\nMore about the first.\n\n- second\nMore about the second.'],
  ])('keeps prose and blank-separated items in one %s list', (_kind, source) => {
    const blocks = parseMarkdown(source);
    const list = blocks[0] as MdList;

    expect(blocks).toHaveLength(1);
    expect(list.items.map((item) => flatten(item.spans))).toEqual([
      'first More about the first.',
      'second More about the second.',
    ]);
  });

  it('ends a list when a blank line is followed by prose', () => {
    const blocks = parseMarkdown('- item\n\nA separate paragraph.');

    expect(blocks.map((block) => block.kind)).toEqual(['list', 'paragraph']);
  });

  it('carries the language label off the fence', () => {
    expect(parseMarkdown('```python\nx = 1\n```')[0]).toEqual({
      kind: 'fence',
      lang: 'python',
      text: 'x = 1',
      closed: true,
    });
  });

  it('does not open a fence on a sentence that quotes one inline', () => {
    // Backticks in the info string mean the line is prose about fences rather
    // than a fence, which is the difference between explaining markdown and
    // writing it.
    expect(parseMarkdown('Wrap it in ```like this``` to fence it')[0].kind).toBe('paragraph');
  });
});

describe('spans', () => {
  it('reads inline code and stops parsing inside it', () => {
    expect(parseInline('call `run_*_now` please')).toEqual([
      { kind: 'text', text: 'call ' },
      { kind: 'code', text: 'run_*_now' },
      { kind: 'text', text: ' please' },
    ]);
  });

  it('reads bold and italic', () => {
    expect(parseInline('**bold**')).toEqual([
      { kind: 'strong', spans: [{ kind: 'text', text: 'bold' }] },
    ]);
    expect(parseInline('*soft*')).toEqual([{ kind: 'em', spans: [{ kind: 'text', text: 'soft' }] }]);
  });

  it('reads a link', () => {
    expect(parseInline('[the docs](https://hearthengine.com)')).toEqual([
      {
        kind: 'link',
        href: 'https://hearthengine.com',
        spans: [{ kind: 'text', text: 'the docs' }],
      },
    ]);
  });

  it('keeps the label but drops a destination that is not a real one', () => {
    // This is the sanitiser, and it works by never building the link rather
    // than by cleaning one up: a script destination cannot reach an element as
    // an href because it does not become a link at all.
    const spans = parseInline('[click me](javascript:alert(1))');
    expect(spans.every((span) => span.kind === 'text')).toBe(true);
    expect(flatten(spans)).toBe('click me');
  });

  it('links a bare url without dragging the sentence full stop into it', () => {
    expect(parseInline('read https://hearthengine.com/docs.')).toEqual([
      { kind: 'text', text: 'read ' },
      {
        kind: 'link',
        href: 'https://hearthengine.com/docs',
        spans: [{ kind: 'text', text: 'https://hearthengine.com/docs' }],
      },
      { kind: 'text', text: '.' },
    ]);
  });
});

describe('absolute paths, with no link syntax around them', () => {
  it('makes a bare posix path a path span', () => {
    expect(parseInline('edited /Users/jake/game/src/game.js today')).toEqual([
      { kind: 'text', text: 'edited ' },
      { kind: 'path', target: '/Users/jake/game/src/game.js', text: '/Users/jake/game/src/game.js' },
      { kind: 'text', text: ' today' },
    ]);
  });

  it('keeps a line number in the words but not in what it opens', () => {
    expect(parseInline('/Users/jake/game/src/game.js:132')).toEqual([
      { kind: 'path', target: '/Users/jake/game/src/game.js', text: '/Users/jake/game/src/game.js:132' },
    ]);
  });

  it('reads a drive letter path', () => {
    expect(parseInline('C:\\Users\\jake\\game\\src\\game.js')).toEqual([
      {
        kind: 'path',
        target: 'C:\\Users\\jake\\game\\src\\game.js',
        text: 'C:\\Users\\jake\\game\\src\\game.js',
      },
    ]);
  });

  it('does not find a path inside a relative one', () => {
    // `docs/a/b` contains the characters of `/a/b`, and reading that as an
    // absolute path would put a control on the tail of an ordinary word.
    expect(parseInline('see docs/guides/playtesting for more')).toEqual([
      { kind: 'text', text: 'see docs/guides/playtesting for more' },
    ]);
  });

  it('leaves the everyday slashes in a sentence alone', () => {
    expect(parseInline('and/or, 24/7, either/or')).toEqual([
      { kind: 'text', text: 'and/or, 24/7, either/or' },
    ]);
  });

  it('takes a path out of link syntax and keeps it a path', () => {
    // A local file is opened, never navigated to, so it stays a path span
    // whatever syntax the agent wrapped it in.
    expect(parseInline('[the entry point](/Users/jake/game/src/game.js)')).toEqual([
      { kind: 'path', target: '/Users/jake/game/src/game.js', text: 'the entry point' },
    ]);
  });
});

describe('pipe tables', () => {
  const table = (source: string) => parseMarkdown(source).find((block) => block.kind === 'table');

  it('reads a header, its alignment row and its body', () => {
    // What a spec sheet is full of, and what the transcript used to print as
    // raw pipes and dashes.
    const found = table('| # | Character | Cost |\n|---|:---------:|-----:|\n| 1 | Mochi | 50 |\n| 2 | Ittetsu | 50 |\n');
    expect(found).toBeTruthy();
    if (found?.kind !== 'table') throw new Error('not a table');
    expect(found.align).toEqual([null, 'center', 'right']);
    expect(found.head.map((cell) => flatten(cell))).toEqual(['#', 'Character', 'Cost']);
    expect(found.rows).toHaveLength(2);
    expect(found.rows[1].map((cell) => flatten(cell))).toEqual(['2', 'Ittetsu', '50']);
  });

  it('parses each cell as inline markdown', () => {
    const found = table('| Who | Note |\n|---|---|\n| **Mochi** | `50` energy |\n');
    if (found?.kind !== 'table') throw new Error('not a table');
    expect(found.rows[0][0][0]).toMatchObject({ kind: 'strong' });
    expect(found.rows[0][1][0]).toMatchObject({ kind: 'code', text: '50' });
  });

  it('survives a ragged row rather than refusing to draw', () => {
    // Agents miss a pipe. The delimiter row is the authority on how many
    // columns there are, exactly as it is in the spec.
    const found = table('| A | B | C |\n|---|---|---|\n| 1 | 2 |\n| 1 | 2 | 3 | 4 |\n');
    if (found?.kind !== 'table') throw new Error('not a table');
    expect(found.rows[0]).toHaveLength(3);
    expect(flatten(found.rows[0][2])).toBe('');
    expect(found.rows[1]).toHaveLength(3);
  });

  it('is not a table until the row that says it is one has arrived', () => {
    // The file's rule: a half-written marker is not a marker. A header line on
    // its own is a paragraph of pipes, which is what it looks like.
    expect(parseMarkdown('| # | Character |', true)[0].kind).toBe('paragraph');
    expect(parseMarkdown('| # | Character |\n|---|---|', true)[0].kind).toBe('paragraph');
    expect(parseMarkdown('| # | Character |\n|---|---|\n', true)[0].kind).toBe('table');
  });

  it('leaves an escaped pipe inside its cell', () => {
    const found = table('| Keys |\n|---|\n| a \\| b |\n');
    if (found?.kind !== 'table') throw new Error('not a table');
    expect(flatten(found.rows[0][0])).toBe('a | b');
  });

  it('leaves a bare dash run alone under a sentence that mentions a pipe', () => {
    // The delimiter row has to carry a pipe of its own. Without that rule
    // `---` is a valid one-column alignment row, and the sentence above it —
    // any sentence with a `|` in it — became a one-column table's heading
    // while the rule itself was swallowed.
    const source = 'Press the | key to open it\n---';
    const blocks = parseMarkdown(source);
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph']);
    expect(isPlainProse(blocks, source)).toBe(true);
  });

  it('does not count an escaped pipe as the delimiter row having one', () => {
    const blocks = parseMarkdown('| Keys |\n\\|---\\|\n');
    expect(blocks.every((block) => block.kind !== 'table')).toBe(true);
  });

  it('still draws a one-column table written with pipes', () => {
    const found = table('| Keys |\n|---|\n| Space |\n');
    if (found?.kind !== 'table') throw new Error('not a table');
    expect(found.align).toEqual([null]);
    expect(found.head.map((cell) => flatten(cell))).toEqual(['Keys']);
    expect(flatten(found.rows[0][0])).toBe('Space');
  });

  it('ends a paragraph that runs into one', () => {
    const blocks = parseMarkdown('Here is the cast:\n| # | Who |\n|---|---|\n| 1 | Mochi |\n');
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'table']);
  });
});
