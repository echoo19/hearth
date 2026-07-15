# Wave L final gate review — v0.14.0 (T14)

Reviewer: fable, 2026-07-14. Scope: 129 commits, `6582e4c..d599b1b` (HEAD at
review time). Method: targeted deep-read of the highest-blast-radius diffs,
five live integration probes (own scratch projects, own ports 5360/5361,
playwright + swiftshader, packaged app, real unzip-launch), ledger honesty
sampling, and a full release-mechanics dry-run executed in an isolated
worktree at HEAD.

## VERDICT: READY TO RELEASE

No mandatory code fixes. The release itself carries four mandatory
**release-commit / process** items (§6). Everything else found is recorded
as non-blocking notes (§7).

---

## 1. Gate evidence (re-run independently, not inherited)

- Full suite at HEAD: **2591 passed + 1 skipped (205 files)**, `npm run
  typecheck` clean — matches the claimed wave-gate numbers.
- Ledger: **121 entries, 0 open** (100 fixed / 11 by-design / 10 deferred-M);
  every entry has a disposition.
- Working tree clean except two untracked scratch dirs (`.waveL-scratch-shell/`,
  `.claude/`) — delete `.waveL-scratch-shell/` before tagging (hygiene only).

## 2. Diff review (targeted deep-reads) — PASS

Deep-read: `packages/runtime/src/pixi/index.ts` (+ `keyboardCapture.ts`,
`audio.ts`, `graphicsGuard.ts`, `input.ts`), `packages/shipping/src/zip.ts` +
`package.ts`, `packages/core` (prefabData, entityCommands, exportCommands,
componentCommands, prefabCommands, validate, schema, agentSkillContent,
create), `apps/editor/src/keybinds.ts` + `store.ts`.

No cross-feature interaction bugs found. The riskiest interactions were
checked explicitly and are correct by construction:

- **Capture gate × pause × tab-pause**: `shouldCaptureGameKey` returns false
  while paused, so the L-067 auto-pause on hiding the Game tab also releases
  the keyboard for Code-panel editing; keyup always releases mapped codes
  (no stuck keys when focus leaves mid-hold); exports keep full capture via
  ambient `<body>` focus, and the exported player's fullscreen button blurs
  itself so it never becomes lingering "chrome" focus that kills input.
- **Audio suspend × autoplay unlock**: `WebAudioPlayer.suspend()` only
  suspends a *running* context (`ctxSuspendedByHost`), so the unlock-gesture
  path can't be defeated by pause/resume; the music `<audio>` element is
  paused explicitly because context suspension alone lets it drift ahead.
- **Batch-pool destroy fix (94033b5)**: `app.destroy({ removeView: true },
  { children: true })` — the L-116 root cause (Pixi v8 `true` ⇒
  `releaseGlobalResources` destroying the module-global batch pool under
  other live renderers) is real, mechanically repro'd in the ledger, and the
  fix is the minimal correct one. Stress evidence: 6/40 sessions crashed
  before, 0/250 after. The `clearGraphics` guards remain as an independent
  belt-and-suspenders layer.
- **Zip mode bits (4cd2ade)**: central-directory external attrs now carry
  real `lstat` modes for every entry (UNIX made-by on all entries), symlinks
  unchanged, `(mode << 16) >>> 0` handles the sign bit. Verified live (§3).
- **Undo serialization** (`queueHistoryOp`) chains keyboard/toolbar/menu
  undo-redo through one promise per store, complementing the server-side
  per-project mutex; a rejection doesn't wedge the chain.
- **Prefab-override correctness set** (same-value equality guard L-032,
  no-op reparent guard L-013, rename uniqueness L-011, createPrefab relink
  warning L-012, broken-marker gating SH-1/L-119) is internally consistent —
  the no-op guards sit *before* the detach policy, which is the actual bug
  class they close.

Minor observations (no action required for 0.14.0), see §7.

## 3. Live integration probes — ALL PASS (one nuance)

