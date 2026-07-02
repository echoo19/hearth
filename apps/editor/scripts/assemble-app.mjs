#!/usr/bin/env node
/**
 * Assemble the standalone app directory for electron-builder.
 *
 * We use electron-builder's "two package.json structure": release-app/
 * contains only the built UI (dist/), the bundled main process
 * (dist-electron/), and a minimal package.json with zero dependencies —
 * everything is already inlined by esbuild/vite, so the packaged app never
 * touches the monorepo's workspace-symlinked node_modules.
 */
import { rm, mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appRoot, 'release-app');

const editorPkg = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(path.join(appRoot, 'dist'), path.join(out, 'dist'), { recursive: true });
await cp(path.join(appRoot, 'dist-electron'), path.join(out, 'dist-electron'), { recursive: true });
await writeFile(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'hearth-editor',
      productName: 'Hearth',
      version: editorPkg.version,
      description: 'Hearth — an open-source, agent-native 2D game engine and editor',
      author: 'Hearth Engine Contributors',
      license: 'MIT',
      main: 'dist-electron/main.cjs',
    },
    null,
    2,
  ) + '\n',
);

console.log('release-app/ assembled');
