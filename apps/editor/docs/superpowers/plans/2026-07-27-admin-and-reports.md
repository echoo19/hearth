# Admin Access and Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the tester be put into any part of a game the game itself names, record honestly how it got there, and end with a plan of action the person picks from and approves into a new conversation.

**Architecture:** Two optional calls on the probe contract (`listStates`, `enterState`) whose meaning the GAME defines. Provenance recorded per observation. A prose report written at session end, ending in separately selectable proposals. Approving the ones you want opens a new conversation carrying exactly those and their frames.

**The loop this builds:** you trigger a playtest, the tester plays, the report comes back with a plan of action, you tick what you want, and approving starts an agent working on it. Nothing reaches the agent until you send it.

**Tech Stack:** TypeScript, `@hearth/probe-core`, `@hearth/adapter-web`, React, Zustand, vitest.

## THE GOVERNING CONSTRAINT

Read `docs/superpowers/specs/2026-07-27-admin-and-reports-design.md` in full before starting. Its first section is not context, it is the acceptance criterion for every task here.

Hearth must support any and all games people want to make with agents, and must never lock the agent into a mold, a direction, or an assumption. Using Hearth should be no different from running a coding agent in a terminal and building a game from nothing.

Concretely, in this plan:

- **Hearth never defines the shape of the game's world.** The game names its own states. Hearth asks "where can you put yourself?" and never learns what the answer means.
- If a decision would make one kind of game easier to build and another harder, **the decision is wrong.** 3D, RTS, MOBA, RPG and management sims must all be first-class.
- **Every capability is optional.** A game that declares nothing must work completely. Absence is a sentence in the report, never a silent degradation and never a failure.
- Do not add a third violation. `NavGrid` and `ProbeEntity` already assume 2D and are the reason the old bot fleet only worked for platformers.

If you find yourself writing the word "level", "scene", "stage" or "tile" into a Hearth type, stop. That is the mold.

## Global Constraints

- No em dashes in any text added, comments or copy. None.
- Must work on macOS and Windows. Use `node:path` for every path.
- No AI attribution in commits. Plain human voice, short imperative subject, no emoji.
- Never run two concurrent vitest runs. Never `git add -A`.
- Server changes need a dev-server restart, not HMR. Port 5173.
- Depends on the Private Tester (`2026-07-27-private-tester.md`) being complete. Read what it built before changing it.

## Copy and UI quality bars

These are deliverables, not polish.

**Every user-visible string** you write or touch goes through the `humanizer` skill before you commit it. Invoke it; do not approximate it with "write plainly". It catches rhythm, which inline instructions do not: watch for a run of sentences that all open the same way, headings built to a repeated template, and rule-of-three padding. The report the person reads is the biggest body of prose in this feature and it must not read as machine-written.

**Every surface** you build goes through the `impeccable` skill, invoked before you write the component, plus its `audit` command afterward. Apply its AI slop test honestly: if someone could look at this and say "AI made that", it has failed. Specifically banned there and here: side-stripe borders as accents, gradient text, decorative glassmorphism, identical card grids, and a tiny uppercase tracked eyebrow over every section. Match the app's existing quiet, restrained voice. Ember only where it earns its place.

No raw JSON anywhere a person can see it. No bare enum values rendered as-is.

---

### Task 1: The state capability, contract first

**Files:**
- Modify: `packages/probe-core/src/contract.ts`
- Test: `packages/probe-core/tests/stateCapability.test.ts`

**Interfaces:**
- Produces: `ProbeState` (`{id: string, label: string, detail?: string}`), `capabilities.senses.states: boolean`, and optional `listStates?(): Promise<ProbeState[]>` / `enterState?(id: string): Promise<void>` on `GameUnderTest`. Tasks 2, 4 and 5 consume these.

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeStates } from '../src/contract';

