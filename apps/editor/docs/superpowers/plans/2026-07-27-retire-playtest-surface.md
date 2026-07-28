# Retire the Playtest Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bot playtesting a purely passive capability the agent can use, with no user-facing surface in the app.

**Architecture:** Delete the client surface (button, screen, rail, and their store state and routes), delete the server machinery that existed only to feed that surface, and keep the probe packages and the `hearth-probe` CLI exactly as they are. The agent already reaches playtesting through the CLI on its PATH, so nothing it can do today stops working.

**Tech Stack:** TypeScript, React, Zustand, Vite plugin server, vitest.

## Global Constraints

- No em dashes in any text added, in comments or user-visible copy.
- Must work on macOS and Windows.
- No AI attribution in commits. Plain human voice, short imperative subject, no emoji.
- Never run two concurrent vitest runs.
- Never `git add -A`. Stage the files the task names.
- Server-side changes need a dev-server restart, not HMR. The dev server must run on port 5173.
- Do not touch `packages/probe-core`, `packages/adapter-web` or `packages/probe-tools`. The capability survives; only its surface goes.
- Do not delete `apps/editor/server/probeStream.ts` or `OpenWebGameOptions.onFrame`. The Private Tester reuses both.

## What survives, and why it must not be touched

The `hearth-probe` CLI, the probe packages, the shim launcher in `hearthShim.ts`, and the paragraph in `agentFacts.ts` that tells the agent the command exists. That IS the passive capability. If a task finds itself removing the agent's ability to playtest, it has misread the plan.

---

### Task 1: Remove the playtest screen and the evidence rail

**Files:**
- Delete: `src/components/playtest/PlaytestScreen.tsx`, `src/components/playtest/playtestPanels.ts`, `src/components/playtest/usePlaytest.ts`
- Delete: `src/components/evidence/EvidenceRail.tsx`, `src/components/evidence/evidenceRows.ts`
- Delete: `src/styles/app/playtest.css`, `src/styles/app/evidence.css`
- Delete: `tests/playtesters.test.ts`, `tests/playtestSurface.test.ts`, `tests/evidenceRows.test.ts`, `tests/evidenceHistory.test.ts`
- Modify: `src/styles.css` (drop the two `@import` lines)
- Modify: `src/App.tsx` (drop the `playtest` screen route)
- Modify: `src/components/game/PaneStack.tsx`, `src/components/game/GamePane.tsx` (drop the rail)
- Modify: `src/menu/appMenu.ts` (drop the `evidence` menu item)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a build with no playtest or evidence components. Task 2 relies on `openScreen('playtest')` no longer being reachable from any component.

- [x] **Step 1: Find every reference before deleting anything**

```bash
cd apps/editor
rg -n --text "PlaytestScreen|EvidenceRail|evidenceRows|playtestPanels|usePlaytest|evidenceOpen" src/ tests/
```

Record the list. Every hit outside the deleted files is an edit this task owns.

- [x] **Step 2: Delete the components, styles and their tests**

```bash
cd apps/editor
git rm -r src/components/playtest src/components/evidence
git rm src/styles/app/playtest.css src/styles/app/evidence.css
git rm tests/playtesters.test.ts tests/playtestSurface.test.ts tests/evidenceRows.test.ts tests/evidenceHistory.test.ts
```

- [x] **Step 3: Remove the two `@import` lines from `src/styles.css`**

Delete exactly these lines:

```css
@import './styles/app/playtest.css';
@import './styles/app/evidence.css';
```

- [x] **Step 4: Remove the screen route, the rail and the menu item**

In `src/App.tsx`, remove the `PlaytestScreen` import and its branch in the screen switch. In `PaneStack.tsx` and `GamePane.tsx`, remove the `EvidenceRail` import and its JSX. In `src/menu/appMenu.ts`, remove the item whose `id` is `'evidence'`.

- [x] **Step 5: Typecheck**

