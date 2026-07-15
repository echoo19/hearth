# Wave L2 — FINAL GATE REVIEW

Date: 2026-07-14 · Reviewer: fable final gate
Scope: hearth-craft skill + distribution (40666a2..492cfee), connectability
parity (5d6a58c / 1e6f01d / 368c0c6), docs IA + 7 pages + README + positioning
(d87b477 + website), reconciliation (f32da86 / f8e4371).
Spec: docs/superpowers/specs/2026-07-14-waveL2-agent-gamecraft-design.md

## Verdict: READY TO RELEASE as v0.15.0

All six gate checks pass. No mandatory pre-release code fixes. The release
commits themselves carry two required doc edits (roadmap), listed at the end.

---

## 0. Constraint audit

- **NO game builds** — verified. `git diff --diff-filter=A 3640fd4..HEAD`
  shows only: skill copies (13 fixtures), 7 docs pages, hearthShim.ts + its
  test. No new game projects, no new example. The gate's own recipe spot-run
  happened in a throwaway scratchpad project (never in the repo) and was a
  playtest assert, not a game.
- **Anti-bloat** — no new engine commands. Registry live-counted at exactly
  **71 commands** (`hearth commands --json`), unchanged from v0.14.0. MCP
  tools unchanged at 70 TOOL_SPECS + screenshot + get_agent_instructions = 72
  (test-asserted, packages/mcp-server/tests/export.test.ts:127).
- **No example showcase on website** — confirmed by live sweep (one
  pre-existing item flagged below, not from this wave).
- Working tree clean; website repo clean and pushed.

## 1. Craft-skill accuracy — PASS

**15 recipe claims sampled against source, all accurate:**

| Claim (skills/hearth-craft/SKILL.md) | Source | Verdict |
| --- | --- | --- |
| `ctx.camera.shake(intensity, seconds, {seed})` | ctxApi.ts:481 | exact |
| `ctx.camera.fade` persists across scenes, onComplete | ctxApi.ts:494 ("Survives scene switches") | exact |
| `ctx.camera.zoomPunch(scale, seconds)` | ctxApi.ts:506 | exact |
| `ctx.effects.flash` auto-adds SpriteEffects | ctxApi.ts:514 ("adding the component if…") | exact |
| `ctx.particles.burst(n)` needs existing emitter | ctxApi.ts:239 ("Warns if… no ParticleEmitter") | exact |
| Effects "last-call-wins per kind" | runtime/src/cameraEffects.ts:116,132,141,167 — every kind documents "Last call wins" | exact |
| tween easings `linear/easeIn/easeOut/easeInOut` | ctxApi.ts:200 (the literal enum) | exact |
| `ctx.timers.after`, `ctx.audio.play/playMusic/stopMusic/setMusicVolume` (fadeIn/fadeOut opts), `ctx.save/load/clearSave`, `ctx.ui.focus/moveFocus/activate/adjust`, `ctx.animator.setParam/fire/state` | ctxApi.ts | all exact |
| Sound presets `coin jump hit laser powerup explosion blip`, `--seed` | core/src/assets/sounds.ts:13 SOUND_PRESETS; program.ts:464-465 | exact |
| ParticleEmitter fields incl. `direction` degrees (0=+x, 90=+y/down), `gravity`, `seed` | schema/components.ts:305-330 | exact, incl. the direction comment verbatim |
| Playtest steps `assertCameraEffect` (effect enum shake/flash/fade/zoomPunch), `assertParticleCount` (entity + equals/min/max), `assertAudioCount`, `assertNoErrors` | schema/project.ts:408-443 | exact |
| CLI lines: `set-input <action> [keys...]`, `add component … --properties`, `create asset slice/anim-from-sheet`, `create playtest --scene --steps-file --seed`, `import asset --recursive`, `screenshot --frame --out` (+build perm), `export web --zip`, `test`, `diff` | cli/src/program.ts | all exist with the exact flags |

