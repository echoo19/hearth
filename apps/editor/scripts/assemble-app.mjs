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
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appRoot, 'release-app');

const editorPkg = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));

// @lydell/node-pty ships no source — only prebuilt native binaries — so it's
// the one runtime dependency the packaged app needs installed for real
// (everything else is inlined by esbuild/vite into dist/dist-electron). Pin
// the exact version rather than the caret range from package.json: this
// directory has no lockfile of its own, and we want the platform-specific
// optionalDependencies subpackage npm resolves here to be reproducible.
const nodePtyRange = editorPkg.dependencies['@lydell/node-pty'];
const nodePtyVersion = nodePtyRange.replace(/^[\^~]/, '');

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
      author: {
        name: 'Hearth Engine Contributors',
        email: 'hearth@users.noreply.github.com',
      },
      homepage: 'https://github.com/echoo19/hearth',
      // electron-builder's update-info builder needs a detectable repository;
      // without it, local `electron-builder --publish never` runs crash in
      // cleanup (computeChannelNames on a null publish config). CI is
      // unaffected but local packaging + HEARTH_SMOKE hit it.
      repository: { type: 'git', url: 'https://github.com/echoo19/hearth.git' },
      license: 'MIT',
      main: 'dist-electron/main.cjs',
      dependencies: {
        '@lydell/node-pty': nodePtyVersion,
      },
    },
    null,
    2,
  ) + '\n',
);

// Install the one real dependency. `npm install` (not `ci`) because this
// directory intentionally has no lockfile; `--no-package-lock` keeps it that
// way so re-running assembly stays idempotent. npm resolves and installs the
// `@lydell/node-pty-<platform>-<arch>` optionalDependencies subpackage that
// matches whatever OS/arch this script runs on — exactly what each release CI
// runner (and a local packaging run) needs.
const npmInstallArgs = ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'];
console.log(`release-app/: npm install @lydell/node-pty@${nodePtyVersion}`);
// Node's CVE-2024-27980 hardening refuses to spawn a .cmd/.bat file directly
// on win32 (throws EINVAL) unless `shell: true` is set. `npmCmd()` resolves to
// `npm.cmd` on Windows, so opt into the shell there; args are static strings
// with no user input, so there's no injection surface.
const execOpts = { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' };
try {
  execFileSync(npmCmd(), npmInstallArgs, execOpts);
} catch (err) {
  // Some sandboxed/CI environments have an unwritable (or root-owned) global
  // npm cache; retry once against a scratch cache dir before giving up.
  console.warn(`npm install failed (${err.message}); retrying with a scratch --cache dir`);
  const scratchCache = path.join(os.tmpdir(), 'hearth-npm-cache');
  execFileSync(npmCmd(), [...npmInstallArgs, '--cache', scratchCache], execOpts);
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

console.log('release-app/ assembled');
