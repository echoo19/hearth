import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Alias workspace packages to their TypeScript sources so tests run
// without a prior build step.
const pkg = (name: string) =>
  path.resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@hearth/core/node': path.resolve(__dirname, 'packages/core/src/node/index.ts'),
      '@hearth/core': pkg('core'),
      '@hearth/runtime/pixi': path.resolve(__dirname, 'packages/runtime/src/pixi/index.ts'),
      // Pure screen-space UI math (anchor/offset/layout resolution), imported
      // directly by the editor's Scene view so it never drags the heavy
      // runtime barrel into the eager bundle — see apps/editor/vite.config.ts.
      '@hearth/runtime/ui': path.resolve(__dirname, 'packages/runtime/src/ui.ts'),
      '@hearth/runtime': pkg('runtime'),
      '@hearth/playtest': pkg('playtest'),
    },
  },
  test: {
    include: [
      'packages/*/tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/tests/**/*.test.{ts,tsx}',
    ],
    environment: 'node',
    testTimeout: 30000,
  },
});
