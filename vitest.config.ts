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
      '@hearth/probe-core': pkg('probe-core'),
      '@hearth/adapter-web': pkg('adapter-web'),
    },
  },
  test: {
    include: [
      'packages/*/tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/tests/**/*.test.{ts,tsx}',
    ],
    environment: 'node',
    /**
     * Generous, because the slowest tests here are not slow by accident: the
     * CLI suite shells out to a real binary per case and the examples suite
     * runs whole playtests. On a developer's machine those land around ten
     * seconds; on the Windows CI runner the same cases measured 30.8s, 30.5s
     * and 38.6s against a 30s ceiling, so the release build failed on the
     * clock rather than on anything being wrong.
     *
     * Raising a timeout is usually how a real hang gets hidden, so the number
     * is deliberate rather than doubled-until-green: 120s is far past any
     * healthy case and still fails a genuine deadlock in reasonable time.
     */
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
