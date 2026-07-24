# Website Release and Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the private Hearth website an enforceable engine-version/docs sync contract and replace the stale homepage argument and spreadsheet-like export panel with a crisp animated publishing story.

**Architecture:** Machine-readable release data becomes the website's sole version source. Dependency-free Node scripts sync and compare exact engine docs and verify production, while the homepage stays a focused React island using the existing motion primitives and a one-shot source-to-destinations composition.

**Tech Stack:** Astro 5, React 19, Motion, Tailwind CSS, Node.js 20+ standard library and test runner, Vercel CLI.

---

## File map

- `src/data/release.json` — single website release/tag source.
- `src/pages/download.astro` — consumes release data instead of a literal.
- `scripts/sync-docs.mjs` — exposes deterministic sync/check behavior for an exact engine path.
- `scripts/release.mjs` — `sync`, `check`, and `verify-live` release commands.
- `scripts/release.test.mjs` — temporary-repository and local HTTP-server tests.
- `package.json` — release and test entry points.
- `src/pages/index.astro` — removes the obsolete problem beat.
- `src/components/landing/Problem.tsx` — deleted.
- `src/components/landing/ShipIt.tsx` — clean Launch Pad publishing composition.
- `scripts/homepage-contract.test.mjs` — source/build contract for removed claims and real destinations.

### Task 1: Create website release data and exact sync checks test-first

**Files:**
- Create: `src/data/release.json`
- Create: `scripts/release.test.mjs`
- Create: `scripts/release.mjs`
- Modify: `scripts/sync-docs.mjs`
- Modify: `src/pages/download.astro`
- Modify: `package.json`

- [ ] **Step 1: Write release-contract tests**

Use `node:test` with temporary engine and website fixtures. Import:

```js
import { parseArgs, syncRelease, checkRelease, verifyLiveRelease } from './release.mjs';
```

Cover:

```js
test('sync writes release data and generated docs from the exact engine', async () => {
  const result = await syncRelease({ websiteRoot, engineRoot, version: '1.2.1' });
  assert.equal(JSON.parse(await readFile(join(websiteRoot, 'src/data/release.json'))).tag, 'v1.2.1');
  assert.match(await readFile(join(websiteRoot, 'src/content/docs/quickstart.md'), 'utf8'), /engine fixture/);
  assert.ok(result.changed.includes('src/data/release.json'));
});

test('check reports version and generated-doc drift without writing', async () => {
  await writeFile(join(websiteRoot, 'src/data/release.json'), '{"version":"1.2.0","tag":"v1.2.0"}');
  const before = await readFile(join(websiteRoot, 'src/content/docs/quickstart.md'), 'utf8');
  const errors = await checkRelease({ websiteRoot, engineRoot, version: '1.2.1', runBuild: false });
  assert.match(errors.join('\n'), /release\.json.*1\.2\.0.*1\.2\.1/);
  assert.equal(await readFile(join(websiteRoot, 'src/content/docs/quickstart.md'), 'utf8'), before);
});

test('rejects a requested version that disagrees with the engine', async () => {
  await assert.rejects(
    syncRelease({ websiteRoot, engineRoot, version: '1.2.0' }),
    /engine.*1\.2\.1/,
  );
});
```

