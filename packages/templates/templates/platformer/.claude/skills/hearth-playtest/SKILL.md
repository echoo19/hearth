---
name: hearth-playtest
description: Let the engine hunt bugs for you — bot playtesting via `hearth sweep`. Seeded bot policies (mash/idle/wander/seek) play a scene headlessly across many seeds and report softlocks, crashes, stuck states, and unmet objectives as a compact evidence report; objectives double as executable acceptance criteria; a failing seed bakes into a permanent regression playtest. Load after any gameplay change, when a bug is reported (sweep for a deterministic repro seed before debugging), and before calling a level "done".
---

# Bot playtesting: the engine plays your game

Scripted playtests (the `hearth` and `hearth-feel` skills) assert behavior you
already know to check. A **sweep** finds the behavior you *didn't* think to
check: bot policies play the scene headlessly across many seeds at full speed,
and hand you a compact report of softlocks, crashes, stuck states, and unreached
objectives. Because every run is deterministic, any failure is a perfect repro —
and you can freeze it into a permanent regression test. This is the closed loop:
**play → judge → fix → guard**.

Sweeps are read-only (no build permission). The bots produce evidence; *you*
judge it — bots don't know if a game is fun, only whether it broke or stalled.

## When to sweep

Three moments, non-negotiable:

- **After any gameplay change.** Zero setup — `mash` works on every game:
  ```bash
  hearth sweep "Level 1" --json
  ```
  Let the engine try inputs you'd never think to try before you move on.
- **When a bug is reported — sweep for a repro FIRST, then debug.** A failing
  seed is a deterministic, replayable repro; don't debug from a vague report.
  Find the seed, *then* open the systematic-debugging loop against it.
- **Before calling a level "done."** Prove the player can actually finish it:
  `seek` the exit with a `reach` objective (below). "It runs" is not "it's
  beatable."

## Policies: which bot, when

Pass one or more with `--policies` (comma-separated). `mash` and `idle` need no
setup; `wander` and `seek` steer an avatar (the sole input-reading entity, or
`--avatar <ref>`), and `seek` also needs `--target`.

| Policy | What it does | Reach for it when |
| --- | --- | --- |
| `mash` | Chaos monkey — random weighted-persistence input on every declared action. Zero config. | The default. Every sweep after a gameplay change; smoking out crashes and softlocks. |
| `idle` | No input at all. | Cutscenes, auto-play, timeouts — catch anything that breaks when the player does nothing. |
| `wander` | Curiosity-driven exploration; steers toward unvisited reachable cells. | Coverage — "is any part of this level unreachable or a trap?" |
| `seek` | Beelines an avatar to a fixed target. | Verification — "can the player *actually* get to the exit?" Pair with a `reach` objective. |

```bash
hearth sweep "Level 1" --policies mash,idle --seeds 8 --json
hearth sweep "Level 1" --policies seek --avatar Player --target exit-door --json
hearth sweep "Level 1" --policies wander --avatar Player --seeds 12 --json
```

`--target` takes an entity ref or a world point `"x,y"` (e.g. `--target 640,120`).

## Objectives: declared acceptance criteria

Objectives are pass/fail criteria the sweep evaluates per run — and they double
as executable acceptance criteria for the level. Pass `--objective` once per
criterion (repeatable), each a JSON object. `entity` defaults to the avatar.

```bash
# Can the player reach the exit within tolerance?
hearth sweep "Level 1" --policies seek --avatar Player --target exit-door \
  --objective '{"type":"reach","target":"exit-door","tolerance":24}' --json

# Does the player survive the arena for 600 frames?
hearth sweep "Arena" --policies mash \
  --objective '{"type":"survive","frames":600}' --json

# Do 5 coins get collected?
hearth sweep "Level 1" --policies wander --avatar Player \
  --objective '{"type":"event","event":"coin","count":5}' --json

# Does the player cross x = 100?
hearth sweep "Level 1" --policies seek --avatar Player --target 800,120 \
  --objective '{"type":"property","entity":"player","property":"Transform.position.x","greaterThan":100}' --json
```

The four shapes:

- `{"type":"reach","target":"exit-door","tolerance":24}` — get within `tolerance` px of a point/entity.
- `{"type":"survive","frames":600}` — the entity is alive + enabled through frame N.
- `{"type":"event","event":"coin","count":5}` — the named event fires at least `count` times.
- `{"type":"property","entity":"player","property":"Transform.position.x","greaterThan":100}` — a component path passes a comparison (`greaterThan` | `lessThan` | `equals`).

A run that meets every objective verdicts `completed`; one that definitively
misses verdicts `objective-failed`.

## Reading the report

The report `data` is a summary by design. Read three things and stop:

1. **`verdicts`** — the per-run tally. Verdicts, worst to best:
   `error` (a script crashed) > `stuck` (no novelty for `stuck-after` frames) >
   `objective-failed` > `completed` / `ran-clean` (no objectives, clean cap).
2. **`failures[]`** — up to 5 worst-first failing runs, each with `policy`,
   `seed`, `verdict`, `frame`, a one-line `detail`, and a ready-to-run `repro`
   string. This is your evidence; it's all you need to act.
3. **`repro`** — copy-paste it to replay a single failing run deterministically.

**Do not open `reportFile`** (`.hearth/sweeps/<scene>-<seq>.json`) by default —
it's full per-run detail for deep diagnosis only. The summary + repro is the
contract; reaching for the file is the exception, not the routine.

**Never pass `--heatmap` unless you're diagnosing coverage.** It adds an ASCII
grid that costs tokens; the verdict tally already tells you *whether* there's a
coverage problem. Only when `wander` reports low coverage and you need to see
*where* is the grid worth it.

## Bake: freeze a failure into a regression test

When a sweep finds a failing seed, bake it. `--bake <name>` re-runs that exact
`(policy, seed)`, records the input timeline, and writes a normal scripted
playtest with assertions derived from the objectives. `--bake` needs an explicit
scene, exactly one policy, and exactly one seed (`--seeds 1`, seed from
`--seed-start`):

```bash
# Sweep found: mash / seed 4 → error at frame 218. Freeze it.
hearth sweep "Level 1" --policies mash --seed-start 4 --seeds 1 --bake crash-seed-4 --json
```

A baked run that *failed* produces a **failing** playtest — that's the point. It
stays red until you fix the bug, then guards it forever, green. Baked tests are
ordinary playtests: they run in `hearth playtest --all` and `hearth test` like
any other. The loop closes: sweep finds it → bake it red → fix → it goes green →
it never regresses.

One nuance: a crash bakes red on its own (`assertNoErrors` fails), but a *stuck*
failure only bakes red if you pass the same `--objective` flags — the stall
itself is not asserted, the unmet objective is. Repeat the sweep's `--objective`
and `--stuck-after` flags when baking a stuck seed (the report's `bake` string
already includes them).

## Budget etiquette

Sweeps are cheap; keep them that way.

- **The default 8 seeds is right.** Don't crank `--seeds` or `--max-frames`
  without a reason — determinism means **one** failing seed is a complete repro,
  so more seeds rarely buy more signal, just tokens and wall time.
- **Extend, don't restart.** To search further, offset with `--seed-start`
  (e.g. `--seed-start 8 --seeds 8`) rather than re-running the seeds you already
  cleared.
- **Trust the summary.** Capped `failures[]`, on-disk raw detail, and the gated
  heatmap keep a sweep token-frugal — reading it the intended way (verdicts +
  failures + repro) is what keeps it that way.