describe('normalizeStates', () => {
  it('keeps whatever the game named, without interpreting it', () => {
    // The point of the whole feature: these are a MOBA's states, and nothing
    // here knows what a lane is.
    const raw = [{ id: 'mid-6min', label: 'Mid lane, six minutes in' }];
    expect(normalizeStates(raw)).toEqual([{ id: 'mid-6min', label: 'Mid lane, six minutes in' }]);
  });

  it('accepts a state with only an id, and labels it with the id', () => {
    expect(normalizeStates([{ id: 'ch3' }])).toEqual([{ id: 'ch3', label: 'ch3' }]);
  });

  it('drops entries with no usable id rather than inventing one', () => {
    expect(normalizeStates([{ label: 'nameless' }, { id: '' }, { id: 'ok' }])).toEqual([
      { id: 'ok', label: 'ok' },
    ]);
  });

  it('returns nothing for a game that declares nothing', () => {
    // Declaring nothing is a first-class outcome, not an error.
    expect(normalizeStates(undefined)).toEqual([]);
    expect(normalizeStates(null)).toEqual([]);
    expect(normalizeStates('nonsense')).toEqual([]);
  });

  it('carries an optional detail through untouched', () => {
    expect(normalizeStates([{ id: 'y3', label: 'Year three', detail: 'budget already in deficit' }])[0].detail)
      .toBe('budget already in deficit');
  });
});
```

- [x] **Step 2: Run it and watch it fail.** Run: `cd packages/probe-core && npx vitest run tests/stateCapability.test.ts`

- [x] **Step 3: Implement.** Add `ProbeState`, the `states` sense, the two optional methods, and `normalizeStates`. Defensive parsing throughout: this reads whatever a game wrote and must never throw on it. Document in the type's comment that Hearth does not interpret `id` or `label`, with a one-line note on why.

- [x] **Step 4: Run the test.** Expected: PASS, 5 tests.

- [x] **Step 5: Commit**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
git add packages/probe-core/src/contract.ts packages/probe-core/tests/stateCapability.test.ts
git commit -m "Let a game name the states it can be put into"
```

---

### Task 2: The web adapter and the shim

**Files:**
- Modify: `packages/adapter-web/src/adapter.ts`, `packages/adapter-web/shim/probe-shim.js`, `packages/adapter-web/docs/probe-shim.md`
- Test: `packages/adapter-web/tests/states.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `openWebGame` returning a game whose `listStates`/`enterState` bridge to `window.__hearthProbe.listStates()` / `.enterState(id)` when the page provides them, and whose `capabilities.senses.states` is true only when it really does.

- [x] **Step 1: Write the failing test** covering: a page exposing both hooks reports `states: true` and round-trips the list; a page exposing neither reports `states: false` and leaves both methods undefined; a page exposing `listStates` but not `enterState` reports `states: false`, since a list you cannot act on is not the capability.

- [x] **Step 2: Run it and watch it fail.**

- [x] **Step 3: Implement the bridge and extend the reference shim.** The shim's header documents every hook and is what game authors read; add the two, with an example that is deliberately NOT a platformer level list, so nobody reads the docs and concludes this is for levels.

- [x] **Step 4: Run the test.** Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/adapter-web packages/probe-core
git commit -m "Bridge the state hooks through the web adapter"
```

---

### Task 3: Provenance on every observation

**Files:**
- Modify: `apps/editor/server/tester/types.ts`, `apps/editor/server/tester/memory.ts`
- Test: `apps/editor/tests/testerProvenance.test.ts`

**Interfaces:**
- Consumes: the Private Tester's `TesterObservation`.
- Produces: `TesterObservation.reached: 'played' | 'placed'`. Tasks 4, 5 and 6 all read it.

Notes written before this task have no `reached`. Treat a missing value as `'played'`: the tester could not be placed anywhere when they were written, so that is the true answer rather than a guess.

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { observationReach } from '../server/tester/types';

describe('observationReach', () => {
  it('reads what the observation recorded', () => {
    expect(observationReach({ frame: 1, text: 'x', reached: 'placed' })).toBe('placed');
    expect(observationReach({ frame: 1, text: 'x', reached: 'played' })).toBe('played');
  });

  it('treats an older note with no provenance as played', () => {
    // Sessions written before this existed could not be placed anywhere, so
    // "played" is the fact, not a default.
    expect(observationReach({ frame: 1, text: 'x' })).toBe('played');
  });

  it('never guesses from anything else in the observation', () => {
    expect(observationReach({ frame: 99, text: 'I was teleported to the boss', reached: 'played' })).toBe('played');
  });
});
```

- [x] **Step 2: Run it and watch it fail.**

- [x] **Step 3: Implement.** Add the field and the reader.

- [x] **Step 4: Run the test.** Expected: PASS, 3 tests.

- [x] **Step 5: Commit**

```bash
git add apps/editor/server/tester apps/editor/tests/testerProvenance.test.ts
git commit -m "Record how the tester reached each thing it saw"
```

---

### Task 4: The tester uses the states

**Files:**
- Modify: `apps/editor/server/tester/session.ts`, `apps/editor/server/tester/prompt.ts`
- Test: `apps/editor/tests/testerStates.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: a session that offers the declared states to the tester, applies `enterState` when it asks, and stamps every subsequent observation `'placed'` until the game is reset.

