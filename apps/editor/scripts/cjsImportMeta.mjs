/**
 * The `import.meta.url` a CommonJS bundle would otherwise not have.
 *
 * esbuild cannot honour `import.meta` when it is asked for CommonJS output.
 * It substitutes an empty object and warns, which means every `import.meta.url`
 * in the bundle reads `undefined` at runtime. That is not a cosmetic loss: the
 * modules the Electron main bundle inlines use it to find files that ship
 * beside them, and each of those reads is `fileURLToPath(undefined)`, which
 * throws `The "path" argument must be of type string or an instance of URL.
 * Received undefined`.
 *
 * That error is what the private tester reported instead of a verdict. The
 * tester opens the game through a dynamic `import('@hearth/adapter-web')`, the
 * adapter located its reference shim relative to itself at module scope, and
 * the whole module therefore threw while it was still being evaluated. The
 * session died nine milliseconds in, on a game that ran perfectly, and told
 * the user a Node type error. `@hearth/templates` and `@hearth/core/node`
 * locate the starter templates and the web player the same way, so the same
 * error was waiting in the packaged app for anyone who made a game from a
 * template or exported one.
 *
 * The bundle is one file, so the honest answer to "where is this module" is
 * "where the bundle is", and that is a thing CommonJS always knows:
 * `__filename`. Defining the expression rather than patching each reader keeps
 * every one of them correct at once, including the ones inside third-party
 * dependencies that nobody here can edit.
 *
 * Only for `format: 'cjs'` builds. The ESM tool bundles get a real
 * `import.meta.url` from the runtime and must be left alone.
 *
 * The banner opens with its own `"use strict"` and that is not decoration. A
 * directive only counts as one when nothing precedes it, and esbuild emits the
 * bundle's `"use strict"` as its very first statement: anything prepended
 * demotes it to a string sitting on a line by itself, and the entire main
 * process would then run in sloppy mode, where a mistyped assignment quietly
 * makes a global instead of throwing. Saying it here keeps the file strict and
 * leaves esbuild's own copy as the harmless duplicate.
 */
export const CJS_IMPORT_META = {
  define: { 'import.meta.url': '__hearthImportMetaUrl' },
  banner: {
    js: '"use strict"; const __hearthImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
};
