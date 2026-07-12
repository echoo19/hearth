# Wave J — Ship Your Game (v0.13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop (Electron) export with signing hooks, itch.io zip parity across all hosts, genre starter templates, a Game Settings panel with a shippable icon, and the v0.13.0 release.

**Architecture:** Core gains `exportDesktop`, which reuses `exportWeb`'s build assembly and delegates packaging to a host resource implemented once in a new Node-only `@hearth/shipping` package (Electron shell + `@electron/packager` + signing + zips) wired into CLI, MCP, and editor server. Templates live in a new `packages/templates` package (generated, checked in) consumed by `hearth init --template` and the editor Launcher.

**Tech Stack:** TS ESM NodeNext, zod, vitest, `@electron/packager`, `png2icons`, `archiver` (or the existing CLI zip approach — reuse whatever `zipExportedDir` uses today), React 18 + dockview.

**Spec:** `docs/superpowers/specs/2026-07-11-waveJ-ship-your-game-design.md` — binding.

## Global Constraints

- Work on the CURRENT branch (main). Do NOT create a branch. Stage ONLY files/hunks you authored (other agents share this tree; `git add <specific paths>`, never `git add -A`).
- npm workspaces (NOT pnpm). TS ESM NodeNext: relative imports end in `.js`. vitest does NOT typecheck — always run `npm run typecheck` too.
- Command count after this wave: **71 registry commands**; MCP tools: **68**. Tests asserting counts must use these values.
- `@hearth/core` stays browser-safe: no node imports, no `Buffer`, no zipping in core. `@hearth/shipping` and `packages/templates`' runtime entry are Node-only; no browser bundle (editor client, player) may import them. No non-literal dynamic imports anywhere.
- All new command payloads/results validated with zod; `safeParse` at boundaries with structured errors (Wave I posture).
- Electron shell hardening is non-negotiable: `contextIsolation: true`, `nodeIntegration: false`, no preload, `webSecurity` untouched (default true), no remote content, navigation locked to the exported files.
- Zip naming: desktop `<slug>-<platform>.zip` (e.g. `ember-horde-darwin-arm64.zip`); web `<slug>-web.zip` with `index.html` at the ZIP ROOT.
- Platforms (exact ids): `darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`. Default = all four.
- Signing ladder (macOS only): no env → ad-hoc `codesign --force --deep -s -`, failure ⇒ warn + `signed:"none"` (never a hard error); `HEARTH_MAC_IDENTITY` ⇒ real signing, failure ⇒ hard error; identity + `HEARTH_APPLE_ID`+`HEARTH_APPLE_PASSWORD`+`HEARTH_TEAM_ID` ⇒ notarize (`xcrun notarytool submit --wait` + staple), failure ⇒ hard error.
- Templates and examples embed `hearthVersion`: ANY version bump regenerates BOTH in the same commit; generators must be deterministic (double-regen proof: run twice, `git status --porcelain` empty).
- Live-patch: `apps/editor/src/livePatch.ts` — both `classifyLocal` and `classifyJournal` must map `exportDesktop` (and keep `exportWeb`) to `none` EXPLICITLY, not via a default bucket.
- Editor UI: typed controls only, no raw JSON fields; charcoal surfaces + ember accents; design under the `impeccable` skill.
- Commits: plain human voice, no AI attribution of any kind.
- Full gate before any task is "done": workspace `npm test` and `npm run typecheck` green.
- Do not kill vite/node processes you did not start.

## File Structure (new)

- `packages/shipping/` — `src/shell.ts` (Electron main generation), `src/package.ts` (packager + icon), `src/sign.ts`, `src/zip.ts`, `src/index.ts` (`packageDesktop`, `zipDirectory`, `describeSigningCapability`), `assets/hearth.icns`, `assets/hearth.ico`, `assets/hearth-icon.png`.
- `packages/templates/` — `generate.mjs`, `src/index.ts` (`listTemplates()`, `getTemplatePath(name)`), `templates/platformer/`, `templates/topdown/`, `templates/arcade/` (checked-in generated projects).
- `apps/editor/src/components/GameSettings.tsx` — new dockview panel.

---

### Task 1: Core — `buildSettings.icon`, shared build assembly, `exportDesktop` command

