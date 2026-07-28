# Private Tester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playtester that belongs to the project, plays the game, remembers every previous time it played, and tells you whether your last change helped.

**Architecture:** Hearth owns the play loop server-side. It opens the game through `@hearth/adapter-web`, screenshots each turn, asks the user's configured agent what to do next through the existing `ChatDriver` interface, and applies the answer as input. Memory is plain files in `.hearth/tester/`. The chat conversation is not involved.

**Tech Stack:** TypeScript, `@hearth/adapter-web` (Playwright/Chromium), `ChatDriver` (`apps/editor/server/chat.ts`), React, Zustand, vitest.

## Global Constraints

- No em dashes in any text added, in comments or user-visible copy.
- Must work on macOS and Windows. Use `node:path` for every path; never string-concatenate one.
- No AI attribution in commits. Plain human voice, short imperative subject, no emoji.
- Never run two concurrent vitest runs.
- Never `git add -A`. Stage the files the task names.
- Server-side changes need a dev-server restart, not HMR. Port 5173.
- No raw JSON in any user-facing surface. Typed, cohesive controls only.
- Read `docs/superpowers/specs/2026-07-27-private-tester-design.md` before starting. It is the authority; this plan implements it.
- The tester NEVER runs on its own. No schedule, no run-on-save. It plays when asked.

## Definition of done

This feature is the product's flagship. A green test suite is the floor, not the bar. It is not finished until all four of these are true, demonstrated rather than asserted:

1. **It actually works.** A real session runs against a real game in the real app and writes a real note. Not a mocked loop, not a unit test. If you cannot make a live session complete end to end, the feature is not done and you must say so plainly rather than reporting the tests green.
2. **The user can watch it.** The frame is on screen while it plays, updating, with the tester's thinking arriving beside it. A tester playing somewhere the person who asked for it cannot see is indistinguishable from nothing happening, which is the exact failure that sank the feature this replaces.
3. **It is legible without training.** Someone who has never read this plan opens the history and understands what their tester thinks about their game. No raw JSON, no verdict vocabulary they have to learn, no bare enum values rendered as-is.
4. **It looks like the rest of the app.** Quiet, restrained, ember only where it earns it. Invoke the `impeccable` skill before writing any component and follow it. A surface that looks bolted on is not done.

Browser verification is required for Tasks 5 and 6, not optional. Check `document.visibilityState` is `visible` FIRST: a hidden tab freezes rAF and IntersectionObserver, and a working reveal will look broken.

## Shared types

Every task depends on these. They live in `server/tester/types.ts`, created in Task 1.

```ts
/** One thing the tester saw, anchored to the frame it saw it on. */
export interface TesterObservation {
  /** Index into the session's frames directory. A claim with no frame is not evidence. */
  frame: number;
  text: string;
}

/** The tester's verdict on what you changed since it last played. */
export interface ChangeVerdict {
  /** What it understood you changed, in its own words. */
  seen: string;
  verdict: 'better' | 'worse' | 'no-difference' | 'first-session';
  why: string;
}

/** One session, written once at the end and never rewritten. */
export interface TesterNote {
  session: number;
  startedAt: string;
  finishedAt: string;
  onTheChange: ChangeVerdict;
  /**
   * Required, and "nothing got worse" is a choice it has to actively make.
   * An optional field here would be answered by silence every time, which is
   * how a tester becomes a flattery machine.
   */
  regression: string;
  observations: TesterObservation[];
  /** What it still could not work out. Carried into the next session. */
  openQuestions: string[];
  steps: number;
  stopped: 'done' | 'budget' | 'user' | 'error';
}
```

---

### Task 1: The memory store

**Files:**
- Create: `apps/editor/server/tester/types.ts`, `apps/editor/server/tester/memory.ts`
- Test: `apps/editor/tests/testerMemory.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TESTER_DIR`, `readMemory(root): Promise<string>`, `writeMemory(root, text): Promise<void>`, `listSessions(root): Promise<TesterNote[]>`, `nextSessionId(root): Promise<number>`, `sessionDir(root, id): string`, `writeNote(root, note): Promise<void>`. Tasks 3, 4 and 6 all use these.

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMemory, writeMemory, listSessions, nextSessionId, writeNote } from '../server/tester/memory';

