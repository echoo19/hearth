/**
 * Agent prose, rendered.
 *
 * The transcript printed the agent's markdown as characters, so a link showed
 * its brackets and a code span showed its backticks. This turns that into what
 * it was meant to be, and does so entirely on the reading side: no agent is
 * ever told to write markdown, or told not to, and a message that contains
 * none comes out of here byte for byte as before, in the same element with the
 * same rules. See chat/markdown.ts for why the parse is built to hold still
 * while a message is arriving.
 *
 * Nothing here builds HTML from a string. Every element is a real element, so
 * there is no sanitiser to get wrong: an agent cannot write markup into the
 * app because markup is never what its text becomes.
 *
 * Paths are the point as much as the formatting is. An agent that just edited
 * a file says its name in the sentence, and that name is the most useful thing
 * in the message to be able to press. So an absolute path is a control whether
 * or not the agent wrapped it in link syntax, and it opens through the same
 * peek and reveal the rest of the app already uses rather than through an
 * href, which for a local file would ask the browser to navigate away.
 */
import React, { useMemo } from 'react';
import { useApp } from '../../store';
import { hearthNative } from '../../native';
import { useCopy } from '../../useCopy';
import { Icon } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { isPlainProse, parseMarkdown, type MdBlock, type MdList, type MdSpan, type MdTable } from '../../chat/markdown';

/** Windows writes separators the other way; comparing depth should not care. */
function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

export function pathIsInside(target: string, root: string | null): boolean {
  if (!root) return false;
  const path = normalizeSeparators(target);
  const base = normalizeSeparators(root).replace(/\/$/, '');
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The path the file viewer wants, which is the one relative to the project.
 *
 * ToolChip's `relativeTo` is the same idea but compares the raw strings, so on
 * Windows a path under the project fails to strip: the root and the path agree
 * on the folder and disagree on which way the separators lean. Normalising
 * first is the whole difference, and the viewer reads forward slashes on every
 * platform.
 */
export function projectRelative(target: string, root: string | null): string {
  const path = normalizeSeparators(target);
  if (!root) return path;
  const base = normalizeSeparators(root).replace(/\/$/, '');
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/**
 * An absolute path on this machine.
 *
 * A button rather than a link. Inside the project it opens the file in the
 * app's own viewer, which is what every other clickable path in the transcript
 * does; outside it there is nothing to show, so it asks the OS to reveal the
 * file where it lives. Neither is a navigation, and giving either one an href
 * would put a real one behind it.
 */
function PathSpan({ target, text }: { target: string; text: string }) {
  const projectPath = useApp((s) => s.projectPath);
  const openCodePeek = useApp((s) => s.openCodePeek);
  const inside = pathIsInside(target, projectPath);

  return (
    <button
      type="button"
      className="md-path"
      onClick={() => {
        if (inside) openCodePeek(projectRelative(target, projectPath));
        else void hearthNative()?.revealInFolder(target);
      }}
    >
      {text}
    </button>
  );
}

/**
 * An http destination.
 *
 * `target="_blank"` on purpose: that is what Electron's window-open handler
 * watches, and it answers by handing the URL to the system browser and
 * refusing the window. Opening a page inside the app would replace the app.
 */
function LinkSpan({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="md-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.kind) {
          case 'text':
            return <React.Fragment key={index}>{span.text}</React.Fragment>;
          case 'code':
            return (
              <code key={index} className="md-code-span">
                {span.text}
              </code>
            );
          case 'strong':
            return (
              <strong key={index}>
                <Spans spans={span.spans} />
              </strong>
            );
          case 'em':
            return (
              <em key={index}>
                <Spans spans={span.spans} />
              </em>
            );
          case 'link':
            return (
              <LinkSpan key={index} href={span.href}>
                <Spans spans={span.spans} />
              </LinkSpan>
            );
          default:
            return <PathSpan key={index} target={span.target} text={span.text} />;
        }
      })}
    </>
  );
}

function List({ list }: { list: MdList }) {
  const items = list.items.map((item, index) => (
    <li key={index} className="md-item">
      <Spans spans={item.spans} />
      {item.children ? <List list={item.children} /> : null}
    </li>
  ));
  return list.ordered ? (
    <ol className="md-list md-block" start={list.start}>
      {items}
    </ol>
  ) : (
    <ul className="md-list md-block">{items}</ul>
  );
}

/**
 * A fenced block.
 *
 * The copy button is withheld while the block is still filling, for the same
 * reason the turn's own copy control is: half a function is not worth taking
 * away, and a control that appears mid-answer invites pressing it too early.
 */
function CodeBlock({ lang, text, pending }: { lang: string; text: string; pending: boolean }) {
  const { copied, copy } = useCopy();
  return (
    <div className="md-code md-block">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang === '' ? 'text' : lang}</span>
        {!pending && (
          <Tooltip content={copied ? 'Copied' : 'Copy'} side="left">
            <button
              type="button"
              className="md-code-copy"
              onClick={() => copy(text)}
              aria-label={copied ? 'Copied' : 'Copy code'}
            >
              <Icon name={copied ? 'check' : 'copy'} size={12} />
            </button>
          </Tooltip>
        )}
      </div>
      <pre className="md-code-body">
        <code>{text}</code>
      </pre>
    </div>
  );
}

/**
 * A pipe table.
 *
 * Wrapped in its own scroller: a spec's cast table is nine columns wide and the
 * column it is read in is not, and a table that widens the page pushes every
 * paragraph around it off the screen. Alignment rides on a data attribute
 * rather than an inline style, so the whole look stays in the stylesheet.
 */
function Table({ table }: { table: MdTable }) {
  return (
    <div className="md-table-scroll md-block">
      <table className="md-table">
        <thead>
          <tr>
            {table.head.map((cell, index) => (
              <th key={index} data-align={table.align[index] ?? undefined} scope="col">
                <Spans spans={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} data-align={table.align[index] ?? undefined}>
                  <Spans spans={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block, live }: { block: MdBlock; live: boolean }) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p className="msg-text md-block">
          <Spans spans={block.spans} />
        </p>
      );
    case 'heading': {
      const Tag = `h${Math.min(block.level, 6)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag className={`md-heading md-h${Math.min(block.level, 6)} md-block`}>
          <Spans spans={block.spans} />
        </Tag>
      );
    }
    case 'list':
      return <List list={block} />;
    case 'table':
      return <Table table={block} />;
    default:
      return <CodeBlock lang={block.lang} text={block.text} pending={live && !block.closed} />;
  }
}

export function Markdown({ text, live }: { text: string; live: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text, live), [text, live]);

  // The overwhelmingly common message is one run of prose. It takes the old
  // path outright rather than an equivalent one, so there is no way for this
  // to drift into rendering plain text differently from how it always was.
  if (isPlainProse(blocks, text)) {
    return <p className="msg-text">{text}</p>;
  }

  // Nothing to draw is not a thing to draw. An empty `.md` still takes its
  // place in the turn's flex column and still claims the 12px gap on both
  // sides of itself: eleven of them in one measured transcript added 264px of
  // whitespace that looked like deliberate spacing, and each one broke the
  // rule that closes consecutive machinery rows to 4px.
  if (blocks.length === 0) return null;

  return (
    <div className="md">
      {blocks.map((block, index) => (
        <Block key={index} block={block} live={live} />
      ))}
    </div>
  );
}