- **(a) Full editor session** (scratch ember-horde, :5360, headed
  chromium/swiftshader): menu bar renders and is fully keyboard-drivable
  (open/arrow/Escape-with-focus-return); Hierarchy arrow-key nav +
  focus-reveal row actions; Delete → ConfirmDialog → **Space activates the
  focused confirm button** (fa476d6); Play → canvas click → **WASD moves the
  player** (L-002/L-122) and menus still work afterwards (capture release);
  Code tab auto-pauses (orange pause chip) → edit → ⌘S → "Hot-reloaded …" →
  Game tab **auto-resumes** without stopping the run; 10 rapid ⌘Z then 10
  rapid ⇧⌘Z walk 18→15→18 exactly (serialization holds under mashing);
  File → checkpoint → change → Review changes → Restore returns state.
  **0 console errors / 0 page errors across the whole session.**
- **(b) Upgrade path** (genuine `git archive 6582e4c` ember-horde, :5361):
  opens with zero errors and is **byte-non-destructive** (hash-listing
  before/after identical); a seeded v0.13-shape dockview layout with the
  three headless `activeView:null` groups **self-heals** (ensureGroupsActive,
  0 watermarks, no blank workspace); three corrupted-layout seeds all fall
  back to the default layout; fresh undo/redo/checkpoint/restore on the v13
  project produces clean `.hearth` history/journal alongside the untouched
  pre-wave `agent-config.json`.
- **(c) MCP boot** (built dist, stdio initialize + tools/list): **72 tools =
  70 command tools + `screenshot` + `get_agent_instructions`**;
  `set_entity_enabled` / `set_entity_tags` present; `get_agent_instructions`
  references the hearth skill.
- **(d) Packaged Electron app**: `npm run app:bundle` + `HEARTH_SMOKE=1`
  self-test exit 0.
- **(e) Desktop export unzip-launch (L-117 sequence)**: scaffolded template
  project → CLI desktop export darwin-arm64 → system `unzip` → **.app
  launches** (process confirmed, then killed); main executable mode 755
  after round-trip; `codesign -v` passes (ad-hoc). Web export zip has
  `index.html` at root.