**Drift/accuracy tests:** targeted run green — skillAccuracy.test.ts (10:
extracts every `hearth` invocation from BOTH skills, resolves each command
path and flag against the real registry, plus validator-catches-drift cases),
agentSkill.test.ts (4: embedded constants byte-match both canonical SKILL.md
files; scaffold paths), scaffold.test.ts (4). 18/18.

**Recipe spot-run (scratch arcade template, playtest assert):** applied the
flagship "full impact stack" recipe verbatim — hit-feedback.lua as written,
the exact ParticleEmitter `--properties` line, the exact layered-sound CLI
lines, the skill's steps.json asserts. Result: **playtest green** —
`assertCameraEffect shake = 1` (frame 41, intensity 6/0.18s/seed 1, exactly
the recipe's call), `assertParticleCount Enemy = 16` (the burst(16)),
`assertAudioCount = 2` (both layers), `assertNoErrors`. Two observations, both
non-defects:
- Asserting particles requires timing the assert inside the 0.4s lifetime —
  which is exactly what the skill itself teaches ("never hand-count… read the
  count back from a run"). The guidance is honest and necessary.
- In the arcade template, the stock bullet.lua destroys `Target*` entities on
  contact and the destroyed entity's own onCollision juice never fires. Engine
  dispatch behavior, not a skill inaccuracy (the recipe targets a surviving
  entity — knockback/recovery presuppose it). Worth remembering if a future
  wave adds a "juice on death" recipe.

## 2. Sourcing honesty — PASS (3/3 re-verified live)

- **Kenney** — kenney.nl live; FAQ states verbatim "all game assets on the
  asset pages are public domain licensed (CC0)… Attribution is not required".
  Matches the table exactly.
- **itch.io CC0** — URL resolves to the CC0 v1.0 Universal filter; live count
  **2,646 results** vs the skill's "2,600+". Accurate.
- **Google Fonts** — live FAQ confirms commercial use incl. bundling in sold
  products; OFL "most common", Apache/UFL the small remainder. The ~99/~1
  split holds in substance.

## 3. Connectability — PASS

- **Tests:** 73/73 targeted — agentSetup (21, incl. config-shape for
  .mcp.json / opencode.json+provider / codex argv+already-configured /
  hermes YAML merge + parse-refusal), hearthShim (7), agentPanelDetect (6),
  agentPanelGuards (15), agentRoutes (8), ptyManager (16).
- **Live PTY launch** (real ensureHearthShim + hearthPtyEnv + node-pty,
  zsh): `hearth --version` → 0.14.0 via the shim, and `codex --version` →
  codex-cli 0.142.3 inside the pty. --version only; no paid session.
- **Packaged app** (`npm run app:dist`, arm64 .app, HEARTH_SMOKE=1): all
  checks passed — /api/meta, window load, native menu dispatch, pty
  round-trip, and the new "**hearth CLI reachable via PATH shim**" check.
- **Guides vs agentSetup.ts:** connect-codex / connect-opencode /
  connect-hermes / connect-claude-code / agent-panel each describe exactly
  what the code does (codex `mcp get` → `mcp add` argv, opencode
  `{type:"local", command:[…], enabled:true}` + provider-only-if-models-and-
  unset, hermes direct YAML merge with the interactive-`mcp add` rationale,
  global-config repointing caveat for codex/hermes). No aspirational claims
  found.
- **Honesty notes verified against machine reality:** claude/codex/hermes ARE
  on PATH here; opencode/ollama are NOT — and those are precisely the two
  paths the guides mark "config-shape-tested only, not live-verified"
  (connect-opencode.md, echoed in connect-hermes.md). The hermes note's claim
  of a live-exercised CLI checks out (~/.local/bin/hermes exists).

## 4. Website — PASS (one pre-existing flag)

- **Journey IA:** live /docs renders exactly the 6 groups (Get started /
  Build / Script / Ship / Agents / Reference) with every page grouped; no
  fallback bucket.
- **7 new pages:** all 200 with real rendered content matching engine
  markdown (connect-claude-code/-codex/-opencode/-hermes/-any-agent,
  ship-web-hosting, ship-desktop).
- **Positioning:** "AI-native" + knowledge-layer story present (title/meta +
  /how-it-works); MCP consistently framed as plumbing/one of several front
  doors; no "MCP + engine" headline regressions; no example showcase
  sections.
- **Flag (pre-existing, NOT this wave):** /docs/quickstart's "Where next"
  contains an `[Examples](…/packages/examples)` cross-link. It dates to Wave
  J (engine docs/quickstart.md:138, synced verbatim) and is a docs
  cross-reference, not a showcase section — but it technically brushes the
  standing "no example links on the website" rule. Jake's call; if unwanted,
  the fix is one line in engine docs/quickstart.md + resync.
- **Minor count nit (pre-existing):** the homepage hero's Claude Code chip
  says "70 tools" (ClaudeCodeFrame.tsx:123); the true total is 72 (70
  command tools + screenshot + get_agent_instructions). Defensible as
  command-tools, but inconsistent with README's "72". Non-blocking.
- **README counts:** "71 commands / 72 typed tools — 70 wrapping a core
  command, plus screenshot and get_agent_instructions" — all three numbers
  verified against the live registry and the test-pinned TOOL_SPECS.

## 5. Full gate — PASS

- `npx vitest run`: **206 files passed, 1 skipped; 2636 tests passed, 1
  skipped, 0 failures.**
- `npm run typecheck` (all workspaces): exit 0.
- **Regen double-run:** built core/runtime/playtest, ran
  `packages/examples/generate.mjs` + `packages/templates/generate.mjs`
  twice — `git status --porcelain` empty after BOTH runs (byte-identical,
  and identical to what's committed). All 13 fixtures (10 examples + 3
  templates) carry both `hearth` and `hearth-craft` under .claude/skills/.

## 6. Release call — v0.15.0 (minor)

Editor/server shipped feature-grade agent UX: launcher parity
(detect/prepare/launch for codex/opencode/hermes with per-tool native config
writers), the guaranteed-PATH hearth shim in every embedded terminal, Agent
panel dropdown, and electron main smoke coverage. That is squarely a minor
bump per the spec's own constraint ("ships as v0.15.0 if editor/server code
changes land — track 3"), not a 0.14.1 patch.

**Release-commit items (mirroring the v0.14.0 two-commit pattern):**

1. *Docs polish commit* — docs/roadmap.md:
   - Rewrite the "Wave L2 — agent game-craft (mini-wave)" section (~line 688)
     from forward-looking stub into the shipped record: hearth-craft skill
     embedded + scaffolded + backfilled (13 fixtures carry both skills),
     asset-sourcing playbook (sources fact-checked live), launcher parity +
     PATH shim + per-tool MCP config, journey-grouped docs IA + 7 guides,
     AI-native README/positioning. Counts: registry unchanged at 71
     commands, MCP unchanged at 72 tools, **no new commands**.
   - **Remove the now-false "Codex first-class MCP wiring" bullet from
     Parallel track / post-1.0** (~line 707: "`.mcp.json` auto-preparation is
     Claude-Code-only — Codex's config story is TOML-based and needs its own
     path") — this wave shipped exactly that (prepareCodexConfig via
     `codex mcp add`).
   - README needs no changes (already current — verified).
2. *Release v0.15.0 commit* — bump 0.14.0 → 0.15.0 in root + workspace
   package.jsons, package-lock, packages/cli/src/program.ts version string,
   packages/core/src/schema/project.ts hearthVersion; regen fixtures
   (hearth.json / AGENTS.md / agent-config.json version stamps) — same file
   set as 75cfb9c.
3. Website: resync docs after the roadmap edit (sync pipeline); optionally
   fix the "70 tools" hero chip to 72 while there. Both non-blocking.

**Mandatory fixes before release: none.** Items 1–2 are the release commits
themselves; the two website nits are optional and pre-existing.
