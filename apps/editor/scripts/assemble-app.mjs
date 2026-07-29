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
import { existsSync } from 'node:fs';
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

// playwright-core is the other dependency the packaged app really needs: the
// probe reaches Chromium through a lazy `import('playwright-core')`
// (packages/adapter-web/src/chromium.ts), and esbuild keeps it external — so
// without installing it here, Playtest works in dev and silently can't launch
// a browser in the shipped app. Pure JS, no postinstall, ~8 MB.
const playwrightRange =
  editorPkg.dependencies?.['playwright-core'] ?? editorPkg.optionalDependencies?.['playwright-core'];
const playwrightVersion = (playwrightRange ?? (await resolvePlaywrightVersion())).replace(/^[\^~]/, '');

async function resolvePlaywrightVersion() {
  // The version the workspace actually resolved (adapter-web's optional dep),
  // so the packaged app runs exactly what the tests ran.
  const pkg = JSON.parse(
    await readFile(path.join(appRoot, '..', '..', 'node_modules', 'playwright-core', 'package.json'), 'utf8'),
  );
  return pkg.version;
}

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
      description: 'Hearth — the app for agentic game development, with playtesting built in',
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
        'playwright-core': playwrightVersion,
      },
    },
    null,
    2,
  ) + '\n',
);

/**
 * Which platform the app being assembled is FOR, which is not always the one
 * this script is running on.
 *
 * @lydell/node-pty ships no source, only prebuilt binaries, one per platform,
 * as optionalDependencies. npm installs the subpackage matching the host, so
 * the release CI matrix (one runner per OS) has always been correct. A local
 * cross-build is not: `electron-builder --win` on a Mac produced a Windows app
 * carrying the darwin-arm64 pty binary and nothing else, so the terminal was
 * dead on arrival and no step said a word about it.
 *
 * npm's --os/--cpu answer exactly this question, so the target is passed down
 * rather than inferred, and the result is checked below rather than trusted.
 */
const targetPlatform = process.env.HEARTH_TARGET_PLATFORM ?? process.platform;
const targetArch = process.env.HEARTH_TARGET_ARCH ?? process.arch;
const crossBuilding = targetPlatform !== process.platform || targetArch !== process.arch;
if (crossBuilding) {
  console.log(`release-app/: assembling for ${targetPlatform}-${targetArch} from ${process.platform}-${process.arch}`);
}

// `npm install` (not `ci`) because this directory intentionally has no
// lockfile; `--no-package-lock` keeps it that way so re-running assembly stays
// idempotent.
const npmInstallArgs = [
  'install',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--no-package-lock',
  `--os=${targetPlatform}`,
  `--cpu=${targetArch}`,
];
console.log(`release-app/: npm install @lydell/node-pty@${nodePtyVersion} playwright-core@${playwrightVersion}`);
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

/**
 * The pty binary for the target really is here.
 *
 * Checked rather than assumed, because the failure it catches is silent: the
 * install succeeds, the package is packed, the app launches, and the terminal
 * is simply dead the first time someone opens it. On a machine that is not the
 * one that built it, nobody finds out until a user does.
 */
const ptyPrebuild = path.join(
  out,
  'node_modules',
  '@lydell',
  `node-pty-${targetPlatform}-${targetArch}`,
  'prebuilds',
  `${targetPlatform}-${targetArch}`,
);
if (!existsSync(ptyPrebuild)) {
  console.error(
    `\nrelease-app/: no pty binary for ${targetPlatform}-${targetArch}.\n` +
      `Looked in ${ptyPrebuild}.\n` +
      'The app would package and launch with a terminal that cannot start.\n' +
      (crossBuilding
        ? 'Cross-builds need npm to resolve the target platform, which needs npm 10 or newer for --os and --cpu.\n'
        : ''),
  );
  process.exit(1);
}

console.log(`release-app/ assembled (pty: ${targetPlatform}-${targetArch})`);