**Files:**
- Modify: `packages/core/src/schema/project.ts` (BuildSettingsSchema)
- Modify: `packages/core/src/commands/exportCommands.ts`
- Modify: `packages/core/src/commands/types.ts` (CommandResources)
- Modify: `packages/core/src/commands/registry.ts`, `packages/core/src/session.ts` (journal details)
- Test: `packages/core/test/exportDesktop.test.ts`, extend `packages/core/test/exportCommands.test.ts` (or the existing export test file — locate it), settings test for icon.

**Interfaces:**
- Produces: `BuildSettingsSchema` gains `icon: z.string().nullable().default(null)` (sprite asset id) with a doc comment; `updateSettings` accepts it automatically via the schema — add a test proving `updateSettings {icon: 'ast_x'}` round-trips and rejects non-string.
- Produces: internal `assembleWebBuild(ctx, opts: {inlineAssets: boolean; inlinePlayer: boolean}) → Promise<{ files: Array<{path: string; content: string | Uint8Array}>; slug: string; title: string }>` — refactor of `exportWeb`'s existing body so `exportWeb` and `exportDesktop` share one assembly path (exportWeb behavior must not change; its existing tests stay green unmodified except where they reach into internals).
- Produces on `CommandResources`:
  ```ts
  export interface DesktopBuildSpec {
    files: Array<{ path: string; content: string | Uint8Array }>;
    slug: string;
    title: string;
    width: number;   // buildSettings.width
    height: number;  // buildSettings.height
    outDirAbs: string;
    platforms: DesktopPlatform[];
    iconPng?: Uint8Array;  // decoded project icon asset when buildSettings.icon set
  }
  export type DesktopPlatform = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64';
  export interface DesktopBuildResult {
    platform: DesktopPlatform;
    appDir: string;   // project-relative
    zip: string;      // project-relative
    signed: 'adhoc' | 'identity' | 'none';
    notarized: boolean;
  }
  packageDesktop?(spec: DesktopBuildSpec): Promise<DesktopBuildResult[]>;
  ```
