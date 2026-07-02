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
      { find: '@hearth/runtime', replacement: src('packages/runtime/src/index.ts') },
      { find: '@hearth/playtest', replacement: src('packages/playtest/src/index.ts') },
    ],
  },
  // The runtime package is developed in parallel and may not exist yet; it is
  // only dynamically imported behind a server-side availability check.
  // pixi.js is pre-bundled so its first use doesn't trigger a dev full-reload.
  optimizeDeps: {
    include: ['pixi.js'],
    exclude: ['@hearth/runtime', '@hearth/playtest'],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
});
