import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Copy sweep: keeps engine jargon ("snapshot", "diff", "baseline") out of
 * rendered, human-facing editor copy now that the toolbar/panels use plain
 * language (Checkpoint / Review / Changes — see Toolbar.tsx, DiffPanel.tsx,
 * Workspace.tsx's PANEL_TITLES, agent/Timeline.tsx).
 *
 * This is a regex sweep over source text, not an AST parse — deliberately
 * coarse (per the task brief) so it stays robust to reformatting. It only
 * looks at positions where a string literal actually renders to the user:
 *   (a) JSX text nodes (`>...<`)
 *   (b) specific dialog/tooltip attributes: title=, aria-label=, body=, confirmLabel=
 *   (c) the message argument of log(level, source, message) calls
 *   (d) the PANEL_TITLES record in Workspace.tsx (dockview tab titles)
 * It intentionally ignores className values, TS identifiers/types, and code
 * comments — none of those are shown to a user.
 *
 * CLI verbs, MCP tool names, and internal identifiers (diffFocusRequest,
 * refreshDiff, panel id 'diff', snapshotProject, diffProject, revertProject,
 * ProjectDiff, etc.) are out of scope for renaming and are excluded below —
 * either structurally (they're not in a rendered position) or via the
 * allowlist when they happen to sit inside rendered copy that legitimately
 * still needs to say the real command name.
 */

const SRC_DIR = path.resolve(__dirname, '../src');
const TARGET_RE = /\b(snapshot|diff|baseline)\b/i;

/**
 * Explicit allowlist: `${relative path from apps/editor/src}:${1-indexed line}`.
 * Every entry has a comment explaining why the jargon word is legitimate there.
 */
// Nothing needed here right now: AgentPanel.tsx's `hearth snapshot` /
// `hearth diff` CLI-hint lines (113, 116) live inside a plain template-literal
// array assigned to a const, not a JSX text node, a tracked attribute, or a
// log() call, so the sweep never scans them — verified by emptying this set
// and confirming the test still passes. And the "golden rules" bullets that
// used to restate "Snapshot"/"Diff" (253, 267) were reworded to the plain
// vocabulary (Checkpoint/Review), so they no longer match the jargon regex
// either. If a future edit needs a real allowlist entry, add it here with a
// comment explaining why the jargon word is legitimate at that position.
const ALLOWLIST = new Set<string>([]);

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsxFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Blank out every character except newlines, so line numbers stay stable. */
function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}

/**
 * Replace every `{...}` JS-expression region with a same-length blanked
 * string (iterated to a fixpoint so nested braces, e.g. `style={{ ... }}`,
 * are fully peeled). Preserves every other character's index/line number,
 * so match positions found afterward map 1:1 back to the original file.
 */
function stripBraceExpressions(content: string): string {
  let prev = content;
  for (let i = 0; i < 20; i++) {
    const next = prev.replace(/\{[^{}]*\}/g, blank);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function findingsFor(absPath: string, content: string): Finding[] {
  const relFile = path.relative(SRC_DIR, absPath).split(path.sep).join('/');
  const findings: Finding[] = [];

  // (a) JSX text nodes — plain text directly between `>` and the next `<`
  // (no expression braces in between), and (a2) text that follows a `}`
  // closing a conditional/expression right before the next `<` (covers
  // `{cond && <Icon/>} Snapshot`-style trailing labels). Both run on the
  // untouched file — NOT on a brace-stripped copy: an earlier version of
  // this test iteratively stripped every `{...}` region to a fixpoint, but
  // that also eventually hollows out and strips the *component's own*
  // function-body braces once every JSX expression inside has been reduced
  // to a leaf, silently deleting the real button/JSX text along with it.
  // Scanning the raw text and filtering out code-shaped spans is safer.
  for (const re of [/>([^<>{}]+)</g, /\}([^<>{}]+)</g]) {
    for (const m of content.matchAll(re)) {
      const raw = m[1];
      // TS generics (`Record<PanelId, string>`), stray `<`/`>` comparison
      // operators, and JSX ternaries (`!diff ? (<div>...</div>) : (...)`)
      // also fit this `>text<` shape. Real JSX text is short prose with no
      // statement punctuation, so reject anything code-shaped.
      if (raw.length > 400 || /[;=`!?]|\/\*|\*\//.test(raw)) continue;
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text && TARGET_RE.test(text)) {
        findings.push({ file: relFile, line: lineAt(content, m.index! + 1), text });
      }
    }
  }

  // (b) Rendered dialog/tooltip attributes: title=, aria-label=, body=,
  // confirmLabel=. Covers both plain `attr="..."` and `attr={`...`}` /
  // `attr={'...'}` forms (template-literal interior is itself brace-stripped
  // via stripBraceExpressions so `${expr}` doesn't get matched as text).
  const ATTR_RE =
    /\b(title|aria-label|body|confirmLabel)=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g;
  for (const m of content.matchAll(ATTR_RE)) {
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    const text = stripBraceExpressions(raw);
    if (TARGET_RE.test(text)) {
      findings.push({ file: relFile, line: lineAt(content, m.index!), text: `${m[1]}="${raw}"` });
    }
  }

  // (c) log(level, source, message) calls — the message argument shown in
  // the Console panel. Only matches when the message is a direct literal
  // (covers every current call site; computed/ternary messages are rare and
  // none currently contain the target words).
  const LOG_RE = /\blog\(\s*'(?:info|warn|error)'\s*,\s*'[^']*'\s*,\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
  for (const m of content.matchAll(LOG_RE)) {
    const literal = m[1];
    const inner = stripBraceExpressions(literal.slice(1, -1));
    if (TARGET_RE.test(inner)) {
      findings.push({ file: relFile, line: lineAt(content, m.index!), text: literal });
    }
  }

  // (d) Workspace.tsx's PANEL_TITLES record — the dockview tab titles (and,
  // via Toolbar.tsx's `PANEL_TITLES[id]` lookup for the View menu section it
  // hands to buildAppMenu, the View-menu checkbox labels).
  if (relFile === 'workspace/Workspace.tsx') {
    const block = /export const PANEL_TITLES:[^{]*\{([\s\S]*?)\n\};/.exec(content);
    if (block) {
      const blockStart = block.index! + block[0].indexOf(block[1]);
      for (const m of block[1].matchAll(/(\w+):\s*'([^']*)'/g)) {
        if (TARGET_RE.test(m[2])) {
          findings.push({ file: relFile, line: lineAt(content, blockStart + m.index!), text: m[0] });
        }
      }
    }
  }

  return findings;
}

describe('editor copy sweep: no snapshot/diff/baseline jargon in rendered strings', () => {
  it('finds no un-allowlisted jargon in apps/editor/src/**/*.tsx', () => {
    const files = collectTsxFiles(SRC_DIR);
    const offenders: Finding[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const finding of findingsFor(file, content)) {
        const key = `${finding.file}:${finding.line}`;
        if (!ALLOWLIST.has(key)) offenders.push(finding);
      }
    }

    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `  ${o.file}:${o.line} → ${JSON.stringify(o.text)}`)
        .join('\n');
      expect.fail(
        `Found ${offenders.length} rendered string(s) with "snapshot"/"diff"/"baseline" jargon ` +
          `not on the allowlist:\n${report}\n\n` +
          `Rename per the plain-language table (Snapshot→Checkpoint, Diff→Review/Changes, ` +
          `baseline→checkpoint) or add a commented allowlist entry if it's a legitimate CLI/internal reference.`,
      );
    }
  });
});
