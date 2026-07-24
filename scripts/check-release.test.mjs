import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectReleaseErrors,
  parseArgs,
  runWebsiteCheck,
} from './check-release.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const temporaryRoots = [];

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearth-release-check-'));
  temporaryRoots.push(root);

  const workspaces = {
    'apps/editor': '@hearth/editor',
    'packages/cli': '@hearth/cli',
    'packages/core': '@hearth/core',
    'packages/mcp-server': '@hearth/mcp-server',
  };
  await writeJson(path.join(root, 'package.json'), {
    name: 'hearth-monorepo',
    version: '1.2.1',
    workspaces: ['packages/*', 'apps/*'],
  });
  for (const [relative, name] of Object.entries(workspaces)) {
    await writeJson(path.join(root, relative, 'package.json'), { name, version: '1.2.1' });
  }
  await writeJson(path.join(root, 'package-lock.json'), {
    name: 'hearth-monorepo',
    version: '1.2.1',
    lockfileVersion: 3,
    packages: {
      '': { name: 'hearth-monorepo', version: '1.2.1' },
      ...Object.fromEntries(
        Object.entries(workspaces).map(([relative, name]) => [
          relative,
          { name, version: '1.2.1' },
        ]),
      ),
    },
  });

  await Promise.all([
    mkdir(path.join(root, 'packages/core/src/schema'), { recursive: true }),
    mkdir(path.join(root, 'packages/cli/src'), { recursive: true }),
    mkdir(path.join(root, 'packages/mcp-server/src'), { recursive: true }),
    mkdir(path.join(root, 'docs/releases'), { recursive: true }),
  ]);
  await writeFile(
    path.join(root, 'packages/core/src/schema/project.ts'),
    "export const HEARTH_VERSION = '1.2.1';\n",
  );
  await writeFile(
    path.join(root, 'packages/cli/src/program.ts'),
    "const VERSION = '1.2.1';\n",
  );
  await writeFile(
    path.join(root, 'packages/mcp-server/src/server.ts'),
    "const SERVER_VERSION = '1.2.1';\n",
  );
  await writeFile(path.join(root, 'README.md'), 'Current release: **v1.2.1**.\n');
  await writeFile(path.join(root, 'CONTRIBUTING.md'), 'Hearth is at v1.2.1.\n');
  await writeFile(path.join(root, 'docs/roadmap.md'), '# Roadmap\n\nv1.2.1 is current.\n');
  await writeFile(path.join(root, 'docs/releases/v1.2.1.md'), '# Hearth v1.2.1\n\nNotes.\n');
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('parses optional tag and website paths', () => {
  assert.deepEqual(parseArgs(['--tag', 'v1.2.1', '--website', '../hearth-website']), {
    tag: 'v1.2.1',
    website: '../hearth-website',
  });
  assert.throws(() => parseArgs(['--tag']), /--tag requires a value/);
  assert.throws(() => parseArgs(['--wat']), /unknown option --wat/);
});

test('accepts a coherent release', async () => {
  const root = await makeFixture();
  assert.deepEqual(await collectReleaseErrors(root, { tag: 'v1.2.1' }), []);
});

test('reports workspace package version drift found through workspace globs', async () => {
  const root = await makeFixture();
  await writeJson(path.join(root, 'packages/core/package.json'), {
    name: '@hearth/core',
    version: '1.2.0',
  });

  const errors = await collectReleaseErrors(root);

  assert.match(
    errors.join('\n'),
    /packages\/core\/package\.json.*1\.2\.0.*canonical version 1\.2\.1/,
  );
});

