/**
 * The client may share the probe's SCHEMA, never its code.
 *
 * `@hearth/probe-core` is a Node package — it writes files and reads
 * directories — so a value import from anything under `src/` would drag
 * `node:fs` into the browser bundle. Types are fine, because they are erased;
 * values are not.
 *
 * Nothing under `src/` names the probe at all right now: playtesting is the
 * agent's business and runs out of process. The rule is kept because the next
 * surface that wants to show a probe run will reach for these types again, and
 * the failure is silent at authoring time and loud only at bundle time.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '../src');
const DIST_DIR = path.resolve(__dirname, '../dist');

/** Packages the client may name in types but must never pull code from. */
const NODE_ONLY_PACKAGES = ['@hearth/probe-core', '@hearth/adapter-web'];

function collect(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

describe('probe-core is a type-only dependency of the client', () => {
  it('every src/** import of a Node-only probe package is erasable', () => {
    const offenders: string[] = [];
    for (const file of collect(SRC_DIR, ['.ts', '.tsx'])) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pkg of NODE_ONLY_PACKAGES) {
        // Any import/export statement naming the package, type-only or not.
        const re = new RegExp(`(^|\\n)\\s*(import|export)([^;]*?)from\\s*['"]${pkg}['"]`, 'g');
        for (const match of content.matchAll(re)) {
          const statement = match[0].trim();
          const isTypeOnly = /^(import|export)\s+type\b/.test(statement);
          if (!isTypeOnly) offenders.push(`${path.relative(SRC_DIR, file)} → ${statement}`);
        }
        // A bare or dynamic import is a value import by definition.
        if (new RegExp(`import\\s*\\(\\s*['"]${pkg}['"]`).test(content)) {
          offenders.push(`${path.relative(SRC_DIR, file)} → dynamic import('${pkg}')`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no built client bundle carries probe-core code', () => {
    if (!fs.existsSync(DIST_DIR)) return; // nothing built yet; `npm run build` covers this
    for (const file of collect(DIST_DIR, ['.js'])) {
      const content = fs.readFileSync(file, 'utf8');
      // NodeEvidenceStore is probe-core's most distinctive runtime export.
      expect(content, `${path.relative(DIST_DIR, file)} carries probe-core code`).not.toMatch(/NodeEvidenceStore/);
    }
  });
});
