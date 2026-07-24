# Engine Release Coherence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Hearth engine release fail early unless its packages, runtime constants, prose, notes, tag, and prepared website all describe the same version.

**Architecture:** A dependency-free Node checker owns the engine release contract and exposes a small importable API for fixture tests plus a CLI for CI and maintainers. Public CI runs engine-only validation; the optional `--website` path delegates the private-site half to the website's own release checker without moving private credentials into this repository.

**Tech Stack:** Node.js 20+ standard library, npm workspaces, Node test runner, GitHub Actions.

---

## File map

- `scripts/check-release.mjs` — derives and validates the release version across engine surfaces and optionally delegates to the website checker.
- `scripts/check-release.test.mjs` — isolated filesystem fixtures for version, tag, notes, lockfile, and website-delegation failures.
- `package.json` — canonical `check:release` and focused test commands.
- `docs/releases/v1.2.1.md` — versioned release body consumed by GitHub Actions.
- `.github/workflows/ci.yml` — runs the release contract on every change.
- `.github/workflows/release.yml` — validates the pushed tag and reads its notes file.
- `apps/editor/scripts/smoke-tools.mjs` — requires exact bundled CLI and MCP versions.
- `docs/releasing.md` — maintainer sequence across the public engine and private website.
- `CONTRIBUTING.md` — links maintainers to the canonical release sequence.

### Task 1: Build the engine release checker test-first

**Files:**
- Create: `scripts/check-release.test.mjs`
- Create: `scripts/check-release.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write fixture tests for a coherent release and each drift class**

Use `node:test`, `node:assert/strict`, `mkdtemp`, and `writeFile` to create a
minimal repository containing a root package, one workspace package, matching
lockfile records, the three runtime constants, the three prose claims, and a
versioned release note. Import:

```js
import { collectReleaseErrors, parseArgs } from './check-release.mjs';
```

Cover these separate behaviors:

```js
test('accepts a coherent release', async () => {
  assert.deepEqual(await collectReleaseErrors(root, { tag: 'v1.2.1' }), []);
});

test('reports workspace and lockfile version drift', async () => {
  await writeJson(join(root, 'packages/core/package.json'), { name: '@hearth/core', version: '1.2.0' });
  const errors = await collectReleaseErrors(root);
  assert.match(errors.join('\n'), /packages\/core\/package\.json.*1\.2\.0.*1\.2\.1/);
});

test('reports runtime constant drift', async () => {
  await writeFile(join(root, 'packages/cli/src/program.ts'), "const VERSION = '1.2.0';\n");
  assert.match((await collectReleaseErrors(root)).join('\n'), /packages\/cli\/src\/program\.ts/);
});

test('reports missing notes and wrong tags', async () => {
  await rm(join(root, 'docs/releases/v1.2.1.md'));
  const errors = await collectReleaseErrors(root, { tag: 'v1.2.0' });
  assert.match(errors.join('\n'), /docs\/releases\/v1\.2\.1\.md/);
  assert.match(errors.join('\n'), /tag v1\.2\.0.*v1\.2\.1/);
});

test('parses optional tag and website paths', () => {
  assert.deepEqual(parseArgs(['--tag', 'v1.2.1', '--website', '../hearth-website']), {
    tag: 'v1.2.1',
    website: '../hearth-website',
  });
});
```

Add a website-delegation test using an injected runner that records the command
instead of spawning a real process. Assert it receives the absolute engine path
and unprefixed version `1.2.1`, and that a non-zero website result becomes an
actionable engine error.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/check-release.test.mjs
```

Expected: FAIL because `scripts/check-release.mjs` does not exist.

- [ ] **Step 3: Implement the smallest dependency-free checker**

Export:

```js
export function parseArgs(argv) {}
export async function collectReleaseErrors(repoRoot, options = {}) {}
export async function runWebsiteCheck(websitePath, enginePath, version, runner) {}
```

Implementation requirements:

- read the root version from `package.json`;
- expand the root workspace patterns ending in `/*` with `readdir`;
- compare every discovered workspace `package.json` version;
- compare the root and workspace entries under `package-lock.json.packages`;
- match exact single-quoted constants in:
  - `packages/core/src/schema/project.ts` → `HEARTH_VERSION`;
  - `packages/cli/src/program.ts` → `VERSION`;
  - `packages/mcp-server/src/server.ts` → `SERVER_VERSION`;
- require `v<version>` in `README.md`, `CONTRIBUTING.md`, and the first ten
  lines of `docs/roadmap.md`;
- require non-empty `docs/releases/v<version>.md`;
- compare `--tag` exactly with `v<version>`;
- when `--website` is present, spawn:

```bash
npm run release:check -- --engine <absolute-engine-root> --version <version>
```

  in the website directory and inherit its output;
- print every failure as `release check: <diagnostic>`, return exit code 1 on
  failure, and print `release check: v<version> coherent` on success;
- use an `import.meta.url` main guard so tests can import without executing.

Add scripts:

```json
"check:release": "node scripts/check-release.mjs",
"test:release": "node --test scripts/check-release.test.mjs"
```

- [ ] **Step 4: Run focused tests and the checker**

