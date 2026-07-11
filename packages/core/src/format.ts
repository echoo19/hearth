/**
 * formatSource: fixed Hearth style formatting for scripts.
 *
 * Lua goes through StyLua's WASM build, JS through Prettier standalone,
 * both with Hearth's fixed style (no `.stylua.toml`/`.prettierrc` — one
 * consistent look for every project). Only two languages are gated here;
 * callers (Task 2's formatOnSave hook, Task 8's format command) already
 * know a script's language from its file extension and never call this
 * with anything else.
 *
 * Browser-safety: this module (via the core barrel, `index.ts`) is reachable
 * from every bundle that pulls in `@hearth/core` — the editor's Vite client
 * bundle AND the runtime package's esbuild web-player bundle — but formatting
 * only ever runs server-side (editor commands execute in Node). Both
 * formatter libraries are heavy (WASM, parser plugins) so they must load
 * ONLY via `await import(...)`, never a static `import`.
 *
 * That alone isn't enough, though: esbuild and Rollup both still resolve a
 * dynamic `import('literal-string')` at bundle time (to split it into its
 * own chunk) — and StyLua's default/bundler entry uses the WASM "ESM
 * integration proposal" (`import * as wasm from "./x.wasm"`), which neither
 * bundler can parse at all, so a literal specifier breaks those builds
 * outright even though the browser bundle never calls formatSource. Routing
 * the specifier through a `const` (computed, not a literal the bundler can
 * follow) makes both bundlers leave the `import()` call alone as an
 * unresolved runtime import — exactly what we want, since it only ever
 * actually executes in Node. Each dynamic import is memoized so repeated
 * calls don't re-import.
 */

// Type-only: erased at compile time, so this never pulls prettier into the
// browser bundle the way a value import would.
import type { Plugin } from 'prettier';

export interface FormatResult {
  formatted: string;
  changed: boolean;
}

/** Wraps an underlying formatter failure (stylua panic string, prettier SyntaxError, etc). */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

type StyluaModule = typeof import('@johnnymorganz/stylua');

const STYLUA_SPECIFIER = '@johnnymorganz/stylua';

/**
 * Standalone-bundle escape hatch. The single-file `hearth-cli.mjs` /
 * `hearth-mcp.mjs` esbuild bundles ship with NO node_modules, so the runtime
 * `import(...)` below would fail there. Their build injects a shim that
 * pre-resolves the formatter libraries (stylua's WASM initialised from
 * embedded bytes, prettier standalone + plugins bundled in) and hands them
 * here via `setFormatterModules`. Dev / editor-server / npm-installed
 * contexts never call this, so they keep using ordinary Node resolution.
 */
let styluaOverride: StyluaModule | undefined;
let prettierOverride: PrettierModules | undefined;
export function setFormatterModules(mods: { stylua?: StyluaModule; prettier?: PrettierModules }): void {
  if (mods.stylua) styluaOverride = mods.stylua;
  if (mods.prettier) prettierOverride = mods.prettier;
}

let styluaModule: Promise<StyluaModule> | undefined;
function loadStylua(): Promise<StyluaModule> {
  if (styluaOverride) return Promise.resolve(styluaOverride);
  styluaModule ??= import(STYLUA_SPECIFIER) as Promise<StyluaModule>;
  return styluaModule;
}

type PrettierStandalone = typeof import('prettier/standalone');
interface PrettierModules {
  format: PrettierStandalone['format'];
  babel: Plugin;
  estree: Plugin;
}

const PRETTIER_STANDALONE_SPECIFIER = 'prettier/standalone';
const PRETTIER_BABEL_SPECIFIER = 'prettier/plugins/babel';
const PRETTIER_ESTREE_SPECIFIER = 'prettier/plugins/estree';

let prettierModules: Promise<PrettierModules> | undefined;
function loadPrettier(): Promise<PrettierModules> {
  if (prettierOverride) return Promise.resolve(prettierOverride);
  prettierModules ??= Promise.all([
    import(PRETTIER_STANDALONE_SPECIFIER) as Promise<PrettierStandalone>,
    // Import the plugin modules as namespaces (not their default export):
    // prettier's published .d.ts for these subpaths doesn't declare a
    // `default` export even though the runtime .mjs does, so typing
    // against `.default` fails under NodeNext. The namespace object
    // itself carries `parsers`/`printers` at the top level, which is all
    // the `Plugin` interface needs.
    import(PRETTIER_BABEL_SPECIFIER) as Promise<Plugin>,
    import(PRETTIER_ESTREE_SPECIFIER) as Promise<Plugin>,
  ]).then(([standalone, babel, estree]) => ({
    format: standalone.format,
    babel: babel as Plugin,
    estree: estree as Plugin,
  }));
  return prettierModules;
}

/** Normalize a caught formatter failure to a plain string message (stylua can throw a bare string, not an Error). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

async function formatLua(source: string): Promise<string> {
  const { Config, IndentType, OutputVerification, formatCode } = await loadStylua();
  const config = Config.new();
  config.indent_type = IndentType.Spaces;
  config.indent_width = 2;
  config.column_width = 100;
  try {
    return formatCode(source, config, undefined, OutputVerification.None);
  } catch (err) {
    throw new FormatError(errorMessage(err));
  }
}

async function formatJs(source: string): Promise<string> {
  const { format, babel, estree } = await loadPrettier();
  try {
    return await format(source, { parser: 'babel', plugins: [babel, estree] });
  } catch (err) {
    throw new FormatError(errorMessage(err));
  }
}

/** Format `source` in Hearth's fixed style for `language`. Throws {@link FormatError} on unformattable source. */
export async function formatSource(language: 'lua' | 'js', source: string): Promise<FormatResult> {
  const formatted = language === 'lua' ? await formatLua(source) : await formatJs(source);
  return { formatted, changed: formatted !== source };
}