- Produces: `exportDesktop` command — payload `{ outDir?: string (default "export/desktop"), platforms?: DesktopPlatform[] (default all four, zod enum array, nonempty) }`, result `{ outDir, slug, builds: DesktopBuildResult[] }`. Behavior: validateProject gate (abort on errors, same as exportWeb); missing `ctx.resources.packageDesktop` ⇒ error code `DESKTOP_EXPORT_UNSUPPORTED` with message naming CLI/MCP/editor as supporting hosts; icon asset resolved + decoded to `iconPng` (missing/non-sprite icon asset ⇒ structured error naming the asset id); journal details-only entry listing platforms + outDir (non-mutating: NO history/undo bucket — mirror exportWeb's journaling exactly).
- Registry: 70 → **71**; update the registry-count test.

**Steps (TDD):**
- [ ] RED: tests for icon schema default/round-trip, exportDesktop payload validation (bad platform id rejected), unsupported-host error code, happy path with a fake `packageDesktop` capturing the spec (assert files include `index.html` + `project.bundle.json` + `hearth-player.js`, width/height from buildSettings, title fallback `buildSettings.title || project.name`), journal details entry, registry count 71.
- [ ] GREEN: schema field, `assembleWebBuild` refactor, command, resources type, registry + session journal details.
- [ ] Full gate: `npm test`, `npm run typecheck`. Commit in two commits: refactor (`exportWeb` assembly extraction, no behavior change) then feature.

### Task 2: `@hearth/shipping` — package scaffold, Electron shell, zip

**Files:**
- Create: `packages/shipping/package.json` (name `@hearth/shipping`, private like other non-published? — match `packages/examples`' publish posture; depends on `@hearth/core` types only via `import type`), `tsconfig.json` matching sibling packages, `src/shell.ts`, `src/zip.ts`, `src/index.ts` (re-exports), `assets/hearth-icon.png` (copy the editor's app icon or the ember glyph from the website assets — a 512×512 PNG).
- Modify: root `package.json` workspaces if not glob-covered; root tsconfig references if the repo uses them (check `tsconfig.json` — follow how `packages/runtime` is wired).
- Test: `packages/shipping/test/shell.test.ts`, `packages/shipping/test/zip.test.ts`.

**Interfaces:**
- Produces: `renderElectronMain(opts: { width: number; height: number; title: string }) → string` — the generated `main.js` (plain CJS JavaScript, runs inside Electron; no TS). Requirements the tests assert literally: `contextIsolation: true`, `nodeIntegration: false`, no `preload`, window `width`/`height`/`title` interpolated (JSON.stringify-escaped), `useContentSize: true`, loads `index.html` via `loadFile`, F11 and Cmd/Ctrl+F toggle `setFullScreen`, `app.on('window-all-closed', () => app.quit())`, `will-navigate` + `setWindowOpenHandler` deny anything not the loaded file URL. No template placeholders (`{{`) may remain in output.
- Produces: `zipDirectory(srcDir: string, zipPath: string) → Promise<void>` — deterministic entry ordering (sorted), entries relative to `srcDir` root (so `index.html` sits at zip root). Reuse the implementation approach of the CLI's existing `zipExportedDir` (`packages/cli/src/program.ts:1205`) — lift its zip mechanics here; Task 4 will re-point the CLI at this.
- Produces: `packageJsonForApp(opts: {name: string; version?: string}) → string` — the tiny `package.json` placed in the Electron app (`main: "main.js"`, name = slug).

**Steps (TDD):**
- [ ] RED: shell tests (flag assertions above; escaping test with a title containing `"</script>` and quotes), zip tests (create temp dir with nested files → zip → reopen with the same lib → assert root-level `index.html`, sorted entries).
- [ ] GREEN: implement; wire the package into the workspace build (`npm run typecheck` covers it).
- [ ] Full gate + commit.

### Task 3: `@hearth/shipping` — packaging, icon conversion, signing ladder

**Files:**
- Create: `packages/shipping/src/package.ts`, `src/sign.ts`, `src/icon.ts`, `assets/hearth.icns`, `assets/hearth.ico` (generate once from `assets/hearth-icon.png` using png2icons in a small `scripts/gen-default-icons.mjs`, check in the outputs).
- Modify: `packages/shipping/src/index.ts`
- Test: `packages/shipping/test/package.test.ts`, `test/sign.test.ts`, `test/icon.test.ts`, `test/desktop-integration.test.ts` (host-platform only).

**Interfaces:**
- Produces (the package's main entry, consumed verbatim by Tasks 4–6):
  ```ts
  export interface PackageDesktopOptions {
    spec: DesktopBuildSpec;                       // from @hearth/core types
    onProgress?: (e: { platform: DesktopPlatform | null; stage: 'stage' | 'download' | 'package' | 'sign' | 'notarize' | 'zip'; message: string }) => void;
    env?: Record<string, string | undefined>;     // default process.env; injectable for tests
    exec?: ExecFn;                                // injectable codesign/notarytool runner for tests
  }
  export function packageDesktop(opts: PackageDesktopOptions): Promise<DesktopBuildResult[]>;
  export function describeSigningCapability(env?: NodeJS.ProcessEnv): { mode: 'adhoc' | 'identity' | 'identity+notarize'; identity?: string };
  ```
- Flow per platform: stage web files + generated `main.js` + app `package.json` into a temp app dir → `@electron/packager` (`dir`, `out`, `platform`/`arch` split from the platform id, `icon` path, `appVersion`, `name` = title, `overwrite: true`, `prune: true`, `quiet: true`) → sign (darwin only, ladder from Global Constraints; notarize operates on a zip of the .app then staples) → `zipDirectory` → result row. Non-darwin platforms: `signed: 'none'`, `notarized: false`.
- Icon: `spec.iconPng` present ⇒ png2icons `createICNS`/`createICO`; absent ⇒ bundled defaults. Conversion failure ⇒ warn via onProgress + fall back to defaults (never fatal).
- Unit tests mock `@electron/packager` (vi.mock) and inject `exec` to assert: platform id splitting, icon path selection/fallback, the full signing decision table (6 rows: no-env success, no-env codesign-fails ⇒ 'none' + no throw, identity success, identity failure ⇒ throws, notary triple success ⇒ notarized true, notary failure ⇒ throws).
- Integration test (`desktop-integration.test.ts`): real packager run for THE HOST PLATFORM ONLY (`process.platform`/`process.arch` mapping), tiny fixture web build; asserts app dir structure + zip exists; skipped unless `HEARTH_DESKTOP_INTEGRATION=1` (CI sets it in the main workflow; document the env var in the test header). Do NOT attempt headless Electron launch in this task — structure assertions only (launching Electron headlessly in CI is flaky; the release workflow's existing smoke pattern is the place to grow that later, out of scope).

**Steps (TDD):**
- [ ] RED unit tests → GREEN implementation → integration test behind the env var, verified locally once (`HEARTH_DESKTOP_INTEGRATION=1 npx vitest run packages/shipping/test/desktop-integration.test.ts` — first run downloads Electron ~100MB, that is expected).
- [ ] Modify `.github/workflows` main CI to export `HEARTH_DESKTOP_INTEGRATION=1` (check the workflow file name — the one running `npm test`).
- [ ] Full gate + commit.

### Task 4: CLI — `export desktop`, zip unification, resources wiring

**Files:**
- Modify: `packages/cli/src/program.ts` (export group ~line 1087; `zipExportedDir` ~line 1205 replaced by `@hearth/shipping` `zipDirectory`; session resources wiring — find where `getPlayerBundle` is provided and add `packageDesktop`), `packages/cli/package.json` (dep on `@hearth/shipping`).
- Test: extend `packages/cli/test/cli.test.ts` (or the export section of the CLI tests — locate the exportWeb CLI tests and sit beside them).

**Interfaces:**
- Consumes: `exportDesktop` command (Task 1), `packageDesktop`/`zipDirectory`/`describeSigningCapability` (Tasks 2–3).
- Produces: `hearth export desktop [--out <dir>] [--platform <p>...]` — repeatable `--platform` validated against the four ids (unknown ⇒ error listing valid ids); guarded by the same permission as `export web` (`--allow build`); human output prints one line per build with platform, zip path, and signing state; `--json` returns the command result untouched. Progress callback prints stage lines to stderr so `--json` stdout stays clean.
- `export web --zip` behavior unchanged, implementation now `zipDirectory` from shipping (delete the local helper).

**Steps:** RED CLI tests (flag parsing, unknown platform, guard, json shape with a stubbed resource via the test harness's session injection — follow how existing CLI tests stub `getPlayerBundle`) → GREEN → full gate → commit.

### Task 5: MCP — `exportDesktop` tool + `exportWeb` zip param

**Files:**
- Modify: `packages/mcp-server/src/tools.ts` (exportWeb tool ~line 877 + new tool), server resources wiring (same file or its session setup — mirror `getPlayerBundle`), `packages/mcp-server/package.json` (dep `@hearth/shipping`).
- Test: extend the MCP tools test (tool count 67 → **68**, exportDesktop schema, exportWeb `zip` flag zips via `zipDirectory` after the command returns — same post-step the CLI does).

**Steps:** RED (count + new tool tests) → GREEN → full gate → commit.

### Task 6: Editor server — packageDesktop resource, export routes, progress stream, live-patch

**Files:**
- Modify: `apps/editor/server/projectServer.ts` (session resources + routes), `apps/editor/server/ws.ts` (progress frames — follow the `pty-*` frame pattern: add `export-progress` / `export-done` / `export-error` frame types), `apps/editor/src/livePatch.ts` (+ its test), `apps/editor/src/api.ts` + `apps/editor/src/types.ts` (client API for the new route + frames).
- Test: editor server export-route test (follow existing projectServer route tests), livePatch classifier test additions.

**Interfaces:**
- Produces routes: `POST /api/export/desktop {outDir?, platforms?}` → starts an export job, returns `{jobId}`; progress streamed over the existing ws as `{type:'export-progress', jobId, platform, stage, message}` then `{type:'export-done', jobId, result}` / `{type:'export-error', jobId, platform?, message}` (per-platform errors carry `platform`). One job at a time: a second start while running returns 409-style error. `POST /api/export/web {singleFile?, zip?}` → runs exportWeb + optional `zipDirectory`, synchronous JSON result. `GET /api/export/capability` → `describeSigningCapability()` + platform list.
- Produces: `classifyLocal`/`classifyJournal` in livePatch explicitly return `none` for `exportDesktop` and `exportWeb` (tests assert both classifiers, both commands).
- Consumes: Tasks 1–3 interfaces.

**Steps:** RED (route + classifier tests) → GREEN → full gate → commit.

### Task 7: Editor — Export dialog desktop target

**Files:**
- Modify: `apps/editor/src/components/ExportDialog.tsx`, styles where the dialog's CSS lives (locate its class names), `apps/editor/src/store.ts` if the dialog needs store state for the ws job.
- Test: component tests beside existing ExportDialog tests (target switch renders desktop options; progress frames append; per-platform error renders on its row; zip checkbox passes `zip:true`).

**Requirements:** Invoke the `impeccable` skill before UI work. Web/Desktop segmented control (Web default, current content unchanged plus a "Zip for itch.io" checkbox replacing the CLI hint text at line ~131). Desktop pane: four platform checkboxes (all on), out-dir field (default `export/desktop`), signing status line from `/api/export/capability` ("Ad-hoc signing" / "Signing as <identity>" / "Signing + notarizing as <identity>"), Export button → ws job with a per-platform progress list (stage label + message, ember accent on the active row), per-build success rows showing zip path with a copy button, errors inline on the failed platform's row. Keep the dialog keyboard-navigable; disable inputs while a job runs; no raw JSON anywhere.

**Steps:** RED component tests → GREEN → full gate → commit.

### Task 8: Editor — Game Settings panel (buildSettings + icon)

**Files:**
- Create: `apps/editor/src/components/GameSettings.tsx`
- Modify: `apps/editor/src/workspace/Workspace.tsx` (PANEL_TITLES + panel registry: id `game`, title `Game`), `apps/editor/src/workspace/layout.ts` (default layout placement beside `input`), `apps/editor/src/keybinds.ts` if panels have open-shortcuts (mirror `input`).
- Test: component tests (renders current values; edits dispatch `updateSettings` with only the changed field; icon picker lists sprite assets + "None"; invalid width rejected client-side).

**Requirements:** Invoke `impeccable`. Typed controls for: title (text), width/height (int fields, min 1), backgroundColor (the editor's existing color control — reuse whatever Inspector uses), targetFps + fixedTimestep (int), loading.backgroundColor/image/spinner, icon (sprite-asset picker with thumbnail preview + None; helper text "Used as the desktop app icon"). All edits go through the existing command dispatch (`updateSettings`) so undo/journal/live-patch work for free. Follow InputSettings.tsx's structure/CSS conventions.

**Steps:** RED → GREEN → full gate → commit.

### Task 9: `packages/templates` — generator + three genre skeletons

**Files:**
- Create: `packages/templates/package.json` (name **`@hearth/templates`**, `files` includes `templates/`), `generate.mjs`, `src/index.ts`, `templates/…` (generated output, checked in), tests `packages/templates/test/templates.test.ts`.
- Modify: `packages/examples/generate.mjs` ONLY if extracting shared pixel-art helpers — prefer importing `packages/examples/pixelart.mjs` directly from the templates generator (both are repo-internal .mjs; check its export shape first).

**Interfaces:**
- Produces: `listTemplates() → Array<{name: 'platformer'|'topdown'|'arcade'; description: string}>`; `getTemplatePath(name) → string` resolving `$HEARTH_TOOLS_DIR/templates/<name>` first, then package-relative `templates/<name>` (mirror how hosts resolve the player bundle — read that resolution code in the CLI before writing this).
- Template content (each): one scene, camera, player entity with input-driven movement script (~30 lines, comment-annotated as a teaching surface), a handful of placed tiles/obstacles, one playtest named `smoke` asserting the player entity moves under injected input. Genre specifics from the spec: platformer = gravity+jump+small autotiled ground strip; topdown = 4-dir movement + camera follow + small autotiled room; arcade = fixed camera + ship + shoot-on-key + one target prefab spawned. Use generated pixel-art sprites (pixelart.mjs helpers). Small: ≤ ~12 entities per template.
- Determinism: `node packages/templates/generate.mjs` twice ⇒ clean `git status --porcelain` (no timestamps/random ids — seed or fix ids the way `packages/examples/generate.mjs` does; read it first).
- Tests: for each template, load through `ProjectFileSchema`/scene schemas (safeParse success), run core `validateProject` clean, run its playtest via the runtime harness the examples tests use (find and mirror the examples' playtest test), assert `hearthVersion === HEARTH_VERSION`.

**Steps:** RED (tests over not-yet-generated dirs fail) → generator + run it → GREEN → full gate → commit (generator + generated output + tests together).

### Task 10: Templates wiring — `init --template`, Launcher picker, server route

**Files:**
- Modify: `packages/cli/src/program.ts` (init command ~line 189), `packages/cli/package.json` (dep `@hearth/templates` — match the package name chosen in Task 9's package.json: `@hearth/templates`), `apps/editor/server/projectServer.ts` (createProject route ~line 383: `template?` param), `apps/editor/src/components/Launcher.tsx`, `apps/editor/src/api.ts`.
- Test: CLI init tests (template happy path produces a project that `validate`s clean; unknown template error lists `platformer, topdown, arcade`; `--list-templates` prints names+descriptions; `--template` + `--no-starter` conflict ⇒ error), Launcher component test (picker renders blank-first preselected; selection passes template name), server route test.

**Interfaces:**
- Consumes: `listTemplates()`, `getTemplatePath(name)` (Task 9).
- Template application (shared helper in the CLI or core-host util — put it in `packages/templates/src/apply.ts` as `applyTemplate(fs, templatePath, targetDir, {name, description}) → Promise<{files: string[]}>`): copy the template dir, then rewrite `project.json`'s `id` (fresh `prj_` id — reuse core's id generator), `name`, `description`, keeping everything else. Result must open + validate cleanly.
- Launcher: template picker as a horizontal card row (Blank first + 3 genres, name + one-line description + small glyph — glyphs may be simple inline SVG), Blank preselected; picking a genre routes through the extended create route. Invoke `impeccable` for the picker.
- Editor server route gains `template?: string`, validated against `listTemplates()` names.

**Steps:** RED → GREEN → full gate → commit.

### Task 11: Docs pass

**Files:**
- Modify: `docs/` export guide (desktop section: platforms, first-run Electron download, signing env vars table, verification limits statement), NEW `docs/shipping-to-itch.md` (web zip upload, desktop channel zips, butler as manual step), CLI reference, MCP reference (68 tools), `AGENTS.md` (exportDesktop, templates + when to pick each, buildSettings.icon), architecture doc (shipping + templates packages), components/settings doc (icon field), roadmap tick for Wave J, root + package READMEs, every stale "70 commands"/"67 tools" count → 71/68.
- Verify each documented command/flag against the implemented CLI (`--help` output) — docs must match code, not the plan.

**Steps:** write → cross-check flags/counts against code → commit. (Docs-accuracy review happens in the final review.)

### Task 12: Final whole-branch review (fable) + fixes

- Review package over the whole wave (merge-base at the pre-Task-1 commit). Reviewer: fable, with live probes (fresh init from each template → validate + playtest; real host-platform desktop export of a template project; web zip export; upgrade path: open a v0.12 project, confirm icon defaults null and export works; MCP 68-tool boot; editor dialog + panel smoke via component tests; release dry-run: version-bump script on a scratch branch to prove examples+templates regen stays clean-tree).
- Fix findings via ONE fix dispatch, re-review until READY TO RELEASE.

### Task 13: Release v0.13.0

- Bump all package versions + `HEARTH_VERSION` (`packages/core/src/schema/project.ts:9`) + CLI `VERSION` (`packages/cli/src/program.ts:49`); regenerate examples AND templates in the SAME commit; double-regen proof; lockfile.
- `direnv exec . git push origin main --tags` after tagging `v0.13.0`; watch the release workflow (assets 11/11) and main CI to green (remember Wave I: CI-only env gaps — if anything Electron-ish fails on CI Node, the navigator-stub precedent applies).
- Website: counts 71/68 + "ship your game" (desktop export + templates) messaging; NO example/game showcase; deploy via `direnv exec . vercel --prod --yes` in the website repo; live-verify.
- Update `.superpowers/sdd/progress.md`, run note, SecondBrain index.

## Parallelization lanes

- Lane A (core→hosts): T1 → T2 → T3 → {T4, T5, T6 in parallel — disjoint packages} → T7.
- Lane B (templates): T9 → T10 (Launcher half of T10 must not run concurrently with T7's store edits — they touch different files, but T10 and T7 both edit `apps/editor/src/api.ts`; serialize T7 before T10 or assign api.ts additions to one of them only: T6 owns api.ts export additions; T10 owns the template additions; T7 touches store.ts only if needed).
- Lane C: T8 anytime after T1 (needs icon field). T11 after all code tasks. T12 → T13 strictly last.