Run:

```bash
npm run test:release
npm run check:release
```

Expected: fixture tests pass; the real checker fails only because the current
versioned release-note file has not been added yet.

- [ ] **Step 5: Commit the checker**

```bash
git add package.json scripts/check-release.mjs scripts/check-release.test.mjs
git commit -m "build: add release coherence checker"
```

### Task 2: Make CI and release publication consume the contract

**Files:**
- Create: `docs/releases/v1.2.1.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `apps/editor/scripts/smoke-tools.mjs`

- [ ] **Step 1: Extend checker tests to pin current release-note content**

Add a real-repository assertion:

```js
test('the repository release surfaces are coherent', async () => {
  assert.deepEqual(await collectReleaseErrors(resolve(import.meta.dirname, '..')), []);
});
```

Run `npm run test:release` and verify RED because
`docs/releases/v1.2.1.md` is absent.

- [ ] **Step 2: Add the v1.2.1 release body**

Create `docs/releases/v1.2.1.md` with the already-shipped release's asset-pack
intelligence, resilient embedded terminals, and asset-guidance highlights,
followed by the honest desktop signing and standalone agent-tool details
currently embedded in `.github/workflows/release.yml`.

- [ ] **Step 3: Wire the checker and notes file into workflows**

In `.github/workflows/ci.yml`, after dependency installation, add:

```yaml
- name: Check release coherence
  run: npm run check:release
```

In every release matrix job, run:

```yaml
- name: Check release tag and metadata
  shell: bash
  run: npm run check:release -- --tag "${GITHUB_REF_NAME}"
```

Replace the hard-coded `--notes "..."` block with:

```bash
gh release create "${GITHUB_REF_NAME}" \
  --title "Hearth ${GITHUB_REF_NAME}" \
  --notes-file "docs/releases/${GITHUB_REF_NAME}.md" \
  artifacts/*
```

- [ ] **Step 4: Tighten bundled-tool smoke versions**

Read the expected version from the root `package.json`. Require CLI stdout to
equal that version, retain the MCP `initialize` response, and require:

```js
if (initialized.result?.serverInfo?.version !== expectedVersion) {
  fail(`hearth-mcp.mjs reported ${initialized.result?.serverInfo?.version}; expected ${expectedVersion}`);
}
```

Do not add a new dependency or duplicate the release-checker's filesystem scan.

- [ ] **Step 5: Verify workflows and release tests**

Run:

```bash
npm run test:release
npm run check:release -- --tag v1.2.1
npm run build:packages
npm run app:bundle -w @hearth/editor
node apps/editor/scripts/smoke-tools.mjs
```

Expected: all commands exit 0; smoke output reports CLI and MCP at `1.2.1`.

- [ ] **Step 6: Commit workflow enforcement**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml apps/editor/scripts/smoke-tools.mjs docs/releases/v1.2.1.md
git commit -m "build: enforce coherent release metadata"
```

### Task 3: Document the two-repository release path

**Files:**
- Create: `docs/releasing.md`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Add a failing documentation contract**

Extend `scripts/check-release.test.mjs`'s real-repository test to read
`docs/releasing.md` and require all three canonical commands:

```js
for (const command of ['release:sync', 'check:release -- --website', 'release:verify-live']) {
  assert.match(releasing, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
```

Run `npm run test:release` and verify RED because `docs/releasing.md` is absent.

- [ ] **Step 2: Write the maintainer runbook**

Document:

1. commit the engine version and `docs/releases/v<version>.md`;
2. create or update a clean website worktree based on website `origin/main`;
3. run website `npm run release:sync -- --engine <engine> --version <version>`;
4. commit website release data and generated docs;
5. run engine
   `npm run check:release -- --tag v<version> --website <website>`;
6. push/tag the engine and wait for its release workflow;
7. push website `main`, deploy with
   `direnv exec . vercel --prod --yes`, and retain the deployment URL;
8. run website
   `npm run release:verify-live -- --url https://hearthengine.com`.

Explicitly say the website deploy remains separate so private Vercel credentials
never enter the public engine CI.

- [ ] **Step 3: Link the runbook from contributing**

Add a short “Cutting a release” pointer in `CONTRIBUTING.md` without duplicating
the runbook.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run test:release
npm run check:release -- --tag v1.2.1
git diff --check
```

Expected: all exit 0.

```bash
git add CONTRIBUTING.md docs/releasing.md scripts/check-release.test.mjs
git commit -m "docs: codify the release sequence"
```

### Task 4: Engine final verification

**Files:** No production changes expected.

- [ ] **Step 1: Run focused release verification**

```bash
npm run test:release
npm run check:release -- --tag v1.2.1
```

- [ ] **Step 2: Run full engine verification**

```bash
npm run build:packages
npm run typecheck
npm test
```

Expected: 3,148 tests pass with the existing single desktop-integration skip
when its environment flag is absent.

- [ ] **Step 3: Inspect branch scope**

```bash
git status --short
git diff --stat c790171...HEAD
git log --oneline c790171..HEAD
```

Expected: only release tooling, workflow, release notes, and runbook changes.
