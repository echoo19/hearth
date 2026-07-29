import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hearthProjectServer } from './server/projectServer';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const src = (rel: string) => path.resolve(repoRoot, rel);

// Workspace packages are aliased to their TypeScript sources so `npm run dev`
// needs no prior package build. Order matters: subpath aliases first.
export default defineConfig({
  // Cast: the monorepo hoists two vite majors (vitest pulls its own), which
  // makes the Plugin types nominally incompatible while being the same shape.
  plugins: [react(), hearthProjectServer({ repoRoot })] as unknown as PluginOption[],
  resolve: {
    alias: [
      { find: '@hearth/core/node', replacement: src('packages/core/src/node/index.ts') },
      { find: '@hearth/core', replacement: src('packages/core/src/index.ts') },
      { find: '@hearth/runtime/pixi', replacement: src('packages/runtime/src/pixi/index.ts') },
      // Direct subpath to the Lua engine module so the editor can point
      // wasmoon at its Vite-served glue.wasm (setLuaWasmUri) — same module
      // instance the runtime dynamically imports for .lua scripts.
      { find: '@hearth/runtime/lua', replacement: src('packages/runtime/src/lua.ts') },
      // Pure screen-space UI math (anchor/offset/layout resolution). The Scene
      // view imports it directly so placing UIElement entities never pulls the
      // heavy runtime barrel (SceneRuntime/Lua/pixi) into the eager main bundle
      // — same reasoning as particlePreview.ts's dynamic runtime import.
      { find: '@hearth/runtime/ui', replacement: src('packages/runtime/src/ui.ts') },
      { find: '@hearth/runtime', replacement: src('packages/runtime/src/index.ts') },
      { find: '@hearth/playtest', replacement: src('packages/playtest/src/index.ts') },
    ],
  },
  // Both packages are only ever dynamically imported behind a server-side
  // availability check, and may not be built yet.
  optimizeDeps: {
    exclude: ['@hearth/runtime', '@hearth/playtest'],
  },
  server: {
    // `allow` has to stay the repo: the aliases above import packages/* from
    // source, and Vite reaches them through /@fs/. What that costs is that every
    // file in the repo is reachable on the control-plane origin, and a user's
    // project frequently IS in the repo (packages/examples/*). The two settings
    // beside it are what pays that back, and the third piece is the /@fs/
    // document refusal in server/projectServer.ts.
    fs: {
      allow: [repoRoot],
      // Vite's default deny list (.env, keys, .git) plus Hearth's own secret
      // store: .hearth/app.json holds the saved Anthropic and OpenAI keys and
      // .hearth/chats holds every conversation. Nothing in the editor's module
      // graph imports out of a project's .hearth, so this costs dev nothing.
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.hearth/**'],
    },
    // Vite's dev CORS defaults to echoing ANY loopback Origin, which includes
    // the game's own port. That let agent-written game code `fetch()` any repo
    // file off this origin and READ the reply, no popup and no navigation
    // needed. The editor page is same-origin with this server and needs no CORS
    // at all; the game is served its files by server/gameServer.ts, which is
    // the only mount that is supposed to hand a game anything.
    cors: false,
  },
});