Run: `cd apps/editor && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. Any error naming a deleted symbol is a reference Step 1 missed; fix it here.

- [x] **Step 6: Run the suite**

Run: `cd apps/editor && npx vitest run`
Expected: PASS. Tests that fail only because they assert a deleted surface belong to Task 2; if one fails here, note it and leave it.

- [x] **Step 7: Commit**

```bash
cd apps/editor
git add -u src/ tests/
git commit -m "Remove the playtest screen and evidence rail"
```

---

### Task 2: Remove the Playtest button and the playtest store state

**Files:**
- Modify: `src/components/game/CapabilityStrip.tsx`
- Modify: `src/store.ts`
- Modify: `src/api.ts`
- Modify: `src/types.ts`
- Modify: `tests/paneColumn.test.tsx`, `tests/homeFlow.test.ts` (drop mocks for deleted api functions)

**Interfaces:**
- Consumes: Task 1's deletions.
- Produces: an `AppState` with no `sweep`, `playtest`, `evidence` or `evidenceOpen` keys, and no `startSweep`, `refreshPlaytest`, `refreshEvidence` or `setEvidenceOpen` actions. Task 3 relies on `apiStartSweep`, `apiPlaytestView` and `apiEvidenceHistory` no longer existing.

- [ ] **Step 1: Reduce `CapabilityStrip.tsx` to the Play control**

Delete `PlaytestButton`, `playtestLabel` and `playtestBlockReason` entirely. The strip keeps only the `IconButton` with `icon="play"`. Rewrite the file's header comment so it describes one action rather than two; the existing comment claims "the pane's two actions" and would be a lie.

- [ ] **Step 2: Remove the store state and actions**

In `src/store.ts` delete: the `sweep`, `playtest`, `evidence` and `evidenceOpen` fields from `AppState` and from every initial-state and reset object; the `startSweep`, `refreshPlaytest`, `refreshEvidence` and `setEvidenceOpen` actions and their interface declarations; the `mergeEvidence`, `unseenEvidence`, `applySweepProgress`, `plannedRuns` and `IDLE_SWEEP` helpers; the `MAX_EVIDENCE` constant; the `case 'evidence':` arm in `handleFrame`; and the `sweep:` line in the `refreshProbe` setter.

- [ ] **Step 3: Remove the client API functions**

In `src/api.ts` delete `apiStartSweep`, `apiPlaytestView`, `apiEvidenceHistory`, the `SweepStartResult` interface, and the now-unused `PlaytestView` and `EvidenceEvent` type imports.

In `src/types.ts` delete the `PlaytestView`, `PlaytestSweep`, `PlaytestPolicy` and `PlaytestRun` re-exports and the `EvidenceEvent` re-export, keeping `Finding` only if something still imports it (check with rg before deleting).

- [ ] **Step 4: Fix the test mocks**

`tests/homeFlow.test.ts` mocks `apiStartSweep` and `apiEvidenceHistory`; `tests/paneColumn.test.tsx` may reference the rail. Remove those mock entries and any assertion about a Playtest control.

- [ ] **Step 5: Typecheck, then run the suite**

```bash
cd apps/editor
npx tsc --noEmit -p tsconfig.json && npx vitest run
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
cd apps/editor
git add -u src/ tests/
git commit -m "Remove the Playtest button and its store state"
```

---

### Task 3: Remove the server machinery that only fed the surface

**Files:**
- Delete: `server/playtestView.ts`, `server/probeSweep.ts`, `tests/probeSweep.test.ts`
- Modify: `server/projectServer.ts` (drop the `/api/probe/sweep`, `/api/probe/playtesters` and `/api/probe/evidence` routes and their ctx methods, and the `setHearthHost` wiring)
- Modify: `server/ws.ts` (drop the evidence channel)
- Modify: `server/evidenceWatcher.ts` (delete the file if nothing imports it after this; otherwise keep only what does)
- Modify: `server/hearthShim.ts` (drop `setHearthHost`, `getHearthHost` and the `HEARTH_HOST` line)

**Interfaces:**
- Consumes: Task 2's removal of the client callers. No client code may still call these routes.
- Produces: a server with no playtest routes. `probeStream.ts` and its `ctx.probeBus` MUST still exist and still be attached; the Private Tester plan consumes them.

- [ ] **Step 1: Confirm nothing client-side still calls the routes**

```bash
cd apps/editor
rg -n --text "api/probe/(sweep|playtesters|evidence)" src/ server/
```

Expected: hits only in `server/projectServer.ts`. Anything in `src/` means Task 2 is incomplete; stop and finish it first.

- [ ] **Step 2: Delete the two server modules and their test**

```bash
cd apps/editor
git rm server/playtestView.ts server/probeSweep.ts tests/probeSweep.test.ts
```

- [ ] **Step 3: Remove the routes, the ctx methods and the host wiring**

In `server/projectServer.ts` remove the `'POST /api/probe/sweep'`, `'GET /api/probe/playtesters'` and `'GET /api/probe/evidence'` route cases; the `startProbeSweep`, `playtestView`, `evidenceHistory` and `sweepJob` ctx methods; the `EVIDENCE_HISTORY_MAX` constant; the `publishHost` block in `configureServer`; and every now-unused import from the deleted modules.

Keep `attachProbeStream(httpServer, ctx.probeBus)` and `EVIDENCE_MOUNT` / `serveMounted`. The CLI still writes `.hearth/evidence/`, and those files are still served.

In `server/hearthShim.ts` remove `hearthHost`, `setHearthHost`, `getHearthHost` and the `if (hearthHost !== null) next.HEARTH_HOST = hearthHost;` line from `hearthPtyEnv`. Restore that function's doc comment to describing PATH only.

- [ ] **Step 4: Remove the evidence channel from the socket**

In `server/ws.ts` remove the `startEvidenceWatcher` import, the `disposeEvidence` binding in `getChannel`, its call in `dispose`, and the `{ type: 'evidence'; events: EvidenceEvent[] }` arm of the frame union. Update the file's header comment, which currently documents `evidence` as one of the frame kinds.

- [ ] **Step 5: Delete `evidenceWatcher.ts` if it is now orphaned**

```bash
cd apps/editor
rg -n --text "evidenceWatcher" server/ src/ tests/
```

If the only hits are the file itself, `git rm server/evidenceWatcher.ts tests/evidenceWatcher.test.ts`. If `EVIDENCE_DIR` is still imported by `projectServer.ts` for the static mount, keep the file and delete only `startEvidenceWatcher`, `readEvidenceHistory` and `parseEvidenceLines`, trimming the header comment to match.

- [ ] **Step 6: Typecheck, then run the suite**

```bash
cd apps/editor
npx tsc --noEmit -p tsconfig.json && npx vitest run
```

Expected: both PASS.

- [ ] **Step 7: Restart the dev server and confirm the app still loads**

Server changes do not hot-reload. Restart it, then check the app returns 200 and the game pane renders with a Play control and no Playtest button.

- [ ] **Step 8: Commit**

```bash
cd apps/editor
git add -u server/ tests/
git commit -m "Remove the server routes that fed the playtest surface"
```

---

### Task 4: Correct the docs the website generates from

**Files:**
- Modify: `docs/playtesting.md`, `docs/probe-shim.md`, `docs/agents.md` (paths relative to the engine repo root; confirm with `rg -l` first)
- Modify: `apps/editor/server/agentFacts.ts`
- Test: `apps/editor/tests/agentFacts.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3. The docs must describe the app as it is after them.
- Produces: docs with no reference to a Playtest button, a Playtesters screen or an evidence rail. `hearth-website`'s `scripts/sync-docs.mjs` copies these verbatim, so an error here ships to the marketing site.