let root: string;
beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tester-')); });
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

const note = (session: number) => ({
  session, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:05:00.000Z',
  onTheChange: { seen: 'the jump is higher', verdict: 'better' as const, why: 'I cleared the gap' },
  regression: 'nothing', observations: [{ frame: 3, text: 'fell in the pit' }],
  openQuestions: ['what is the red thing'], steps: 40, stopped: 'done' as const,
});

describe('tester memory', () => {
  it('reads an empty string for a project that has never been tested', async () => {
    expect(await readMemory(root)).toBe('');
  });

  it('numbers the first session 1 and counts up', async () => {
    expect(await nextSessionId(root)).toBe(1);
    await writeNote(root, note(1));
    expect(await nextSessionId(root)).toBe(2);
  });

  it('round-trips memory as text a person could hand-edit', async () => {
    await writeMemory(root, '# What I know\n\nSpace jumps.\n');
    expect(await readMemory(root)).toBe('# What I know\n\nSpace jumps.\n');
  });

  it('lists sessions oldest first so the history reads as a history', async () => {
    await writeNote(root, note(2));
    await writeNote(root, note(1));
    expect((await listSessions(root)).map((n) => n.session)).toEqual([1, 2]);
  });

  it('refuses to overwrite a session that already exists', async () => {
    // The verdict history is the product. A tester that could revise what it
    // used to think could never be caught contradicting itself.
    await writeNote(root, note(1));
    await expect(writeNote(root, note(1))).rejects.toThrow(/already/i);
  });

  it('skips an unreadable note rather than failing the whole history', async () => {
    await writeNote(root, note(1));
    await fsp.mkdir(path.join(root, '.hearth', 'tester', 'sessions', '0002'), { recursive: true });
    await fsp.writeFile(path.join(root, '.hearth', 'tester', 'sessions', '0002', 'note.json'), '{ broken');
    expect((await listSessions(root)).map((n) => n.session)).toEqual([1]);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd apps/editor && npx vitest run tests/testerMemory.test.ts`
Expected: FAIL, cannot resolve `../server/tester/memory`.

- [x] **Step 3: Implement `types.ts` and `memory.ts`**

Put the shared types above into `types.ts` verbatim. In `memory.ts`: `TESTER_DIR = path.join('.hearth', 'tester')`; sessions live at `<root>/.hearth/tester/sessions/<4-digit id>/note.json`; `memory.md` sits at `<root>/.hearth/tester/memory.md`. `writeMemory` creates parents. `writeNote` throws if the directory already exists (use `fsp.mkdir` with `recursive: false` and let `EEXIST` surface as a thrown Error mentioning "already"). `listSessions` reads the sessions directory, sorts by numeric id, and drops entries that fail to parse.

- [x] **Step 4: Run the test**

Run: `cd apps/editor && npx vitest run tests/testerMemory.test.ts`
Expected: PASS, 6 tests.

- [x] **Step 5: Commit**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
git add apps/editor/server/tester apps/editor/tests/testerMemory.test.ts
git commit -m "Add the tester memory store"
```

---

### Task 2: What changed since the tester last played

**Files:**
- Create: `apps/editor/server/tester/changes.ts`
- Test: `apps/editor/tests/testerChanges.test.ts`

**Interfaces:**
- Consumes: `TesterNote` from Task 1.
- Produces: `changesSince(root, since: string | null): Promise<string>`, returning a plain-prose summary of what the project recorded happening after the ISO timestamp `since`. Task 3 feeds this to the model.

Read `.hearth/log/commands.jsonl` (the project journal) and the chat records under `.hearth/chats/*.jsonl`. Use what the project recorded rather than a git diff: the journal carries intent, and a diff does not.

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changesSince } from '../server/tester/changes';

let root: string;
beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'changes-')); });
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

async function journal(lines: object[]): Promise<void> {
  const file = path.join(root, '.hearth', 'log', 'commands.jsonl');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
}

