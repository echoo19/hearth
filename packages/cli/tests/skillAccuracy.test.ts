/**
 * Accuracy gate for the shipped Hearth best-practices skill
 * (`skills/hearth/SKILL.md`). Every `hearth <command> [--flags]` invocation in
 * the skill's bash blocks must resolve against the REAL commander program —
 * a fake command path or a flag that no command declares fails this test. This
 * keeps the agent-facing playbook from drifting out of sync with the CLI.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { buildProgram } from '../src/program.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills', 'hearth', 'SKILL.md');

// --- Model the real CLI surface from the commander program -----------------

interface CommandNode {
  /** Space-joined path, e.g. "create asset slice" (root is ""). */
  path: string;
  /** Long flags this command declares itself (e.g. "--frame-size"). */
  flags: Set<string>;
  /** Subcommand name/alias -> child. */
  children: Map<string, CommandNode>;
}

function longFlagsOf(cmd: Command): Set<string> {
  const flags = new Set<string>();
  for (const opt of cmd.options) {
    if (opt.long) flags.add(opt.long);
    if (opt.short) flags.add(opt.short);
  }
  flags.add('--help');
  flags.add('-h');
  return flags;
}

function walk(cmd: Command, prefix: string): CommandNode {
  const node: CommandNode = { path: prefix, flags: longFlagsOf(cmd), children: new Map() };
  for (const sub of cmd.commands) {
    // Skip the implicit `help` command commander adds.
    if (sub.name() === 'help') continue;
    const childPath = prefix ? `${prefix} ${sub.name()}` : sub.name();
    const child = walk(sub, childPath);
    node.children.set(sub.name(), child);
    for (const alias of sub.aliases()) node.children.set(alias, child);
  }
  return node;
}

const program = buildProgram();
const root = walk(program, '');
// Global options live on the root program and are inherited by every command.
const GLOBAL_FLAGS = root.flags;

// --- Extract `hearth ...` invocations from the skill's bash blocks ---------

/** Shell-ish tokenizer: split on whitespace, respecting '…' and "…" quotes. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

interface Invocation {
  line: string;
  tokens: string[];
}

function extractInvocations(markdown: string): Invocation[] {
  const out: Invocation[] = [];
  const lines = markdown.split('\n');
  let inBash = false;
  let pending = '';
  for (const raw of lines) {
    const fence = raw.trim();
    if (fence.startsWith('```')) {
      inBash = fence === '```bash';
      pending = '';
      continue;
    }
    if (!inBash) continue;
    // Join backslash-continued lines into one logical command.
    let line = pending + raw;
    if (/\\\s*$/.test(line)) {
      pending = line.replace(/\\\s*$/, ' ');
      continue;
    }
    pending = '';
    line = line.replace(/\s+#.*$/, '').trim(); // strip trailing comments
    if (!line.startsWith('hearth ') && line !== 'hearth') continue;
    const tokens = tokenize(line).slice(1); // drop the leading `hearth`
    out.push({ line: line, tokens });
  }
  return out;
}

/** Resolve a token list to the deepest matching command node. */
function resolve(tokens: string[]): CommandNode {
  let cur = root;
  for (const t of tokens) {
    if (t.startsWith('-')) continue; // a flag: does not descend
    const child = cur.children.get(t);
    if (child) cur = child;
    else break; // first positional arg: stop descending
  }
  return cur;
}

/** Return a list of problems for one invocation ([] means valid). */
function validate(inv: Invocation): string[] {
  const problems: string[] = [];
  const node = resolve(inv.tokens);
  // A bare group command (no leaf) with args means an unknown subcommand path.
  const firstPositional = inv.tokens.find((t) => !t.startsWith('-'));
  if (node === root && firstPositional) {
    return [`unknown command: "${firstPositional}"`];
  }
  for (const t of inv.tokens) {
    if (!t.startsWith('--')) continue;
    const flag = t.split('=')[0];
    if (flag === '--') continue;
    if (!node.flags.has(flag) && !GLOBAL_FLAGS.has(flag)) {
      problems.push(`"${node.path || '(root)'}" has no flag ${flag}`);
    }
  }
  return problems;
}

// --- Tests -----------------------------------------------------------------

const skill = readFileSync(SKILL_PATH, 'utf8');
const invocations = extractInvocations(skill);

describe('SKILL.md hearth invocations', () => {
  it('extracts a meaningful number of invocations', () => {
    expect(invocations.length).toBeGreaterThan(30);
  });

  it('every command path resolves to a real command', () => {
    const bad: string[] = [];
    for (const inv of invocations) {
      const firstPositional = inv.tokens.find((t) => !t.startsWith('-'));
      if (resolve(inv.tokens) === root && firstPositional) {
        bad.push(`${inv.line}  ->  unknown command "${firstPositional}"`);
      }
    }
    expect(bad, `unknown commands:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every flag exists on its resolved command', () => {
    const bad: string[] = [];
    for (const inv of invocations) {
      for (const problem of validate(inv)) bad.push(`${inv.line}  ->  ${problem}`);
    }
    expect(bad, `invalid flags:\n${bad.join('\n')}`).toEqual([]);
  });
});

// Red-green: the validator must actually reject bad input, or the tests above
// prove nothing.
describe('the accuracy validator catches drift', () => {
  it('rejects a made-up flag', () => {
    const inv = { line: 'export web --frobnicate', tokens: ['export', 'web', '--frobnicate'] };
    expect(validate(inv)).not.toEqual([]);
  });

  it('rejects a made-up command', () => {
    const inv = { line: 'teleport player', tokens: ['teleport', 'player'] };
    expect(validate(inv)).not.toEqual([]);
  });

  it('accepts a real command with a real flag', () => {
    const inv = { line: 'export web --zip', tokens: ['export', 'web', '--zip'] };
    expect(validate(inv)).toEqual([]);
  });

  it('accepts a real command with a real global flag', () => {
    const inv = { line: 'validate --json', tokens: ['validate', '--json'] };
    expect(validate(inv)).toEqual([]);
  });
});