test('reports root and workspace lockfile drift and missing records', async () => {
  const root = await makeFixture();
  const lockFile = path.join(root, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  lock.version = '1.2.0';
  lock.packages[''].version = '1.2.0';
  lock.packages['packages/core'].version = '1.2.0';
  delete lock.packages['apps/editor'];
  await writeJson(lockFile, lock);

  const errors = (await collectReleaseErrors(root)).join('\n');

  assert.match(errors, /package-lock\.json top-level version 1\.2\.0.*1\.2\.1/);
  assert.match(errors, /package-lock\.json packages\[""\].*1\.2\.0.*1\.2\.1/);
  assert.match(errors, /package-lock\.json packages\["packages\/core"\].*1\.2\.0.*1\.2\.1/);
  assert.match(errors, /package-lock\.json.*missing packages\["apps\/editor"\]/);
});

test('reports each runtime version constant when it drifts or loses its exact declaration', async () => {
  const root = await makeFixture();
  await writeFile(
    path.join(root, 'packages/core/src/schema/project.ts'),
    "export const HEARTH_VERSION = '1.2.0';\n",
  );
  await writeFile(
    path.join(root, 'packages/cli/src/program.ts'),
    'const VERSION = "1.2.1";\n',
  );
  await writeFile(
    path.join(root, 'packages/mcp-server/src/server.ts'),
    "const SERVER_VERSION = '1.2.0';\n",
  );

  const errors = (await collectReleaseErrors(root)).join('\n');

  assert.match(errors, /packages\/core\/src\/schema\/project\.ts.*1\.2\.0.*1\.2\.1/);
  assert.match(errors, /packages\/cli\/src\/program\.ts.*exact single-quoted VERSION/);
  assert.match(errors, /packages\/mcp-server\/src\/server\.ts.*1\.2\.0.*1\.2\.1/);
});

test('reports stale README, CONTRIBUTING, and top-of-roadmap release claims', async () => {
  const root = await makeFixture();
  await writeFile(path.join(root, 'README.md'), 'Current release: v1.2.0.\n');
  await writeFile(path.join(root, 'CONTRIBUTING.md'), 'Hearth is at v1.2.0.\n');
  await writeFile(
    path.join(root, 'docs/roadmap.md'),
    `${Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n')}\nv1.2.1\n`,
  );

  const errors = (await collectReleaseErrors(root)).join('\n');

  assert.match(errors, /README\.md.*v1\.2\.1/);
  assert.match(errors, /CONTRIBUTING\.md.*v1\.2\.1/);
  assert.match(errors, /first 10 lines of docs\/roadmap\.md.*v1\.2\.1/);
});

test('reports missing or empty release notes and a wrong tag', async () => {
  const root = await makeFixture();
  const notes = path.join(root, 'docs/releases/v1.2.1.md');
  await writeFile(notes, ' \n');

  let errors = (await collectReleaseErrors(root, { tag: 'v1.2.0' })).join('\n');
  assert.match(errors, /docs\/releases\/v1\.2\.1\.md.*empty/);
  assert.match(errors, /tag v1\.2\.0.*expected v1\.2\.1/);

  await rm(notes);
  errors = (await collectReleaseErrors(root)).join('\n');
  assert.match(errors, /missing docs\/releases\/v1\.2\.1\.md/);
});

test('delegates website validation with the exact engine path and unprefixed version', async () => {
  const root = await makeFixture();
  const website = path.join(root, '..', 'website-fixture');
  const calls = [];
  const runner = (...args) => {
    calls.push(args);
    return { status: 0 };
  };

  assert.deepEqual(await collectReleaseErrors(root, { website, runner }), []);
  assert.deepEqual(calls, [[
    'npm',
    ['run', 'release:check', '--', '--engine', path.resolve(root), '--version', '1.2.1'],
    { cwd: path.resolve(website), stdio: 'inherit' },
  ]]);
});

test('turns website command failures into an actionable release error', async () => {
  const root = await makeFixture();
  const website = path.join(root, '..', 'website-fixture');
  const errors = await collectReleaseErrors(root, {
    website,
    runner: () => ({ status: 7 }),
  });

  assert.match(errors.join('\n'), /website release check failed.*website-fixture.*exit 7/);
  assert.match(
    await runWebsiteCheck(website, root, '1.2.1', () => ({ error: new Error('spawn broke') })),
    /spawn broke/,
  );
});

test('the CLI prints an exact success line and actionable prefixed errors', async () => {
  const root = await makeFixture();
  await cp(path.join(here, 'check-release.mjs'), path.join(root, 'scripts/check-release.mjs'));

  let result = spawnSync(process.execPath, ['scripts/check-release.mjs', '--tag', 'v1.2.1'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'release check: v1.2.1 coherent\n');

  await writeFile(path.join(root, 'README.md'), 'Current release: v1.2.0.\n');
  result = spawnSync(process.execPath, ['scripts/check-release.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^release check: README\.md/m);
});

test('package scripts expose the focused release checks', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:release'], 'node scripts/check-release.mjs');
  assert.equal(pkg.scripts['test:release'], 'node --test scripts/check-release.test.mjs');
});