- [x] **Step 1: Write the failing test** covering: with no states declared the prompt never mentions them and every observation is `'played'`; with states declared the prompt lists them by label; choosing one calls `enterState` with that id; observations after a placement are `'placed'`; observations before it stay `'played'`; and an `enterState` that throws is recorded and does not kill the session.

- [x] **Step 2: Run it and watch it fail.**

- [x] **Step 3: Implement.** The prompt must present states as an option, never an instruction: a tester told to skip ahead will stop playing the opening, which is the part a first session is most valuable for.

- [x] **Step 4: Run the test.** Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/editor/server/tester apps/editor/tests/testerStates.test.ts
git commit -m "Let the tester ask to be put somewhere"
```

---

### Task 5: The report, and getting it to the agent

**Files:**
- Create: `apps/editor/server/tester/report.ts`
- Modify: `apps/editor/server/projectServer.ts`, `apps/editor/server/ws.ts`
- Test: `apps/editor/tests/testerReport.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: `renderReport(note: TesterNote): string`, prose, and delivery of that prose into the dev agent's context when a session ends. Task 6 renders the same note for the person.

`renderReport` is pure and is where the honesty rules live, so they are testable without a model or a browser:

- A `placed` observation must be marked as such in the text, not in a footnote.
- If any observation is `placed`, the report says plainly that those findings say nothing about whether a player can reach that content.
- The required `regression` line always appears, including when nothing got worse.
- Prose, not a JSON blob. The agent is another reader, not a parser.

- [x] **Step 1: Write the failing test** covering each of the four rules above, plus: a session with no placed observations carries no reachability caveat (do not warn about a thing that did not happen), and an empty observation list still produces a readable report.

- [x] **Step 2: Run it and watch it fail.**

- [x] **Step 3: Implement `renderReport`.** Then run the prose through the `humanizer` skill and fix what it finds before moving on. This text is read by a person every session.

- [x] **Step 4: Add the plan of action.**

`proposalsFrom(note: TesterNote): Proposal[]`, where a `Proposal` is `{id, kind: 'bug' | 'suggestion', text, evidence: number[], reached: 'played' | 'placed'}`. `evidence` holds frame indices.

Four rules, each of which needs a test:

1. **It may be empty.** A session where nothing is worth changing produces no proposals. A tester that fills this list every time will invent work, and a list of changes is the most flattering possible output because it always looks like value.
2. **`bug` and `suggestion` are separate kinds and never merged.** The tester witnessed a crash; it did not witness the jump being unfair. It cannot judge fun at all, so the weaker kind must never be presented as the stronger.
3. **A proposal drawn from a `placed` observation is marked `placed`.** Approving it must not silently import the premise that a player can reach that content.
4. **Proposals come from observations, not from a catalogue.** Nothing may be generated that could have been written without playing this specific game.