- [ ] **Step 1: Locate the generated docs**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
rg -ln --text "Playtesters|Press Playtest|evidence rail" docs/
```

- [ ] **Step 2: Rewrite the three docs**

Remove every reference to a Playtest button, a Playtesters screen, an evidence rail, or any in-app playtest UI. Keep the `hearth-probe` CLI documentation, the shim contract and the evidence file layout: all of that is still true and is how the agent uses the capability. Reframe playtesting as something the agent runs, not something the user operates.

`agents.md` additionally describes a "Skills fold with per-row dots and Manage skills…" which is a release behind. Correct it to what the working tree actually ships.

- [ ] **Step 3: Update `agentFacts.ts`**

The paragraph telling the agent about `hearth-probe sweep .` STAYS; that is the whole point. Remove only sentences that describe app surfaces the agent should tell the user to press. Check the file for "playtest evidence lands in .hearth/evidence/" and keep it, since that is still where it lands.

- [ ] **Step 4: Run the agent-facts test**

Run: `cd apps/editor && npx vitest run tests/agentFacts.test.ts`
Expected: PASS. If it asserts removed copy, update the assertion to the new text rather than deleting the test.

- [ ] **Step 5: Commit**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
git add docs/ apps/editor/server/agentFacts.ts apps/editor/tests/agentFacts.test.ts
git commit -m "Correct the docs for passive playtesting"
```

---

### Task 5: Full verification

**Files:** none modified unless a defect is found.

- [ ] **Step 1: Typecheck everything**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
npx tsc --noEmit -p apps/editor/tsconfig.json
for p in probe-core adapter-web probe-tools; do npx tsc --noEmit -p packages/$p/tsconfig.json; done
```

Expected: all PASS.

- [ ] **Step 2: Run every suite once, in sequence**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine/apps/editor && npx vitest run
cd /Users/jakekang/projects/hearth/hearth-engine && npx vitest run
```

Never both at once. Expected: PASS.

- [ ] **Step 3: Confirm the capability still works from a shell**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
node packages/probe-tools/dist/cli.js sweep packages/examples/mini-platformer
```

Expected: a sweep runs and writes `.hearth/evidence/`. If the CLI is not built, build it first. This is the acceptance test for the whole plan: the agent's capability is intact while the surface is gone.

- [ ] **Step 4: Confirm the surface is gone in the running app**

Restart the dev server on port 5173. Open a project with a game. Expected: a Play control and no Playtest button, no Playtests rail below the pane, and no way to reach a Playtesters screen.