Test `verifyLiveRelease` against a temporary `node:http` server: `/download/`
contains `v1.2.1` and its release URL, `/docs/quickstart/` returns 200, and
missing version copy produces a clear failure.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --test scripts/release.test.mjs
```

Expected: FAIL because `scripts/release.mjs` does not exist.

- [ ] **Step 3: Refactor docs sync into importable deterministic functions**

Keep the existing `DOCS` manifest and link rewriting. Export:

```js
export async function renderDocs(engineRoot) {}
export async function syncDocs(engineRoot, outDir) {}
export async function checkDocs(engineRoot, outDir) {}
```

`renderDocs` returns a `Map<relativeOutputPath, content>`. `syncDocs` writes
that map. `checkDocs` compares the map to disk, reports missing/extra/different
files, and never writes. Preserve the current standalone behavior and fallback
for ordinary Vercel builds with no engine checkout. Add a `--check` CLI mode
that requires the engine input to exist and never uses stale generated content.

- [ ] **Step 4: Implement the release CLI**

Support:

```bash
node scripts/release.mjs sync --engine <path> --version 1.2.1
node scripts/release.mjs check --engine <path> --version 1.2.1
node scripts/release.mjs verify-live --url https://hearthengine.com
```

Requirements:

- read the engine root `package.json` version and require exact equality;
- when the engine path is a Git checkout/worktree, refuse a dirty engine
  (`git status --porcelain`) so generated docs always correspond to one
  reproducible commit;
- `sync` writes `{ "version": "1.2.1", "tag": "v1.2.1" }` plus generated docs;
- `check` compares release data and docs without writing, runs
  `node scripts/check-links.mjs` if available, rejects fragile non-generated
  marketing inventory claims matching
  `\b\d+\s+(tools?|commands?|components?|example games?)\b`, then runs
  `npm run build`;
- build subprocesses receive `HEARTH_REPO=<exact engine root>`;
- `verify-live` reads local release data, fetches `/download/` and
  `/docs/quickstart/`, requires successful status, the exact tag, and a GitHub
  release URL containing that tag;
- every failure names the mismatched artifact and exits non-zero;
- export functions and guard CLI execution with `import.meta.url`.

Add scripts:

```json
"test": "node --test scripts/*.test.mjs",
"release:sync": "node scripts/release.mjs sync",
"release:check": "node scripts/release.mjs check",
"release:verify-live": "node scripts/release.mjs verify-live"
```

- [ ] **Step 5: Consume release data on the download page**

Replace:

```js
const VERSION = 'v1.2.1';
```

with:

```js
import release from '../data/release.json';
const VERSION = release.tag;
```

Use a tag-specific GitHub base URL:

```js
const R = `https://github.com/echoo19/hearth/releases/download/${release.tag}`;
```

This makes the live verifier able to prove the page points at the intended
release instead of the mutable `latest` alias.

- [ ] **Step 6: Run RED-to-GREEN verification and commit**

```bash
npm test
npm run release:sync -- --engine /Users/jakekang/projects/hearth/hearth-engine/.worktrees/release-coherence --version 1.2.1
npm run release:check -- --engine /Users/jakekang/projects/hearth/hearth-engine/.worktrees/release-coherence --version 1.2.1
```

Expected: tests and check exit 0; generated docs match the exact engine
worktree.

```bash
git add package.json scripts/release.mjs scripts/release.test.mjs scripts/sync-docs.mjs src/data/release.json src/pages/download.astro src/content/docs
git commit -m "build: enforce website release sync"
```

### Task 2: Remove the obsolete homepage problem beat

**Files:**
- Create: `scripts/homepage-contract.test.mjs`
- Modify: `src/pages/index.astro`
- Delete: `src/components/landing/Problem.tsx`

- [ ] **Step 1: Write the failing homepage contract**

Read `src/pages/index.astro` and built `dist/index.html`. Require:

```js
assert.doesNotMatch(source, /Problem/);
assert.doesNotMatch(html, /Coding agents can.t touch/);
assert.doesNotMatch(html, /Every existing engine was built for a person with a mouse/);
```

The test may run `npm run build` once in a setup hook with
`HEARTH_REPO` pointing at the supplied engine worktree.

- [ ] **Step 2: Run the contract and verify RED**

```bash
node --test scripts/homepage-contract.test.mjs
```

Expected: FAIL because the import, component, and rendered claims still exist.

- [ ] **Step 3: Remove the beat and repair page annotations**

Delete `Problem.tsx`; remove its import and `<Problem client:visible />` from
`index.astro`; update beat numbering and comments so the page describes the
remaining six beats. Do not replace the section with new competitor copy.

- [ ] **Step 4: Verify and commit**

```bash
node --test scripts/homepage-contract.test.mjs
git diff --check
```

Expected: pass.

```bash
git add src/pages/index.astro scripts/homepage-contract.test.mjs
git rm src/components/landing/Problem.tsx
git commit -m "content: remove obsolete engine comparison"
```

### Task 3: Replace the export table with the crisp Launch Pad composition

**Files:**
- Modify: `scripts/homepage-contract.test.mjs`
- Modify: `src/components/landing/ShipIt.tsx`

- [ ] **Step 1: Extend the contract for real destinations and removed table UI**

Add assertions against the source and built homepage:

```js
for (const label of ['Native app', 'macOS', 'Windows', 'Linux', 'Web build', 'itch.io', 'browser', 'static host']) {
  assert.match(html, new RegExp(label.replace('.', '\\.')));
}
assert.match(html, /itch\.io-ready zip/);
assert.doesNotMatch(source, /ArtifactRow|DESKTOP_ARTIFACTS|~85 MB|unsigned/);
```

Run the focused test and verify RED because the new destination labels are not
all present and the old row implementation remains.

- [ ] **Step 2: Implement the static composed state first**

Replace the artifact interfaces, data rows, and table-like grid with one
`aria-labelledby` composition:

- a compact `Emberfall` source tile;
- a `Validated` status under the tile;
- one centered path that forks;
- a `Native app` destination with `macOS`, `Windows`, and `Linux`;
- a `Web build` destination with `itch.io`, `browser`, and `static host`;
- honest supporting text: `itch.io-ready zip`, never an upload claim;
- an understated command caption for each destination:
  `hearth export desktop --allow build` and
  `hearth export web --zip --allow build`.

Use inline SVG platform/destination marks already represented in Hearth's
codebase. Keep one bordered composition, no nested dashboard card grid, no
sizes/signing columns, no glass, particles, 3D tilt, or broad glow.

- [ ] **Step 3: Add one-shot restrained motion**

Use `motion` and `useReducedMotionSafe` directly. The non-reduced sequence is:

```text
0.00–0.35 source settles
0.28–0.62 validation resolves
0.48–0.90 trunk and fork scale into place
0.72–1.20 destinations settle
0.92–1.45 platform labels reveal
```

Use the existing `[0.16, 1, 0.3, 1]` ease, `viewport={{ once: true }}`, opacity,
small translate values, and scale transforms only. No infinite animation.
Reduced motion uses `initial={false}` and renders the fully composed end state.
Hover/focus may change border color locally without replaying the sequence.

On mobile, the path becomes a short vertical trunk and destinations stack;
commands wrap without horizontal overflow.

- [ ] **Step 4: Run source/build contract and type-aware build**

```bash
npm test
HEARTH_REPO=/Users/jakekang/projects/hearth/hearth-engine/.worktrees/release-coherence npm run build
```

Expected: contract tests and Astro build exit 0; the built homepage includes all
destinations and no removed claims/table rows.

- [ ] **Step 5: Commit the publishing visual**

```bash
git add src/components/landing/ShipIt.tsx scripts/homepage-contract.test.mjs
git commit -m "feat: animate the publishing launch path"
```

### Task 4: Visual and release integration verification

**Files:** No production changes expected unless verification exposes a defect.

- [ ] **Step 1: Run the website release contract against the engine worktree**

```bash
npm run release:check -- --engine /Users/jakekang/projects/hearth/hearth-engine/.worktrees/release-coherence --version 1.2.1
```

- [ ] **Step 2: Render desktop, mobile, and reduced-motion screenshots**

Start the built preview and use Playwright Chromium to capture:

- homepage at `1440×1000`;
- homepage at `390×844`;
- homepage at `1440×1000` with `reducedMotion: 'reduce'`.

Inspect the images for clipped labels, spreadsheet/table resemblance, excessive
glow, unbalanced whitespace after section removal, and an incomplete static
reduced-motion state.

- [ ] **Step 3: Run final website verification**

```bash
npm test
HEARTH_REPO=/Users/jakekang/projects/hearth/hearth-engine/.worktrees/release-coherence npm run build
git diff --check
git status --short
```

Expected: tests and build pass; only planned website files and generated docs
are present.

- [ ] **Step 4: Inspect branch scope**

```bash
git diff --stat ea389b7...HEAD
git log --oneline ea389b7..HEAD
```

Expected: release sync tooling/data plus the two homepage changes.
