/**
 * What the desktop app's single CommonJS bundle does to a module that needs to
 * know where it is, and what that cost a real person.
 *
 * The app ships as one file: esbuild inlines the project server and every
 * workspace package it reaches into `dist-electron/main.cjs`. CommonJS has no
 * `import.meta`, so esbuild replaces it with an empty object and warns, and
 * every `import.meta.url` in the bundle then reads `undefined`. Several of the
 * inlined modules use exactly that to find files shipped beside them, so each
 * of those reads became `fileURLToPath(undefined)`, which throws.
 *
 * `@hearth/adapter-web` did it at module scope, which turned "cannot locate
 * my own shim" into "cannot be imported". The private tester opens the game
 * through a dynamic import of that package, so pressing Play on a game that
 * ran perfectly produced a session that died nine milliseconds in and a note
 * whose entire verdict read `The "path" argument must be of type string or an
 * instance of URL. Received undefined`.
 *
 * Two things stop that, and this file holds one test for each: the bundle now
 * carries a real module URL, and the adapter no longer treats not knowing
 * where it lives as fatal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from 'esbuild';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CJS_IMPORT_META } from '../scripts/cjsImportMeta.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * The workspace packages by source path, the way the real Electron build
 * reaches them (it resolves them through the editor's own tsconfig paths).
 * Aliased explicitly here so this test never depends on those packages having
 * been built into `dist/` first.
 */
const workspaceAliases = {
  '@hearth/adapter-web': path.join(repoRoot, 'packages/adapter-web/src/index.ts'),
  '@hearth/probe-core': path.join(repoRoot, 'packages/probe-core/src/index.ts'),
};

let tmpDir: string;
const requireFromHere = createRequire(import.meta.url);

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-cjs-bundle-'));
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

interface Bundled {
  /** What requiring the bundle produced. */
  exports: Record<string, unknown>;
  /** Where the bundle was written, which is the module url it should claim. */
  outfile: string;
}

/**
 * Bundle one throwaway module the way the app bundles its main process, and
 * hand back whatever requiring the result gives.
 *
 * `shim` is the switch this whole file is about: false reproduces the bundle
 * the tester died in, true is what the build ships now.
 */
async function bundleAndRequire(name: string, source: string, shim: boolean): Promise<Bundled> {
  const entry = path.join(tmpDir, `${name}.ts`);
  const outfile = path.join(tmpDir, `${name}.cjs`);
  await fsp.writeFile(entry, source, 'utf8');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // Same reason the real build keeps it out: the adapter only ever reaches
    // playwright through a dynamic import inside launchChromium(), which no
    // test here calls.
    external: ['playwright-core'],
    alias: workspaceAliases,
    logLevel: 'silent',
    ...(shim ? CJS_IMPORT_META : {}),
  });
  return { exports: requireFromHere(outfile) as Record<string, unknown>, outfile };
}

/** Ask a bundled entry for the adapter it dynamically imports. */
async function loadAdapter(bundled: Bundled): Promise<Record<string, unknown>> {
  const load = bundled.exports.load as () => Promise<Record<string, unknown>>;
  return load();
}

describe('the module url inside the desktop app bundle', () => {
  it('is nothing at all unless the build puts one there, which is the whole fault', async () => {
    const bundled = await bundleAndRequire('bare', 'export const seen: unknown = import.meta.url;\n', false);
    // Pinned deliberately: this is the state the tester crashed in, and an
    // esbuild that one day started supplying something here would make the
    // shim redundant rather than wrong.
    expect(bundled.exports.seen).toBeUndefined();
  });

  it('is the bundle it was compiled into once the build supplies it', async () => {
    const bundled = await bundleAndRequire('shimmed', 'export const seen: unknown = import.meta.url;\n', true);
    const seen = bundled.exports.seen;
    // A string first, and separately, so that a shim which supplied nothing
    // fails here saying so rather than inside the path conversion below.
    expect(typeof seen).toBe('string');
    // Both sides go through realpath, and BOTH is the point. Comparing a URL
    // built here against one the shim built from `__filename` compares two
    // spellings of one file, and every platform has its own way of spelling it
    // twice: macOS hands back /var/... and /private/var/..., and Windows hands
    // back the short 8.3 name from the temp dir it was given and the long name
    // from everywhere else, so this read RUNNER~1 against runneradmin on CI
    // while the product code was perfectly correct. Resolving each side to the
    // real file asks the question actually worth asking, which is whether the
    // bundle named itself, not how the name was spelled.
    expect(await fsp.realpath(fileURLToPath(seen as string))).toBe(await fsp.realpath(bundled.outfile));
  });

  it('does not cost the bundle its strict mode on the way in', async () => {
    // A `"use strict"` is only a directive while nothing precedes it, and
    // esbuild puts the bundle's own one on the first line. Prepending a banner
    // without repeating it would demote that line to an ordinary string and
    // run the whole main process sloppy, where an assignment to an undeclared
    // name silently becomes a global rather than throwing. `this` inside a
    // plainly called function is the cheapest way to ask which mode won.
    const bundled = await bundleAndRequire(
      'strictness',
      'export const strict = (function () { return this === undefined; })();\n',
      true,
    );
    expect(bundled.exports.strict).toBe(true);
  });
});

describe('the web adapter the tester opens games with', () => {
  it('can still be imported by a bundle that erased every module url, because that is what killed the session', async () => {
    const bundled = await bundleAndRequire('adapter', "export const load = () => import('@hearth/adapter-web');\n", false);
    // The import itself is the assertion: before the fix it rejected with
    // ERR_INVALID_ARG_TYPE while the adapter module was still evaluating, and
    // the tester reported that Node error as its verdict on somebody's game.
    const adapter = await loadAdapter(bundled);
    expect(typeof adapter.openWebGame).toBe('function');
    // And it says so plainly rather than guessing: a build that cannot locate
    // its own files has no reference shim to offer.
    expect(adapter.PROBE_SHIM_PATH).toBeNull();
  });

  it('knows where its reference shim is whenever anything told it where it lives', async () => {
    const bundled = await bundleAndRequire(
      'adapterShimmed',
      "export const load = () => import('@hearth/adapter-web');\n",
      true,
    );
    const adapter = await loadAdapter(bundled);
    expect(typeof adapter.PROBE_SHIM_PATH).toBe('string');
  });
});
