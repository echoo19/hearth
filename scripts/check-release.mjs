#!/usr/bin/env node
/**
 * Verify that every release-facing engine surface agrees with package.json.
 */
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSTANTS = [
  ['packages/core/src/schema/project.ts', 'HEARTH_VERSION'],
  ['packages/cli/src/program.ts', 'VERSION'],
  ['packages/mcp-server/src/server.ts', 'SERVER_VERSION'],
];

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== '--tag' && option !== '--website') {
      throw new Error(`unknown option ${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${option} requires a value`);
    }
    options[option.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function workspacePaths(repoRoot, patterns) {
  const found = new Set();
  for (const pattern of patterns) {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized.endsWith('/*')) {
      found.add(normalized);
      continue;
    }
    const parent = normalized.slice(0, -2);
    const entries = await readdir(path.join(repoRoot, parent), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) found.add(`${parent}/${entry.name}`);
    }
  }
  return [...found].sort();
}

function versionMismatch(surface, actual, expected) {
  return `${surface} ${String(actual)}; canonical version ${expected}`;
}

export async function runWebsiteCheck(
  websitePath,
  enginePath,
  version,
  runner = spawnSync,
) {
  const result = runner(
    'npm',
    ['run', 'release:check', '--', '--engine', path.resolve(enginePath), '--version', version],
    { cwd: path.resolve(websitePath), stdio: 'inherit' },
  );
  if (result.error) {
    return `website release check failed in ${path.resolve(websitePath)}: ${result.error.message}`;
  }
  if (result.status !== 0) {
    return `website release check failed in ${path.resolve(websitePath)} (exit ${String(result.status)})`;
  }
  return undefined;
}

export async function collectReleaseErrors(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const errors = [];
  const rootPackage = await readJson(path.join(root, 'package.json'));
  const version = rootPackage.version;
  const workspaces = await workspacePaths(root, rootPackage.workspaces ?? []);
  const workspacePackages = [];

  for (const workspace of workspaces) {
    const packageFile = path.join(root, workspace, 'package.json');
    try {
      const pkg = await readJson(packageFile);
      workspacePackages.push(workspace);
      if (pkg.version !== version) {
        errors.push(versionMismatch(`${workspace}/package.json`, pkg.version, version));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  try {
    const lock = await readJson(path.join(root, 'package-lock.json'));
    if (lock.version !== version) {
      errors.push(versionMismatch('package-lock.json top-level version', lock.version, version));
    }
    for (const workspace of ['', ...workspacePackages]) {
      const record = lock.packages?.[workspace];
      const label = `package-lock.json packages[${JSON.stringify(workspace)}]`;
      if (!record) {
        errors.push(`package-lock.json is missing packages[${JSON.stringify(workspace)}]`);
      } else if (record.version !== version) {
        errors.push(versionMismatch(label, record.version, version));
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    errors.push('missing package-lock.json');
  }

  for (const [relative, name] of CONSTANTS) {
    const source = await readFile(path.join(root, relative), 'utf8');
    const declaration = source.match(
      new RegExp(`\\b(?:export\\s+)?const\\s+${name}\\s*=\\s*'([^']+)'\\s*;`),
    );
    if (!declaration) {
      errors.push(`${relative} must declare the exact single-quoted ${name}`);
    } else if (declaration[1] !== version) {
      errors.push(versionMismatch(relative, declaration[1], version));
    }
  }

  const claim = `v${version}`;
  for (const relative of ['README.md', 'CONTRIBUTING.md']) {
    const content = await readFile(path.join(root, relative), 'utf8');
    if (!content.includes(claim)) errors.push(`${relative} must claim ${claim}`);
  }
  const roadmap = await readFile(path.join(root, 'docs/roadmap.md'), 'utf8');
  if (!roadmap.split(/\r?\n/).slice(0, 10).join('\n').includes(claim)) {
    errors.push(`first 10 lines of docs/roadmap.md must claim ${claim}`);
  }

  const notes = `docs/releases/${claim}.md`;
  try {
    if (!(await readFile(path.join(root, notes), 'utf8')).trim()) {
      errors.push(`${notes} is empty`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    errors.push(`missing ${notes}`);
  }

  if (options.tag && options.tag !== claim) {
    errors.push(`tag ${options.tag} does not match canonical version; expected ${claim}`);
  }
  if (options.website) {
    const website = path.isAbsolute(options.website)
      ? options.website
      : path.resolve(root, options.website);
    const websiteError = await runWebsiteCheck(
      website,
      root,
      version,
      options.runner,
    );
    if (websiteError) errors.push(websiteError);
  }

  return errors;
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const options = parseArgs(process.argv.slice(2));
    const errors = await collectReleaseErrors(repoRoot, options);
    if (errors.length) {
      for (const error of errors) console.error(`release check: ${error}`);
      process.exitCode = 1;
      return;
    }
    const { version } = await readJson(path.join(repoRoot, 'package.json'));
    console.log(`release check: v${version} coherent`);
  } catch (error) {
    console.error(`release check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
