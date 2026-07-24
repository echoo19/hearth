# Releasing Hearth

This is the canonical maintainer sequence for the public engine repository and
the private website repository. Use a new version in the examples below; do not
reuse an existing tag.

## 1. Prepare and commit the engine release

Start from a clean engine branch based on `origin/main`. Set task-specific
paths rather than relying on the current directory:

```bash
ENGINE_ROOT=/absolute/path/to/hearth-engine
WEBSITE_REPO=/absolute/path/to/hearth-website
WEBSITE_WORKTREE=/absolute/path/to/hearth-website-release
VERSION=1.2.2
TAG=v$VERSION
```

From `$ENGINE_ROOT`, update every workspace manifest and lock record:

```bash
npm version "$VERSION" --workspaces --include-workspace-root --no-git-tag-version
```

Update `HEARTH_VERSION`, the CLI `VERSION`, the MCP `SERVER_VERSION`,
`README.md`, `CONTRIBUTING.md`, and the current-release claim at the top of
`docs/roadmap.md`. Add complete release copy at
`docs/releases/v$VERSION.md`. Then regenerate the checked-in projects and run
the engine-only gate:

```bash
npm run build:packages
node packages/examples/generate.mjs
node packages/templates/generate.mjs
npm run check:release
npm run test:release
git diff --check
```

Run the normal build, typecheck, tests, and bundled-tool smoke before committing
the release preparation. The website sync requires a clean, reproducible engine
commit, so commit the engine changes before continuing.

## 2. Prepare and commit the website release

Never prepare a release from an old website feature branch. Fetch the private
repository and create a clean worktree directly from its current
`origin/main`:

```bash
git -C "$WEBSITE_REPO" fetch origin main
git -C "$WEBSITE_REPO" worktree add -b "release-$VERSION" "$WEBSITE_WORKTREE" origin/main
```

From `$WEBSITE_WORKTREE`, sync the version data and generated documentation
from the exact engine commit, validate it, and commit it:

```bash
direnv allow
npm run release:sync -- --engine "$ENGINE_ROOT" --version "$VERSION"
npm run release:check -- --engine "$ENGINE_ROOT" --version "$VERSION"
git diff --check
git add src/data/release.json src/content/docs
git commit -m "Publish Hearth v$VERSION"
```

Include any other website source files intentionally changed by
`release:sync`; inspect `git status` rather than assuming the two paths above
are exhaustive.

## 3. Cross-check, tag, and publish the engine

Back in `$ENGINE_ROOT`, make the engine validate the prepared website as part
of the same release contract:

```bash
npm run check:release -- --tag "$TAG" --website "$WEBSITE_WORKTREE"
```

Push the prepared engine `HEAD` to `main`, tag that same commit, and push only
the new tag:

```bash
direnv exec . git push origin HEAD:main
git tag "$TAG"
direnv exec . git push origin "$TAG"
```

Wait for the GitHub Release workflow to finish, then inspect the published
release and its assets before moving on:

```bash
direnv exec . gh run list --workflow Release --branch "$TAG" --limit 1
direnv exec . gh release view "$TAG"
```

If a runner flakes before publication, rerun the failed jobs. Do not move or
reuse a tag after GitHub has published its release.

## 4. Push, deploy, and verify the website

Only after the GitHub release exists, push the prepared website commit to its
`main`, deploy production, retain the deployment URL, and verify the live
version plus synced docs:

```bash
cd "$WEBSITE_WORKTREE"
direnv exec . git push origin HEAD:main
direnv exec . vercel --prod --yes
npm run release:verify-live -- --url https://hearthengine.com
```

The website remains a separate explicit step by design. Its repository access,
Vercel token, and other private secrets stay in the private website environment;
they do not enter the public engine repository or its CI. The engine's optional
`--website` delegation validates prepared public output without needing those
credentials.
