# Release Coherence and Publishing Story

**Date:** 2026-07-23  
**Status:** Proposed  
**Repositories:** `hearth-engine`, `hearth-website`

## Problem

Hearth's release surfaces can drift. Package manifests, runtime version constants,
release notes, generated website docs, the website download version, and the live
deployment are currently maintained by convention rather than one enforceable
release path. The v1.2.1 follow-up correction to `CONTRIBUTING.md` demonstrated
that this is not theoretical.

The homepage also spends a full section arguing that existing engines are
inaccessible to coding agents. That claim is too broad now that other engines
offer MCP and automation integrations. Later on the page, Hearth's genuinely
useful publishing capability is represented by a dense artifact table that
looks administrative instead of making the benefit feel immediate.

## Goals

1. Block an engine release when its version-bearing surfaces disagree.
2. Block the maintainer release path when the website is not prepared for the
   same version and engine documentation.
3. Keep private website credentials out of the public engine repository.
4. Give the website a separate, explicit, verified production deployment step.
5. Remove the outdated competitor/problem section from the homepage.
6. Replace the publishing table with a distinctive but restrained animated
   explanation of Hearth's native and web publishing targets.

## Non-goals

- Coupling the public engine workflow directly to private website secrets.
- Automatically buying, downloading, or publishing third-party assets.
- Redesigning the rest of the homepage.
- Inventing one-click uploads to stores that Hearth does not currently perform.
- Adding a general release orchestration service or new runtime dependency.

## Release design

### 1. Engine-owned release contract

Add a standard-library-only `scripts/check-release.mjs` exposed as
`npm run check:release`.

The check derives the intended version from the root `package.json` and fails
with a precise file-and-value diagnostic when any of these disagree:

- workspace package manifests and lockfile package records;
- engine, CLI, and MCP runtime version constants;
- current-version claims in the README, contributing guide, and roadmap;
- the expected `docs/releases/v<version>.md` release-note file;
- an optional `--tag v<version>` argument used by the tag workflow.

Generated example/template stamps remain governed by their existing generator
drift checks instead of being duplicated in this checker.

Run the checker in normal CI and as the first release-workflow step. The GitHub
release body is read from the versioned release-note file rather than embedded
as a stale version-specific block in workflow YAML. Existing smoke tests are
tightened to require exact CLI and MCP version equality.

### 2. Website-owned release contract

Move the website's current release value into one small machine-readable data
file consumed by the download page and release checks.

Add a standard-library-only website release script with two explicit modes:

- `sync`: given a clean engine checkout and an intended version, verify the
  engine version, update the website release data, sync generated docs from the
  engine, and report the changed files;
- `check`: fail unless website release data and generated docs match the supplied
  engine checkout, then run the existing count-free copy scan and production
  build.

The script must refuse a dirty or version-mismatched engine input. It changes
only generated docs and the release data file; homepage work remains normal
source code.

### 3. Maintainer release sequence

Document one canonical sequence:

1. Prepare the engine version and `docs/releases/v<version>.md`.
2. In a clean website worktree based on `origin/main`, run website `sync` and
   commit the generated website update.
3. Run engine `check:release` with the website path. This cross-repository mode
   invokes the website `check` contract and blocks until both repositories agree.
4. Push/tag the engine and let its public workflow publish the engine release.
5. Push the prepared website commit and deploy it with the website's private
   Vercel environment.
6. Run a live verification that the production download link contains the
   released tag and that representative synced documentation is reachable.

The engine release and website deployment remain two actions by design. The
first cannot begin with stale website content; the second cannot be called
complete without checking production. No website token is stored or invoked by
the public engine CI.

## Homepage design

### Remove the outdated argument

Remove the entire `Problem` homepage beat and its page import. Delete the now
unused component rather than leaving dead copy and motion code behind. Preserve
the surrounding page rhythm by adjusting adjacent section spacing only if the
rendered page shows an obvious gap.

### Replace the export table with “Launch Pad”

Keep the existing heading and honest explanatory copy, but replace the artifact
rows with a single visual sequence:

1. A compact Emberfall project tile enters as the source.
2. A short validation line resolves beneath it.
3. One clean path forks to two always-visible publish choices.
4. **Native app** reveals `macOS`, `Windows`, and `Linux`.
5. **Web build** reveals `itch.io`, `browser`, and `static host`.

The labels describe real supported destinations, not fake integrations. The web
branch may say “itch.io-ready zip”; it must not imply that Hearth uploads to an
itch.io account.

### Visual character

The result should feel like product animation, not a generic generated SaaS
dashboard:

- one bordered composition rather than a grid of cards;
- flat, precise geometry and deliberate alignment;
- Hearth's ember color used only for the active validation/path accent;
- neutral platform marks and typography doing most of the work;
- no glassmorphism, rainbow gradients, particle fields, excessive glow, 3D
  tilt, fake charts, status-pill confetti, or perpetual floating;
- no table rows or spreadsheet columns.

Motion is a one-shot, scroll-triggered sequence using opacity and transforms:
source, validation, fork, then destinations. It lasts roughly 1.4–1.8 seconds
with Hearth's existing easing. After composition, it stays still. Hover/focus
may give a subtle local emphasis but must not restart the sequence. Reduced
motion renders the fully composed static state. On narrow screens, the two
destinations stack under the source without horizontal overflow.

## Testing and acceptance

### Release tooling

- Unit/fixture tests first cover mismatched manifests, constants, prose, missing
  notes, wrong tags, website version drift, and generated-doc drift.
- Existing CI and smoke suites remain green.
- A deliberately altered version fixture produces an actionable failure.
- The release workflow obtains notes from the versioned release-note file.
- The website production build succeeds against the exact engine checkout.

### Website

- The removed section and its claims no longer appear in built HTML.
- The publishing composition shows both branches and all six destination labels.
- The commands and itch.io wording agree with engine docs.
- Mobile and reduced-motion states remain complete and readable.
- A browser render is visually reviewed at desktop and mobile widths.
- Production verification checks the live release URL and synced documentation.

## Delivery boundaries

Engine changes land on engine `main`. Website changes are developed from a clean
worktree rooted at website `origin/main`; the unrelated local
`agent/polish-brand-icons` branch is not modified. Each repository is tested and
committed independently, then the website is deployed and verified.