- **(f) Narrow widths**: 1280 and 1024 — zero horizontal overflow, transport
  visible, menu bar functional at 1024; scene-picker shrink-cap in place
  (ellipsis path exists but wasn't exercised by the short scene name).
- **(g) Carried visual checklists**: Launcher 2/2 (4-tile row no clipping at
  1280/1024 incl. the "Four-way walking, camera follow." card; ember
  selected treatment correct). Export dialog 6/7 clean PASS (ember active
  row, segmented lock while building, platform grid, signing shields,
  badges, long-path wraps gracefully). Item 1 (reopen-after-completion):
  **desktop job results persist on reopen — PASS**; web-pane results do
  not — **verified NOT a regression** (WebPane's `done` is local component
  state, byte-identical code at 6582e4c; the Wave J persistence fix was for
  the store-backed desktop job). Recorded as polish for M (§7).

## 4. Ledger triage — HONEST

Sampled well beyond ten dispositions across categories (L-001, L-002, L-024,
L-053, L-108, L-111/112, L-116–L-122 fixed; L-009, L-027, L-055, L-113
by-design; all 10 deferred-M): fix commits exist and match their claims;
by-design entries carry live-verification or first-principles reasoning
(L-113's root/position-exclusion investigation and L-116's round-2
batch-pool forensics are exemplary). The T13 re-audits independently
re-drove the high-severity set and surfaced the late tail (SHELL-1 → 94033b5,
SH-1 → bbe62cf, L-117 → 4cd2ade, PANELS-1 → d0e3688, L-121/122 → fa476d6),
all of which landed and are covered by the probes above.

**Deferred-M list is release-acceptable.** The ten deferrals are selection-
model/multi-select rework, hierarchy tree filter, hover-idiom unification,
tilemap grid direct-manipulation editor, runtime perf profiling, one stale
finding, SVG loadParser hint, an unreproducible synthetic-keydown race, and
two real-but-scoped items worth naming:

- **L-114** — native Electron window-close/Cmd+Q bypasses the
  unsaved-scripts confirm (silent discard of the one non-autosave surface).
  Pre-existing-class data-loss edge, needs a main-process close-intercept
  design; right call to defer, should be early in Wave M.
- **L-115** — cross-process history-write lock (editor mutex + store chain
  landed; an external `hearth undo` can still race). Pre-existing; fine.

## 5. Release mechanics dry-run — PASS (executed at HEAD in a worktree)

Note for the record: the first dry-run accidentally ran at the wave BASE
(6582e4c) and was fully redone at d599b1b; only the HEAD results below count.

- **Version constants: exactly 3** — `packages/core/src/schema/project.ts:9`
  (`HEARTH_VERSION`), `packages/mcp-server/src/server.ts:26`
  (`SERVER_VERSION`), `packages/cli/src/program.ts:50` (`VERSION`).
  Independently re-grepped at HEAD: no fourth constant; SKILL.md and the
  fixtures embed no version string.
- **10 package.jsons** (root, apps/editor, packages/{cli,core,examples,
  mcp-server,playtest,runtime,shipping,templates}) + lockfile (11 version
  entries change on `npm install`).
- **Regen deterministic**: dists rebuilt BEFORE regen; first regen at the
  bumped version touches **39 files** (13 projects × AGENTS.md, hearth.json,
  .hearth/agent-config.json — version strings only); **double-regen
  byte-identical**.
- **13 skill fixtures** (10 examples + 3 templates `.claude/skills/hearth/
  SKILL.md`) — verified independently `md5`-identical to canonical
  `skills/hearth/SKILL.md`; versionless, so the bump doesn't touch them;
  `scripts/sync-agent-skill.mjs` is deliberately separate from regen;
  **agent-skill drift tests 9/9 green** at the bumped state.
- **Build order** (verified directly): `build:packages` = core → runtime →
  playtest → shipping → templates → cli → mcp-server; **shipping AND
  templates before cli** (the v0.13.0 f6f29df lesson intact); release.yml
  uses it; ci.yml has BOTH examples and templates regen clean-tree gates.
- **Counts**: repo is consistently **71 commands / 70 command tools / 72
  total MCP tools** everywhere current-facing (README:33/:110, docs/mcp.md,
  docs/agents.md, SKILL.md; roadmap "grew X→Y" lines are historical).
- Full suite + typecheck green at the bumped `0.14.0-dry` state.

## 6. MANDATORY release-commit items (T15) — process, not code fixes

1. **README.md:150** — "Hearth is at **v0.13.0**, a developer preview" is
   hardcoded prose; bump manually (not covered by constants or regen).
2. **docs/roadmap.md:3** ("v0.13 is the current milestone…") + add the Wave L
   "Shipped in v0.14.0" section (registry 71 unchanged; MCP command tools
   68 → 70, total 70 → 72, `set_entity_enabled`/`set_entity_tags`).
3. **Website sync must move counts to 71 / 70 / 72** (v0.13 site says 71/68) —
   per the parity-closure note this is a hard requirement of the sync step.
   Positioning per Jake steer 8: "AI-native game engine" language.
4. Standard T15 sequence (all verified working): bump 3 constants + 10
   package.jsons + `npm install`; rebuild dists BEFORE regen; regen
   examples+templates in the SAME commit (expect the 39 files);
   double-regen check; delete `.waveL-scratch-shell/`; tag; watch release
   run (11 assets) via `gh run view --json conclusion`; push via
   `direnv exec . git push`.

## 7. Non-blocking notes (recommend recording for Wave M / L2)

- **Web-export reopen persistence** — desktop job results persist across
  dialog reopen, web results don't (local state, unchanged since v0.13).
  Polish: back the web result by the store like the desktop job.
- **`appBundleId: com.hearth.<slug>`** (package.ts) — good fix; note Apple
  formally allows only alphanumerics/hyphens/periods in bundle ids, so a
  slug with underscores would be nonconforming when real signing/notarization
  arrives (Wave M signing docs already planned). Verified fine ad-hoc.
- **`fileProtocolBootMessage.toString()` inlining** — elegant no-drift trick;
  fragile only if core's dist ever gains minification (would mangle the
  name). Worth a one-line comment guard or a build assumption note.
