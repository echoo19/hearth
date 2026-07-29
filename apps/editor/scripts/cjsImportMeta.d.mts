/**
 * Types for the CommonJS `import.meta.url` shim.
 *
 * The shim itself has to stay plain JavaScript: `scripts/build-electron.mjs`
 * is run by bare `node`, which cannot load TypeScript. It is declared here so
 * the regression test that proves the shim works can import the very object
 * the build passes to esbuild, rather than a copy of it that could drift into
 * agreeing with a build that had stopped doing this.
 */
export declare const CJS_IMPORT_META: {
  readonly define: Readonly<Record<string, string>>;
  readonly banner: { readonly js: string };
};
