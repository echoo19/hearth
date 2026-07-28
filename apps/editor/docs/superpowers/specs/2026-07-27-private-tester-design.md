# The Private Tester

**Status:** design, approved in conversation 2026-07-27
**Replaces:** the user-facing half of bot playtesting

## Why

Bot playtesting works and is genre-bound. Four scripted policies drive a real
browser and six detectors read what happens, but only two of the four bots and
four of the six detectors survive contact with anything that is not a 2D action
game. `ProbeEntity` is `{id, x, y, alive}` with no `z`; `NavGrid` is a row-major
grid of cells; steering is typed against 4-connected `Direction`. For an RTS or
a management game what remains is crash, blank screen and nothing-is-happening,
which is a smoke test rather than playtesting.

More importantly, a scripted bot can only ever encode what someone anticipated.
It answers "is this broken". It cannot answer "did my change help", which is the
question a person actually asks after every edit.

The Private Tester answers that one. It plays the game, it remembers every
previous time it played, and its advice is about what you changed.

## What it is

A playtester that belongs to a project rather than to a conversation. Three
properties, in order of how much they matter:

1. **It remembers.** Before it plays it reads its own past notes, so it arrives
   with "last time I could not get past the second gap" and goes to check.
2. **It knows what changed.** It reads the project's own record of what happened
   since it last played, so its verdict is on your edit rather than generic.
3. **It has opinions that span sessions.** "You have raised the jump three times
   now. It is easier every time and the level has stopped being tense." No single
   playthrough produces that. Only continuity does.

Its first session is, for free, the naive first-contact session that a fresh
tester can only ever give once. It keeps that, so later it can say "you finally
fixed the thing I could not work out the first time I played".

## What it is not

- It is not a good player, and must never claim to be. Its output is "I tried
  this and failed", never an unearned claim that it finished.
- It does not replace you. Fun, feel, pacing and balance are still yours; what
  it contributes is a second pair of eyes with memory, not a verdict.
- It is not the bot fleet with a model bolted on. The policy and nav layers are
  not involved at all.

## Architecture

### The loop

Hearth owns the loop, not the chat agent. The app already drives a browser, so
the app runs the tester and calls the model itself. The conversation is not
involved and does not need to be.

```
open the game (adapter-web)
  → read memory + what changed since last session
  → repeat until budget or the tester says it is done:
        screenshot  →  model decides  →  input  →  step
  → write the session note
  → rewrite memory
```

Reuses, unchanged:

- `@hearth/adapter-web`'s `openWebGame`, which already gives `start`, `stop`,
  `step`, `setActionDown/Up`, `setAxis`, **`sendPointer`** and `screenshot`.
  `sendPointer` is why this generalises to mouse-driven genres where the bots
  could not.
- `OpenWebGameOptions.onFrame`, the existing base64-JPEG screencast, so the run
  is watchable live in the pane.
- `apps/editor/server/probeStream.ts`, which already pumps those frames to a
  viewer socket.
- `ChatDriver` (`apps/editor/server/chat.ts`), so the tester runs on whichever
  agent the user configured. It takes image attachments already. Hearth does
  not gain a second model client.

Not reused, and not touched: `packages/probe-core/src/policies/`,
`steer.ts`, `nav.ts`, `reachability.ts`, and the `wallBump` and `sealedRegion`
detectors. Those stay where they are for the passive capability.

### Memory

Lives in the project folder, as plain files, like everything else Hearth writes.
Copy the folder and the tester comes with it.

```
.hearth/tester/
  memory.md            the tester's durable model of the game
  sessions/
    0001/
      note.json        structured: verdict, confusions, what it tried
      transcript.md    what it thought, in order, human readable
      frames/          the frames its claims are anchored to
```

Two deliberate decisions:

**`memory.md` is markdown, not JSON, and the tester rewrites it each session.**
It is meant to be read by a person and corrected by hand. If your tester has
formed a wrong belief about your game, you open the file and fix it. A memory
you cannot inspect is one you cannot trust, and a tester you cannot correct is
one you stop listening to.

**Sessions are append-only and never rewritten.** The verdict history is the
product. A tester that could revise what it used to think could not be caught
contradicting itself, and being caught is the point.

### Knowing what changed

Read `.hearth/log/commands.jsonl` (the project journal, already tailed by
`journalWatcher.ts`) plus the chat records under `.hearth/chats/`, for entries
newer than the last session's timestamp. That is what the project itself
recorded happening, which is a better source than a diff: it carries intent.

## The three risks that decide whether this is real

### 1. Sycophancy is the main risk, not accuracy

A tester that says "great improvement" every time is worse than none, because it
launders bad changes as good ones. Mitigations, all structural rather than
prompt-level:

- The tester records its observations of THIS session before it is shown its own
  previous verdict. It cannot anchor on praise it has not read yet.
- The session note has a required `regression` field. Not optional, not free
  text: it must state whether anything got worse, and "nothing" is an answer it
  has to actually choose.
- Past verdicts stay visible in the UI beside the current one, so a reversal is
  legible to the reader even when the tester does not flag it.

### 2. It must not fabricate a playthrough

Every claim in a session note carries the frame index it happened on. A claim
with no frame is a claim, not evidence. This is the rule the probe code already
holds itself to and it carries over unchanged.

### 3. Cost

It burns model calls per session, on the user's own quota. Non-negotiable
requirements: a visible per-session budget, a hard step ceiling, a stop control
that works mid-session, and no automatic runs. The tester plays when asked.

## What the user sees

- **Live:** the pane shows the game as the tester plays it, with its thinking
  streaming beside the frame. The screencast infrastructure for this exists.
- **The history:** a scrollable record of every session it has played, what it
  said each time, and what changed between them. This is the flagship surface,
  not any single session.
- **The verdict on your last change**, first: better, worse, or no real
  difference, and why.

Design constraints inherited from the app: no raw JSON in any surface, typed
cohesive controls, quiet restrained voice, no em dashes in any user-visible
copy, and it must work on macOS and Windows.

## Explicitly out of scope for v1

- Automatic runs on a schedule or on save. It plays when asked.
- Any attempt to make it good at reflex-heavy games.
- Generalising `NavGrid` to 3D. Deferred until a real 3D game demands it.
- Multi-tester personas. One tester per project.

## Companion, deliberately deferred

A live tuning surface: the game declares its constants, Hearth renders real
controls, you drag and the running game responds with no agent round trip. It
dodges the cooperation problem that sank the deep playtest tier, because Hearth's
agent writes the game and the house instructions can require the declaration.
Together they are the loop game developers actually run: the tester says the jump
feels wrong, the sliders let you fix it in seconds. Not in this spec.