- **SVG sprites render as fallback rectangles in play mode** (Pixi can't
  infer the loader from extension-less `/api/file` URLs) — already
  deferred-M in the ledger (loadParser hint); reconfirmed live, cosmetic.
- **Dev-server session cache vs same-path project replacement** — three T13
  re-auditors independently hit stale sessions after `rm -rf`+`cp` at the
  same absolute path (journal-less fresh copy reads as "not ahead").
  Dev/test-harness-only footgun, but it cost real audit time twice; worth a
  Wave M fix (treat `diskSeq === null` with a previously-seen seq as ahead).
- **No `hearthVersion` advance when editing older projects** — open/edit is
  fully non-destructive (good), but the stamp never moves; belongs to Wave
  M's format-stability/migrations charter.
- **restartPlay from a menu while the Game tab is hidden** would clear the
  tab-pause and let the run advance unseen — theoretical (restart badge
  lives on the Game surface); noting for completeness.
- Ledger hygiene: L-117/L-118/L-121/L-122 dispositions lack inline commit
  hashes (the commits exist: 4cd2ade, fa476d6, etc.).

## 8. Release-notes summary (for the v0.14.0 tag + website)

**Wave L — Tightening.** No new engine features; 129 commits making the
editor *work properly everywhere*, front-loading workflows, and unifying the
design language — driven by a 16-surface live audit (121-entry ledger, 100
fixed, every entry dispositioned) and closed by 6 independent re-audits.

- **Every control works**: game keyboard capture is scoped to the game
  (editor dialogs/buttons/fields never lose Escape/Enter/Space again); WASD
  and all axis-only bindings work in play mode *and* exports; Space
  activates focused buttons app-wide; clicking the canvas arms game input
  and releases it cleanly afterwards.
- **The iteration loop got tighter**: switching to Code auto-pauses the run
  (simulation *and* audio freeze in place) and switching back auto-resumes;
  hot-reload never tears the session down; undo/redo is burst-safe,
  serialized, and narrates what it reverted; checkpoints refresh the
  Changes panel instantly; console errors deep-link to the failing line and
  the unread badge respects your scroll position.
- **Shipping is honest**: desktop export zips now preserve executable bits —
  unzip-and-launch just works (this was silently broken for every shipped
  zip); per-game macOS bundle ids; folder web builds explain the `file://`
  limitation instead of failing cryptically; window icons accept sprite or
  tile assets and are validated before export.
- **One deliberate product**: a real File/Edit/View/Help application menu
  (native on macOS in the desktop app, slim in-window strip in the browser),
  a minimal toolbar (transport, scene picker, undo/redo arrows) that holds
  up at 1024px, a hand-authored icon set, a keyboard-accessible tooltip
  primitive replacing every native `title`, shared Menu/Button primitives,
  a tokenized type scale with Bricolage Grotesque brand moments, and real
  empty states in every panel. No raw-JSON Inspector fields remain.
- **Prefab trust**: same-value edits no longer record overrides, no-op
  reparents no longer detach instances, renames stay unique, saving an
  instance as a new prefab warns before re-linking, and broken markers are
  repaired instead of masquerading as live instances.
- **Agents are first-class**: full editor↔agent capability parity (new
  `set_entity_enabled`/`set_entity_tags` close the last gaps — 71 commands,
  70 MCP command tools, 72 tools total), and every project now ships a
  fact-checked best-practices skill (`.claude/skills/hearth/SKILL.md`,
  drift-gated against the canonical copy) plus a pointer in AGENTS.md and
  `get_agent_instructions` — agents don't just *have* the tools, they know
  the house playbook.
- **Stability**: the intermittent editor crash ("Cannot read properties of
  null (reading 'clear')") was root-caused to Pixi's global batch pool being
  released by scene-view teardown and fixed for good (0 crashes in 250
  stress sessions); saved dockview layouts from earlier versions self-heal;
  v0.13 projects open byte-non-destructively.

Upgrade note: no format changes; v0.13 projects open unchanged. Counts:
71 commands / 70 MCP command tools / 72 MCP tools total.