describe('changesSince', () => {
  it('says so plainly when nothing has been recorded', async () => {
    expect(await changesSince(root, null)).toMatch(/nothing/i);
  });

  it('keeps only entries newer than the last session', async () => {
    await journal([
      { ts: '2026-01-01T00:00:00.000Z', summary: 'raised the jump' },
      { ts: '2026-01-03T00:00:00.000Z', summary: 'added a second pit' },
    ]);
    const text = await changesSince(root, '2026-01-02T00:00:00.000Z');
    expect(text).toContain('added a second pit');
    expect(text).not.toContain('raised the jump');
  });

  it('takes everything when the tester has never played', async () => {
    await journal([{ ts: '2026-01-01T00:00:00.000Z', summary: 'raised the jump' }]);
    expect(await changesSince(root, null)).toContain('raised the jump');
  });

  it('survives a missing journal', async () => {
    expect(await changesSince(root, null)).toMatch(/nothing/i);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd apps/editor && npx vitest run tests/testerChanges.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Implement `changes.ts`**

Parse the JSONL defensively, exactly as `parseEvidenceLines` in `server/evidenceWatcher.ts` does: skip blank lines, skip lines that fail `JSON.parse`, skip entries with no usable `ts`. Filter to `ts > since` when `since` is non-null. Render as one bullet per entry. Return a sentence containing the word "nothing" when the result is empty.

- [x] **Step 4: Run the test**

Run: `cd apps/editor && npx vitest run tests/testerChanges.test.ts`
Expected: PASS, 4 tests.

- [x] **Step 5: Commit**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
git add apps/editor/server/tester/changes.ts apps/editor/tests/testerChanges.test.ts
git commit -m "Read what changed since the tester last played"
```

---

### Task 3: The play loop

**Files:**
- Create: `apps/editor/server/tester/session.ts`, `apps/editor/server/tester/prompt.ts`
- Test: `apps/editor/tests/testerSession.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: `runTesterSession(opts): Promise<TesterNote>` where `opts` is `{ root, dir, driver, maxSteps, onFrame, onThought, signal }`. `driver` is a `ChatDriver`; `dir` is the game directory. Task 4 calls this.

The loop, per the spec: open the game with `openWebGame({ dir, onFrame })`, `start()`, then repeat until the budget is spent, the tester says it is done, or `signal` aborts. Each turn: `screenshot()`, write the PNG into the session's `frames/`, send it to the driver as an attachment, read back a decision, apply it with `setActionDown` / `setActionUp` / `setAxis` / `sendPointer`, then `step()`.

`prompt.ts` owns the wording and is the sycophancy defence. Two rules it must encode:

1. The tester writes this session's observations BEFORE it is shown its own previous verdict. Order the prompts so that is structurally true, not merely requested.
2. The final prompt asks for `regression` as a required answer.

- [ ] **Step 1: Write the failing test**

Test the loop against a fake `GameUnderTest` and a fake `ChatDriver`. No browser, no model.

```ts
import { describe, it, expect, vi } from 'vitest';
import { decideFromReply, testerPrompts } from '../server/tester/prompt';

describe('decideFromReply', () => {
  it('reads a held action out of a plain reply', () => {
    expect(decideFromReply('I will hold right and jump.\nACTION: right, jump')).toEqual({
      kind: 'actions', actions: ['right', 'jump'],
    });
  });

  it('reads a pointer click, so mouse-driven games are playable', () => {
    expect(decideFromReply('CLICK: 120, 340')).toEqual({ kind: 'pointer', x: 120, y: 340, click: true });
  });

  it('stops when the tester says it is done', () => {
    expect(decideFromReply('I have seen enough.\nDONE')).toEqual({ kind: 'done' });
  });

  it('waits rather than guessing when the reply names nothing it can do', () => {
    // A reply the parser cannot read must not become a random input: the
    // session note has to reflect what the tester actually chose.
    expect(decideFromReply('Hmm, interesting.')).toEqual({ kind: 'wait' });
  });
});

describe('testerPrompts', () => {
  it('asks for this session before showing the previous verdict', () => {
    const prompts = testerPrompts({ memory: 'Space jumps.', changes: 'raised the jump', lastVerdict: 'better' });
    const observe = prompts.findIndex((p) => /what did you see/i.test(p));
    const compare = prompts.findIndex((p) => p.includes('better'));
    expect(observe).toBeGreaterThanOrEqual(0);
    expect(compare).toBeGreaterThan(observe);
  });

  it('makes the regression answer mandatory', () => {
    const prompts = testerPrompts({ memory: '', changes: '', lastVerdict: null });
    expect(prompts.join('\n')).toMatch(/anything.*worse/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/editor && npx vitest run tests/testerSession.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `prompt.ts`**

`decideFromReply(text): Decision` where `Decision` is `{kind:'actions', actions:string[]} | {kind:'pointer', x:number, y:number, click:boolean} | {kind:'done'} | {kind:'wait'}`. Parse the `ACTION:`, `CLICK:` and `DONE` markers case-insensitively; anything unrecognised is `wait`. `testerPrompts(ctx): string[]` returns the ordered prompts, observation before comparison.

- [ ] **Step 4: Implement `session.ts`**

Drive the loop as described. Honour `signal` between every turn so the stop control is responsive. On any throw, still write a note with `stopped: 'error'`: a session that crashed is still a session that happened, and losing its record is worse than recording a failure.

- [ ] **Step 5: Run the test**

Run: `cd apps/editor && npx vitest run tests/testerSession.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
git add apps/editor/server/tester apps/editor/tests/testerSession.test.ts
git commit -m "Add the tester play loop"
```

---

### Task 4: Routes and the live channel

**Files:**
- Modify: `apps/editor/server/projectServer.ts`, `apps/editor/server/ws.ts`
- Test: `apps/editor/tests/testerRoutes.test.ts`

**Interfaces:**
- Consumes: `runTesterSession` from Task 3.
- Produces: `POST /api/tester/play`, `POST /api/tester/stop`, `GET /api/tester/history`, and a `tester-thought` socket frame. Tasks 5 and 6 consume these.

Reuse `attachProbeStream(httpServer, ctx.probeBus)` for frames; it already exists and already carries base64 JPEGs from `onFrame`. Only one session may run per project at a time; a second `play` returns 409, the same shape the old sweep route used.

- [ ] **Step 1: Write the failing test** covering: play starts a session and returns 200; a second play while one runs returns 409; stop aborts a running session; history returns sessions oldest first; every route rejects a folder that is not open with 403.

- [ ] **Step 2: Run it and watch it fail.** Run: `cd apps/editor && npx vitest run tests/testerRoutes.test.ts`

- [ ] **Step 3: Implement the routes and the socket frame.**

- [ ] **Step 4: Run the test.** Expected: PASS.

- [ ] **Step 5: Restart the dev server and confirm `/api/tester/history` answers on a real project.**

- [ ] **Step 6: Commit**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
git add apps/editor/server apps/editor/tests/testerRoutes.test.ts
git commit -m "Serve the tester over routes and the live channel"
```

---

### Task 5: Watching it play

**Files:**
- Create: `apps/editor/src/components/tester/TesterStage.tsx`, `apps/editor/src/styles/app/tester.css`
- Modify: `apps/editor/src/probeStream.ts`, `apps/editor/src/components/game/ProbeStage.tsx`, `apps/editor/src/components/game/GamePane.tsx`
- Modify: `apps/editor/src/store.ts`, `apps/editor/src/api.ts`, `apps/editor/src/styles.css`, `apps/editor/src/components/game/PaneStack.tsx`
- Test: `apps/editor/tests/testerStage.test.tsx`

**Interfaces:**
- Consumes: Task 4's routes and socket frame.
- Produces: a pane that shows the game as the tester plays it with its thinking streaming beside the frame.

**START BY READING `src/probeStream.ts` AND `src/components/game/ProbeStage.tsx`.** They already do most of this and you are rewiring them, not writing them.

They were built to show a bot playing: `openProbeStream(root)` opens the viewer socket, `subscribeProbeFrames(listener)` hands out base64 JPEG frames, and `ProbeFrames` renders them onto a matte stage. The retirement that preceded this plan removed their only trigger, because the thing that used to set "something is playing" was the sweep runner and that is gone. The components themselves were deliberately left on disk for you.

So: drive them from tester state instead of sweep state, and keep the existing frame path rather than inventing a second one. `GamePane.tsx` had an `is-driven` treatment and a `ProbeNote` that were unwired at the same time; its header comment still describes the stream's client half and is a good starting point. `src/styles/app/game.css` around line 141 still carries the matte-stage styling.

What is genuinely new is the thinking column beside the frame, and the stop control.

Design: invoke the `impeccable` skill before writing the component. The frame is the subject and the thinking is secondary; the thoughts column must not out-shout the game. Quiet, restrained, no raw JSON, no em dashes. Reduced motion must be honoured. The stop control has to be reachable at all times while a session runs.

- [ ] **Step 1: Write the failing test** covering: the stage renders the latest frame; thoughts append in order; the stop control is present while running and absent when idle; nothing renders when no session has run.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement the component, the store state and the api calls.**

- [ ] **Step 4: Run the test.** Expected: PASS.

- [ ] **Step 5: Verify in the browser.** Check `document.visibilityState` is `visible` FIRST; a hidden tab freezes rAF and IntersectionObserver and will make a working reveal look broken.

- [ ] **Step 6: Commit**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
git add apps/editor/src apps/editor/tests/testerStage.test.tsx
git commit -m "Show the tester playing"
```

---

### Task 6: The history

**Files:**
- Create: `apps/editor/src/components/tester/TesterHistory.tsx`, `apps/editor/src/components/tester/testerRows.ts`
- Modify: `apps/editor/src/App.tsx`, `apps/editor/src/components/shell/Sidebar.tsx`
- Test: `apps/editor/tests/testerHistory.test.ts`

**Interfaces:**
- Consumes: `GET /api/tester/history` from Task 4, `TesterNote` from Task 1.
- Produces: the flagship surface. `testerRows.ts` is pure and holds every rule about what the history claims, so those rules are testable without a DOM.

The verdict on your last change comes first. Past verdicts stay visible beside the current one, so a reversal is legible to the reader even when the tester does not flag it: that is the third sycophancy defence and it lives here.

- [ ] **Step 1: Write the failing test** covering: the newest verdict leads; a session whose verdict contradicts the one before it is marked as a reversal; the `regression` line is always rendered, including when it says nothing got worse; an observation with no frame is not shown as evidence; an empty history reads as "has not played yet" rather than as "found nothing".

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement `testerRows.ts`, then the component.**

- [ ] **Step 4: Run the test.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
git add apps/editor/src apps/editor/tests/testerHistory.test.ts
git commit -m "Add the tester history"
```

---

### Task 7: Full verification

- [ ] **Step 1: Typecheck everything.**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine
npx tsc --noEmit -p apps/editor/tsconfig.json
for p in probe-core adapter-web probe-tools; do npx tsc --noEmit -p packages/$p/tsconfig.json; done
```

- [ ] **Step 2: Run both suites, in sequence, never at once.**

```bash
cd /Users/jakekang/projects/hearth/hearth-engine/apps/editor && npx vitest run
cd /Users/jakekang/projects/hearth/hearth-engine && npx vitest run
```

- [ ] **Step 3: End-to-end on a real game.** Open `packages/examples/mini-platformer` in the app, ask the tester to play, watch it in the pane, stop it mid-session, then confirm a note landed in `.hearth/tester/sessions/0001/` and that `memory.md` is readable prose a person could edit.

- [ ] **Step 4: Play it twice.** Change something in the game, run a second session, and confirm the verdict is about the change and that the history shows both. This is the acceptance test for the whole feature: without it, the tester is just a slow bot.

- [ ] **Step 5: Check it against the Definition of done, honestly.**

Go back to the four conditions at the top of this plan and answer each one with evidence rather than intent. Take a screenshot of the tester playing and a screenshot of the history and look at them. If a condition is not met, say which one and why, and do not describe the feature as finished. A report that says "tests pass" while a live session has never completed is a false report.

- [ ] **Step 6: Design pass.**

Invoke `impeccable` and run its `audit` command over the two new surfaces: contrast, focus states, heading order, keyboard reachability of the stop control, and behaviour at 320px through 1440px. Fix what you find. Then look at the surfaces beside the rest of the app and ask whether they read as the same product. Fix what does not.