- [x] **Step 5: Run the test.** Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/editor/server apps/editor/tests/testerReport.test.ts
git commit -m "Write the session report and its plan of action"
```

**Deliberately NOT in this task: pushing the report at the agent.** An earlier draft did that on session end. It is replaced by Task 7's approval step, because an agent that receives every report unprompted can act on findings the person never approved. Nothing reaches the agent until the person sends it.

---

### Task 6: View report

**Files:**
- Create: `apps/editor/src/components/tester/ReportView.tsx`
- Modify: `apps/editor/src/components/tester/TesterHistory.tsx`, `apps/editor/src/styles/app/tester.css`
- Test: `apps/editor/tests/reportView.test.tsx`

**Interfaces:**
- Consumes: Task 5's note shape.
- Produces: a "View report" control on each session that opens the full report.

**Invoke `impeccable` before writing this component.** The report is the densest text surface in the app and the easiest place to produce something that looks generated. Requirements:

- Played and placed observations are visually distinguishable at a glance, without the reader learning a legend.
- The reachability caveat, when present, is impossible to miss and is not styled as a warning banner cliché.
- Frames are shown beside the claims they anchor, since a claim with a frame is evidence and one without is an assertion.
- Keyboard reachable, escapable, focus returned on close.
- No raw JSON, no bare enum values, no side-stripe accents, no card grid.

- [x] **Step 1: Write the failing test** covering: the control appears per session; opening renders the report; placed observations are marked; the caveat appears only when something was placed; Escape closes and returns focus.

- [x] **Step 2: Run it and watch it fail.**

- [x] **Step 3: Implement.**

- [x] **Step 4: Run the test.** Expected: PASS.

- [x] **Step 5: Verify in the browser.** Check `document.visibilityState` is `visible` FIRST; a hidden tab freezes rAF and IntersectionObserver and a working reveal will look broken.

- [x] **Step 6: Commit**

```bash
git add apps/editor/src apps/editor/tests/reportView.test.tsx
git commit -m "Add the report view"
```

---

### Task 7: Pick, approve, and start work

**Files:**
- Create: `apps/editor/src/components/tester/PlanOfAction.tsx`
- Modify: `apps/editor/src/components/tester/ReportView.tsx`, `apps/editor/src/store.ts`, `apps/editor/src/api.ts`, `apps/editor/server/projectServer.ts`
- Test: `apps/editor/tests/planOfAction.test.tsx`, `apps/editor/tests/approveProposals.test.ts`

**Interfaces:**
- Consumes: `Proposal[]` from Task 5, the report view from Task 6.
- Produces: selection state, and an approve action that opens a NEW conversation seeded with the selected proposals and their frames.

This is the step the whole feature exists for. The tester proposes, the person disposes, and only then does anything happen.

**Invoke `impeccable` before writing the component.** A list of checkboxes is the easiest thing in this codebase to make look generated. It is a decision surface: the person is committing work to an agent, so the weight of that has to be legible without being heavy. Bugs and suggestions must be visually distinct because they carry different confidence, and a `placed` proposal must show its caveat at the point of decision, not somewhere the reader has already scrolled past.

- [x] **Step 1: Write the failing tests**

Cover: nothing is selected by default, so approval is always an explicit act; the approve control is disabled with nothing ticked; an empty plan of action renders as a plain statement that nothing needs changing and NOT as an error or an empty-state apology; bugs and suggestions are grouped and labelled; a `placed` proposal shows its provenance in the row itself; approving calls the action with exactly the ticked ids and no others; and approving opens a new conversation rather than sending into the current one.

- [x] **Step 2: Run them and watch them fail.**

- [x] **Step 3: Implement selection and the approve action.**

The seed sent to the new conversation carries the selected proposals and their frames, and nothing else. Unselected proposals must not appear in it: a proposal in the agent's context is a proposal it may act on, which would make the checkboxes decorative.

The new conversation is an ordinary conversation. No special mode, no privileged status. Approval starts work; it does not hand over control.

- [x] **Step 4: Run the tests.** Expected: PASS.

- [x] **Step 5: Verify the whole loop in the browser.** Trigger a playtest, watch it play, read the report, tick two of three proposals, approve, and confirm a new conversation opens carrying exactly those two. Check `document.visibilityState` is `visible` first.

- [x] **Step 6: Commit**

```bash
git add apps/editor/src apps/editor/server apps/editor/tests
git commit -m "Let the person approve a plan of action into a new conversation"
```

---

### Task 8: Verification, copy pass, design pass

- [x] **Step 1: Typecheck everything.**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
npx tsc --noEmit -p apps/editor/tsconfig.json
for p in probe-core adapter-web probe-tools; do npx tsc --noEmit -p packages/$p/tsconfig.json; done
```

- [x] **Step 2: Run both suites, in sequence, never at once.**

- [x] **Step 3: The mold test.** Grep every type and public function you added for the words `level`, `scene`, `stage`, `tile`, `world`, `map`. Each hit is a place Hearth may have started assuming what a game is. Justify it or remove it, and report what you found either way.

- [x] **Step 4: The no-declaration test.** Run a full session against a game that declares NO states, and confirm it works completely, the report says states were unavailable, and nothing reads as a failure. A game that cooperates with nothing must remain first-class.

- [x] **Step 5: The provenance test, end to end.** Against a game that DOES declare states: have the tester place itself somewhere, then confirm the note marks those observations `placed`, the report carries the reachability caveat, and the view shows it.

- [x] **Step 6: The empty-plan test.** Run a session against a game with nothing wrong with it and confirm the plan of action comes back empty, that this reads as a legitimate result rather than a failed run, and that the approve control is simply not offered. A tester that always finds something to fix is manufacturing work, and this is the check that catches it.

- [x] **Step 7: Humanizer pass.** Invoke the `humanizer` skill on every user-visible string this plan added: the rendered report, the proposal text, the view's labels and empty states, and any copy in the shim docs. The proposals are the highest-risk prose in the feature, since they are generated per session and read at a moment of decision. Fix what it finds and report the tells it caught.

- [x] **Step 8: Design pass.** Invoke `impeccable` and run its `audit` over the report view: contrast, focus states, heading order, keyboard reachability, and 320px through 1440px. Then apply the AI slop test honestly and say whether it passes.
