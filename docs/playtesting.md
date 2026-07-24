# Playtesting Guide

Two ways to make a Hearth game prove itself headlessly. **Scripted playtests**
assert behavior you already know to check: press these keys, expect this
outcome. **Bot sweeps** find the behavior you *didn't* think to check: seeded
bot policies play a scene across many seeds and hand back a compact report of
softlocks, crashes, stuck states, and unreached objectives. Both run the same
deterministic runtime, so anything they catch is a perfect, replayable repro.

This is the human-readable mirror of the `hearth-playtest` agent skill
(`skills/hearth-playtest/SKILL.md`, scaffolded into every project under
`.claude/skills/` — see [agents.md](./agents.md#project-embedded-instructions)),
so agents and humans work from the same playbook.

## Determinism is the foundation

Everything here rests on the same guarantee: the runtime advances every system
on a fixed timestep with scripted input and seeded RNG, so the same
`(scene, seed, inputs)` replays bit-for-bit
([scripting.md](./scripting.md#determinism)). A playtest that passed once passes
again; a sweep seed that crashed crashes again, at the same frame. That is what
makes a failing bot run something you can bake into a permanent test instead of
a bug report you can't reproduce.

## Scripted playtests

A playtest is an asset: a scene, an ordered list of input/assert steps, an
optional `seed`, and a frame cap. Author one with a steps file and run it (or
all of them) headlessly.

```bash
hearth create playtest coin-pickup --scene "Level 1" --steps-file steps.json --seed 7 --json
hearth playtest coin-pickup --json         # one playtest
hearth playtest --all                      # every playtest
hearth test                                # validate + all playtests (the CI command)
```

The `--seed` makes `ctx.random` and Lua `math.random` reproducible, so a
playtest that leans on randomness still replays identically.

### Steps: input and assertions

Steps run in order. Input steps drive the game; assertion steps check state and
fail the run (exit code `1`) when they don't hold.

**Input**: `wait`, `press`, `release`, `click {x,y}`, `setAction`,
`setAxis {axis, value, frames?}`, `setPointer {x, y, down?, frames?}`,
`drag {from, to, frames?}`. See [input.md](./input.md#playtest-input) for how
each maps onto the input system.

**Assertions**: `assertEntityExists`, `assertProperty`, `assertPositionNear`,
`assertScene`, `assertParticleCount`, `assertEventCount`, `assertAudioCount`,
`assertCameraEffect`, `assertPostEffect`, `assertFocus`, `assertNoErrors`, plus
the motion asserts `assertPeak`, `assertRange`, and `assertSettledBy` that
measure *feel* — jump height, dash distance, settle time — from recorded
motion. See the [CLI guide](./cli.md#command-tour) for the full parameter
list and [game-feel.md](./game-feel.md#verifying-feel-in-playtests) for the
feel asserts in context.

A run report exposes `audioEvents`, `sceneEvents`, `finalScene`, and a
`traceSummary` per traced key, so sound, scene switching, and motion are all
checkable without opening a window. Probe with a bare run to read the observed
numbers, then tighten a loose `min` to an exact `equals`.

### `setAction`: sticky holds

`press` steps N frames then releases the action for you. That can't express one
action held *while* another is tapped — a moving jump, say. `setAction` is the
sticky sibling: it holds (`down: true`) or releases (`down: false`) an action
and leaves it there until you change it, exactly like `setAxis`.

```json
[
  { "type": "setAction", "action": "right", "down": true },
  { "type": "wait", "frames": 20 },
  { "type": "setAction", "action": "jump", "down": true, "frames": 6 },
  { "type": "setAction", "action": "jump", "down": false },
  { "type": "wait", "frames": 30 },
  { "type": "setAction", "action": "right", "down": false },
  { "type": "assertPositionNear", "entity": "Player", "x": 240, "y": 300, "tolerance": 24 },
  { "type": "assertNoErrors" }
]
```

`right` stays held across the whole run; `jump` overlaps it for six frames in
the middle. `frames` defaults to `1`; `0` applies the input without advancing,
so several `setAction`s can land on the same frame. Every action name must be
one of the project's `inputMappings` (`hearth set-input`), or the playtest is
rejected at validation with `PLAYTEST_UNKNOWN_ACTION`.

## Bot sweeps

A sweep is the engine playing your game for you. Bot policies drive a scene
headlessly across a range of seeds, at full speed, and report what broke or
stalled. Sweeps are read-only — no build permission, no mutation — and the
report is a compact summary by design.

```bash
hearth sweep "Level 1" --json                                   # mash, 8 seeds, zero setup
hearth sweep "Level 1" --policies mash,idle --seeds 8 --json
hearth sweep "Level 1" --policies seek --avatar Player --target exit-door --json
```

Scene defaults to the project's initial scene. `--seeds` runs
`seedStart..seedStart+seeds-1`; extend a prior sweep with `--seed-start` rather
than re-running seeds you already cleared.

### Policies: which bot, when

Pass one or more with `--policies` (comma-separated). `mash` and `idle` need no
setup. `wander` and `seek` steer an avatar — the sole input-reading entity, or
`--avatar <ref>` — and `seek` also needs a `--target` (an entity ref or a world
point `"x,y"`).

| Policy | What it does | Reach for it when |
| --- | --- | --- |
| `mash` | Random weighted-persistence input on every declared action. Zero config, works on every game. | The default. After any gameplay change; smoking out crashes and softlocks. |
| `idle` | No input at all. | Cutscenes, auto-play, timeouts — anything that breaks when the player does nothing. |
| `wander` | Curiosity-driven exploration; steers toward unvisited reachable cells. | Coverage — "is any part of this level unreachable or a trap?" |
| `seek` | Beelines the avatar to a fixed target. | Verification — "can the player *actually* reach the exit?" Pair with a `reach` objective. |

`wander` and `seek` derive their movement model by probing the avatar in a
throwaway session first (hold each input, measure displacement), so they steer
whatever the control scheme happens to be. An avatar with no measurable
movement fails fast with a clear error naming the actions it tried.

### Objectives: declared acceptance criteria

Objectives are pass/fail criteria the sweep evaluates per run, and they double
as executable acceptance criteria for the level. Pass `--objective` once per
criterion (repeatable), each a JSON object; `entity` defaults to the avatar.

```bash
hearth sweep "Level 1" --policies seek --avatar Player --target exit-door \
  --objective '{"type":"reach","target":"exit-door","tolerance":24}' --json
```

The four shapes:

- `{"type":"reach","target":"exit-door","tolerance":24}` — get within
  `tolerance` px of a point or entity.
- `{"type":"survive","frames":600}` — the entity stays alive and enabled
  through frame N.
- `{"type":"event","event":"coin","count":5}` — the named event fires at least
  `count` times.
- `{"type":"property","entity":"player","property":"Transform.position.x","greaterThan":100}`
  — a component path passes a comparison (`greaterThan` | `lessThan` |
  `equals`).

A run that meets every objective verdicts `completed`; one that definitively
misses verdicts `objective-failed`.

### Verdicts

Every run (one per policy × seed) gets exactly one verdict. Worst to best:

- **`error`** — a script crashed; the first error and its frame are captured.
- **`stuck`** — no novelty (a new visited cell, a new event, a scene switch)
  for `--stuck-after` frames (default 180) before the cap. A likely softlock.
- **`objective-failed`** — an objective definitively failed, or the frame cap
  arrived with objectives unmet.
- **`completed`** — every declared objective was achieved.
- **`ran-clean`** — no objectives declared, the cap was reached, no errors, not
  stuck. The best a sweep with no objectives can report.

### The report contract

The report's `data` is a summary, not a transcript. Read three things and act:

1. **`verdicts`** — the per-run tally by verdict.
2. **`failures[]`** — up to five worst-first failing runs, each with `policy`,
   `seed`, `verdict`, `frame`, a one-line `detail`, and a ready-to-run `repro`
   string (a failure that's worth freezing also carries a `bake` string).
3. **`repro`** — copy-paste it to replay a single failing run deterministically.

```jsonc
{
  "scene": "level-1", "runs": 16, "framesSimulated": 8400, "wallMs": 5200,
  "verdicts": { "ran-clean": 12, "stuck": 2, "error": 1, "completed": 0, "objective-failed": 1 },
  "objectives": [ { "summary": "reach exit-door ±24px", "successRate": 0.75,
                    "medianCompletedFrame": 342, "worstSeed": 6 } ],
  "coverage": { "cellsVisited": 84, "cellsReachable": 120, "pct": 0.70 },
  "failures": [
    { "policy": "mash", "seed": 4, "verdict": "error", "frame": 218,
      "detail": "player.lua:31: attempt to index nil ...",
      "repro": "hearth sweep level-1 --policies mash --seeds 1 --seed-start 4",
      "bake": "hearth sweep level-1 --policies mash --seed-start 4 --seeds 1 --bake crash-seed-4" }
  ],
  "reportFile": ".hearth/sweeps/level-1-0001.json"
}
```

Full per-run detail — every run, verdict frames, first-error stacks, visited
counts — is written to `.hearth/sweeps/<scene>-<seq>.json` (sequential ids, not
timestamps, so the path is deterministic). **Don't open it by default.** The
summary plus `repro` is the contract; reaching for the file is for deep
diagnosis only. The ASCII coverage heatmap is gated behind `--heatmap` for the
same reason — the verdict tally already tells you *whether* there's a coverage
problem; the grid, which costs tokens, only tells you *where*.

### The budget guard

A sweep is `policies × seeds × maxFrames` simulated frames, and that product
must stay at or under **400,000** frames — otherwise the command fails fast,
before running a single frame, with a message telling you to cut seeds,
policies, or `--max-frames`. At roughly 1–3 ms/frame headless this keeps every
sweep a seconds-scale operation. The default 8 seeds is almost always right:
because runs are deterministic, one failing seed is already a complete repro,
so more seeds rarely buy more signal.

## Bake: freeze a failure into a regression test

When a sweep finds a failing seed, bake it. `--bake <name>` re-runs that exact
`(policy, seed)`, records the input timeline, and writes an ordinary scripted
playtest — `setAction`/`setAxis`/`setPointer`/`wait` steps that reproduce the
run bit-for-bit — with assertions derived from the objectives (`reach` →
`assertPositionNear`, `survive` → `assertEntityExists`, `event` →
`assertEventCount`, `property` → `assertProperty`, always `assertNoErrors`).
Bake needs an explicit scene, exactly one policy, and exactly one seed
(`--seeds 1`, the seed from `--seed-start`):

```bash
# Sweep found: mash / seed 4 → error at frame 218. Freeze it.
hearth sweep "Level 1" --policies mash --seed-start 4 --seeds 1 --bake crash-seed-4 --json
```

A baked run that *failed* produces a **failing** playtest — that's the point. It
stays red until you fix the bug, then guards it forever, green. Baked tests are
ordinary playtests: they run in `hearth playtest --all` and `hearth test` like
any other, in CI included. The loop closes: sweep finds it → bake it red → fix →
it goes green → it never regresses.

A crash bakes red on its own (`assertNoErrors` fails). A *stuck* failure only
bakes red if the bake carries the sweep's `--objective` flags — the stall itself
is not asserted, the unmet objective is. The report's `bake` string already
repeats the sweep's `--objective` and `--stuck-after` flags for exactly this
reason.

## What sweeps don't do

Bots produce **evidence**, not judgment. A sweep can tell you a level softlocks,
a script crashes, or the exit is unreachable — objective, replayable facts. It
cannot tell you whether the game is *fun*, whether the difficulty curve feels
right, or whether a mechanic is satisfying. That read is yours (or your
agent's). Use sweeps to clear the floor — "it doesn't break, and it's
beatable" — then judge the ceiling yourself. "It runs" is not "it's good," and a
green sweep is not a finished game; the quality bar lives in
[game-feel.md](./game-feel.md#the-quality-bar) and the `hearth-design` skill.
