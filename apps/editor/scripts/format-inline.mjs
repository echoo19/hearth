/**
 * esbuild inject shim: makes the standalone `hearth-cli.mjs` / `hearth-mcp.mjs`
 * bundles able to reformat scripts (`hearth script format`, or edit_script's
 * format-on-save) with NO node_modules present.
 *
 * @hearth/core's format.ts deliberately loads StyLua and Prettier through
 * NON-LITERAL dynamic `import(...)` specifiers so neither vite nor esbuild
 * statically resolves/bundles them — which keeps the browser bundles clean,
 * but also means these Node-only single-file tools ship WITHOUT the
 * formatters. That runtime `import()` would just fail against an empty
 * node_modules.
 *
 * So, mirroring lua-wasm-inline.mjs, we bundle the formatters in HERE (a
 * statically-imported inject file esbuild DOES follow) and hand them to
 * format.ts via setFormatterModules before any command runs:
 *   - StyLua's wasm-bindgen "web" build, initialised synchronously from the
 *     wasm bytes esbuild inlines as base64 (loader '.wasm': 'base64').
 *   - Prettier standalone + the babel/estree plugins (pure JS, bundled
 *     directly).
 * Inject files run before entry code, so the override is in place before the
 * first format call. Best-effort: if wasm init throws, we leave format.ts's
 * default dynamic-import path alone.
 */
import * as stylua from '@johnnymorganz/stylua/web';
import styluaWasmBase64 from '@johnnymorganz/stylua/stylua_lib_bg.wasm';
import * as prettierStandalone from 'prettier/standalone';
import * as prettierBabel from 'prettier/plugins/babel';
import * as prettierEstree from 'prettier/plugins/estree';
import { setFormatterModules } from '@hearth/core';

try {
  const wasmModule = new WebAssembly.Module(Buffer.from(styluaWasmBase64, 'base64'));
  stylua.initSync({ module: wasmModule });
  setFormatterModules({
    stylua,
    prettier: {
      format: prettierStandalone.format,
      babel: prettierBabel,
      estree: prettierEstree,
    },
  });
} catch {
  // Best-effort: without the override, format-on-save reports a clear
  // formatter-load error while every other command keeps working.
}
